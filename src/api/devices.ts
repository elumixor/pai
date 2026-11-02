import { createHash, randomBytes } from "node:crypto";
import { config } from "../core/config.ts";
import { db } from "../core/db.ts";
import { logger } from "../core/log.ts";

const log = logger("devices");

/**
 * A phone's own credential (Paigram): minted for a signed-in person on the link page (`/#/link`), kept in the phone's
 * keychain, and presented like the daemon token (`Authorization: Bearer`, `?token=`). Each one names its device, can
 * be revoked alone, and only works while its email is still on `PAI_ALLOWED`. The database keeps a hash, never the token.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS device_tokens (
  id         TEXT PRIMARY KEY,
  hash       TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER,
  revoked_at INTEGER
);
`);

const PREFIX = "pd_";
/** Writing `last_used` on every request would be a write per call; once a minute is enough to tell what is in use. */
const TOUCH_MS = 60_000;

export interface Device {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsed: number | null;
}

interface Row {
  id: string;
  email: string;
  name: string;
  created_at: number;
  last_used: number | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const toDevice = (row: Row): Device => ({ id: row.id, email: row.email, name: row.name, createdAt: row.created_at, lastUsed: row.last_used });

export const isDeviceToken = (token: string | null | undefined): token is string => Boolean(token?.startsWith(PREFIX));

export function mintDevice(email: string, name: string) {
  const token = PREFIX + randomBytes(32).toString("base64url");
  const id = randomBytes(6).toString("hex");
  const clean = name.trim().slice(0, 80) || "device";
  db.query("INSERT INTO device_tokens (id, hash, email, name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, hash(token), email, clean, Date.now());
  log.info(`${email} linked ${clean} (${id})`);
  return { id, token };
}

/** The device a token belongs to, while it is not revoked and its person may still get in. */
export function deviceFor(token: string): Device | undefined {
  if (!isDeviceToken(token)) return undefined;
  const row = db.query<Row & { revoked_at: number | null }, [string]>("SELECT * FROM device_tokens WHERE hash = ?").get(hash(token));
  if (!row || row.revoked_at || !config.allowed.includes(row.email)) return undefined;
  const now = Date.now();
  if (!row.last_used || now - row.last_used > TOUCH_MS) db.query("UPDATE device_tokens SET last_used = ? WHERE id = ?").run(now, row.id);
  return toDevice(row);
}

export const listDevices = () =>
  db.query<Row, []>("SELECT id, email, name, created_at, last_used FROM device_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC").all().map(toDevice);

export function revokeDevice(id: string) {
  const { changes } = db.query("UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  if (changes) log.info(`revoked device ${id}`);
  return changes > 0;
}
