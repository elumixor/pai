import { readFileSync } from "node:fs";
import { type ClientHttp2Session, connect } from "node:http2";
import { bus, type PaiEvent } from "../core/bus.ts";
import { setting } from "../core/config.ts";
import { db, now } from "../core/db.ts";
import { logger } from "../core/log.ts";

/**
 * Pushes straight to the user's phones over APNs, for what does not arrive through Telegram (mail, for
 * one). A phone registers its device token at `POST /push/devices`; a bus event whose kind has a rule
 * below becomes a notification on every registered phone. Needs an APNs auth key: `PAI_APNS_KEY` (the
 * .p8 file), `PAI_APNS_KEY_ID`, `PAI_APNS_TEAM_ID`.
 */

const log = logger("push");

db.exec(`CREATE TABLE IF NOT EXISTS push_devices (
  token      TEXT PRIMARY KEY,
  bundle_id  TEXT NOT NULL,
  env        TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

export type ApnsEnv = "production" | "sandbox";
const HOSTS: Readonly<Record<ApnsEnv, string>> = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };

interface Device {
  readonly token: string;
  readonly bundleId: string;
  readonly env: ApnsEnv;
}

export function register(device: Device) {
  db.prepare("INSERT INTO push_devices (token, bundle_id, env, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET bundle_id = excluded.bundle_id, env = excluded.env").run(
    device.token,
    device.bundleId,
    device.env,
    now(),
  );
}

export const unregister = (token: string) => db.prepare("DELETE FROM push_devices WHERE token = ?").run(token).changes > 0;

const devices = () => (db.query("SELECT token, bundle_id AS bundleId, env FROM push_devices").all() as Device[]);

export interface Notification {
  readonly title: string;
  readonly body: string;
  /** Notifications with one thread id are grouped on the phone. */
  readonly thread?: string;
  /** Next to `aps`, for the app to act on a tap. */
  readonly data?: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Paigram's peer id for an email chat (namespace 4, the box's contact id), packed as Postbox packs it, so a tap opens the chat. */
const EMAIL_PEER_NAMESPACE = 4;
const emailPeerId = (contactId: unknown) => (typeof contactId === "number" ? EMAIL_PEER_NAMESPACE * 2 ** 32 + contactId : undefined);

/** Which events reach the phone, and as what. */
const RULES: Readonly<Record<string, (payload: Record<string, unknown>) => Notification>> = {
  "email.new": (p) => ({
    title: text(p.name) || text(p.address),
    body: [text(p.subject), text(p.snippet)].filter(Boolean).join("\n"),
    thread: `email:${p.contactId}`,
    data: { peerId: emailPeerId(p.contactId), email: { contactId: p.contactId, account: p.account, id: p.id } },
  }),
};

/** Apple's provider token lives an hour; renewed well before. */
const TOKEN_TTL_MS = 50 * 60_000;

class PushNotConfigured extends Error {
  constructor() {
    super("push: no APNs key (PAI_APNS_KEY, PAI_APNS_KEY_ID, PAI_APNS_TEAM_ID)");
  }
}

class ApnsError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`apns: ${status} ${reason}`);
  }
}

/** One HTTP/2 connection per APNs host and a signed provider token, both reused as Apple asks. */
class Apns {
  #jwt?: { readonly value: string; readonly at: number };
  readonly #sessions = new Map<ApnsEnv, ClientHttp2Session>();

  async #token(): Promise<string> {
    if (this.#jwt && Date.now() - this.#jwt.at < TOKEN_TTL_MS) return this.#jwt.value;
    const [path, keyId, team] = [setting("PAI_APNS_KEY"), setting("PAI_APNS_KEY_ID"), setting("PAI_APNS_TEAM_ID")];
    if (!path || !keyId || !team) throw new PushNotConfigured();
    const der = Buffer.from(readFileSync(path, "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const b64 = (bytes: string | ArrayBuffer) => Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).toString("base64url");
    const unsigned = `${b64(JSON.stringify({ alg: "ES256", kid: keyId }))}.${b64(JSON.stringify({ iss: team, iat: Math.floor(Date.now() / 1000) }))}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
    this.#jwt = { value: `${unsigned}.${b64(signature)}`, at: Date.now() };
    return this.#jwt.value;
  }

  #session(env: ApnsEnv): ClientHttp2Session {
    const open = this.#sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(HOSTS[env]);
    session.on("error", (err) => log.warn(`apns ${env}: ${err.message}`));
    session.on("close", () => this.#sessions.delete(env));
    this.#sessions.set(env, session);
    return session;
  }

  async send(device: Device, n: Notification): Promise<void> {
    const token = await this.#token();
    const payload = JSON.stringify({ aps: { alert: { title: n.title, body: n.body }, sound: "default", ...(n.thread ? { "thread-id": n.thread } : {}) }, ...n.data });
    const request = this.#session(device.env).request({
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization: `bearer ${token}`,
      "apns-topic": device.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    await new Promise<void>((resolve, reject) => {
      let status = 0;
      let body = "";
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => (status === 200 ? resolve() : reject(new ApnsError(status, text((JSON.parse(body || "{}") as { reason?: unknown }).reason)))));
      request.on("error", reject);
      request.end(payload);
    });
  }

  close() {
    for (const session of this.#sessions.values()) session.close();
  }
}

const apns = new Apns();

/** Tokens Apple says are gone, never to come back. */
const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** Sends to every registered phone; a token Apple disowns is dropped. Answers how many took it. */
export async function notify(n: Notification): Promise<number> {
  let delivered = 0;
  for (const device of devices()) {
    try {
      await apns.send(device, n);
      delivered++;
    } catch (err) {
      if (err instanceof ApnsError && GONE.has(err.reason)) unregister(device.token);
      log.warn(`${device.token.slice(0, 8)}…: ${(err as Error).message}`);
    }
  }
  return delivered;
}

export function start() {
  const handler = (e: PaiEvent) => {
    const rule = RULES[e.kind];
    if (rule) void notify(rule(e.payload)).catch((err: Error) => log.warn(err.message));
  };
  bus.on("event", handler);
  return () => {
    bus.off("event", handler);
    apns.close();
  };
}
