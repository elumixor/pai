import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { clerkConfigured, clerkEmail } from "./clerk.ts";

/**
 * Who may talk to the daemon once it is reachable from anywhere but loopback. Two ways in:
 *
 * - A browser signs in with Clerk (`clerk.ts`, the account shared with Keep) or Google (`google.ts`, a signed cookie).
 * - A program presents the shared token: `Authorization: Bearer`, `?token=`, or the cookie a
 *   link left behind. The CLI, the menu bar, the desktop app and the editor extension do this.
 *
 * The API is remote code execution, so an unauthenticated request must never reach it.
 * Loopback is exempt — the CLI and the daemon's own children talk to it that way — unless the
 * request came through the daemon's own reverse proxy, which marks what it forwards.
 */

const TOKEN_COOKIE = "pai_token";
const SESSION_COOKIE = "pai_session";
const SESSION_DAYS = 30;

/** Paths a browser must be able to load before it can present anything: the client itself, its sign-in, modules' pages. */
const PUBLIC_PATHS = [/^\/$/, /^\/_app\//, /^\/favicon\.svg$/, /^\/ui(\/|$)/, /^\/m\//, /^\/auth\//];

/** The page itself; with Google sign-in it sends a stranger to sign in rather than render. Clerk signs in inside it. */
export const isPage = (pathname: string) => pathname === "/" && !clerkConfigured();

export interface Session {
  readonly email: string;
  readonly exp: number;
}

export const tokenFromRequest = (req: Request, url: URL) =>
  req.headers.get("authorization")?.replace(/^Bearer /i, "") ??
  url.searchParams.get("token") ??
  cookie(req, TOKEN_COOKIE);

export async function authorized(req: Request, url: URL, address?: string) {
  if (!config.token && !config.google.clientId && !clerkConfigured()) return true;
  if (PUBLIC_PATHS.some((pattern) => pattern.test(url.pathname))) return true;
  if ((address === "127.0.0.1" || address === "::1") && !req.headers.has("x-forwarded-for")) return true;
  return identified(req, url);
}

/** Whether the request itself says who it is from: the token, a Google session cookie, or a Clerk session. */
export const identified = async (req: Request, url: URL) =>
  (Boolean(config.token) && tokenFromRequest(req, url) === config.token) || Boolean(sessionFromRequest(req)) || Boolean(await clerkEmail(req));

export const unauthorized = () =>
  new Response(JSON.stringify({ error: "sign in, or present the token" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

/** A token that arrived in the query is kept in a cookie, so the page's own requests carry it. */
export function rememberToken(response: Response, token: string | undefined) {
  if (token && token === config.token)
    response.headers.append("set-cookie", `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return response;
}

// --- sessions ---------------------------------------------------------------------------

export function sessionFromRequest(req: Request): Session | undefined {
  const session = verify<Session>(cookie(req, SESSION_COOKIE) ?? "");
  return session && session.exp > Date.now() ? session : undefined;
}

export function sessionCookie(email: string, req: Request) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const secure = req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sign({ email, exp })}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`;
}

export const clearSession = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

/** Where this daemon is, as the browser sees it — through the proxy when there is one. */
export function origin(req: Request, url: URL) {
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

// --- signing ----------------------------------------------------------------------------

/** A key of this daemon's own, made once; a session outlives a restart but not a new host. */
const keyPath = join(config.dbPath, "..", "session.key");
let key: Buffer | undefined;
function secret() {
  if (key) return key;
  if (!existsSync(keyPath)) {
    mkdirSync(join(keyPath, ".."), { recursive: true });
    writeFileSync(keyPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64url");
  return key;
}

export function sign(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}

export function verify<T>(signed: string): T | undefined {
  const [body, mac] = signed.split(".");
  if (!body || !mac) return undefined;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return undefined;
  }
}

const cookie = (req: Request, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];
