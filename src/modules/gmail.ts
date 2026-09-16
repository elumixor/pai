import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../core/config.ts";
import { db } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { sign, verify } from "../api/auth.ts";
import type { Module } from "./types.ts";

const log = logger("gmail");

/**
 * Read-only Gmail, for as many accounts as the user connects. claude.ai's own Gmail
 * connector holds one Google account at a time, which isn't enough for three mailboxes, so
 * this does its own OAuth: `/gmail/connect?label=<name>` sends the browser to Google with
 * `gmail.readonly`, the callback stores the refresh token under that label. Tools then read
 * one named account at a time; a session picks the label from `gmail_list_accounts`.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const STATE_COOKIE = "pai_gmail_oauth";

interface Account {
  readonly label: string;
  readonly email: string;
  readonly refreshToken: string;
}

interface Headers {
  readonly name: string;
  readonly value: string;
}

interface MessagePart {
  readonly mimeType?: string;
  readonly body?: { data?: string };
  readonly parts?: MessagePart[];
}

const configured = () => Boolean(config.google.clientId && config.google.clientSecret);

const toAccount = (row: { label: string; email: string; refresh_token: string }): Account => ({
  label: row.label,
  email: row.email,
  refreshToken: row.refresh_token,
});

export function listAccounts(): Account[] {
  return (db.query("SELECT label, email, refresh_token FROM gmail_accounts ORDER BY label").all() as { label: string; email: string; refresh_token: string }[]).map(toAccount);
}

function getAccount(label: string): Account | undefined {
  const row = db.query("SELECT label, email, refresh_token FROM gmail_accounts WHERE label = ?").get(label) as { label: string; email: string; refresh_token: string } | undefined;
  return row ? toAccount(row) : undefined;
}

function saveAccount(label: string, email: string, refreshToken: string) {
  db.prepare(
    "INSERT INTO gmail_accounts (label, email, refresh_token, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(label) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token",
  ).run(label, email, refreshToken, Date.now());
}

// --- OAuth: one consent per account, landing a refresh token under its label -------------

function callbackUrl(req: Request, url: URL) {
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}/gmail/callback`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (body: string) => new Response(`<!doctype html><body style="font-family:sans-serif;padding:2rem;max-width:32rem">${body}</body>`, { headers: { "content-type": "text/html" } });
const respondJson = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
const secure = (req: Request) => (req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "");

/** `/gmail/connect?label=x` and `/gmail/callback`; `undefined` for any other path. */
export async function handleGmailRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (path !== "/gmail/connect" && path !== "/gmail/callback") return undefined;
  if (!configured()) return respondJson({ error: "google sign-in is not configured (PAI_GOOGLE_CLIENT_ID, PAI_GOOGLE_CLIENT_SECRET)" }, 501);

  if (path === "/gmail/connect") {
    const label = (url.searchParams.get("label") ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{1,40}$/.test(label)) return respondJson({ error: "pass a short label, e.g. /gmail/connect?label=personal" }, 400);
    const state = sign({ label, nonce: crypto.randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: callbackUrl(req, url),
      response_type: "code",
      scope: SCOPE,
      state,
      access_type: "offline",
      // Forces the consent screen every time, which is the only way Google hands back a
      // refresh token on an account that already granted access to this OAuth client.
      prompt: "consent",
    });
    return redirect(`${AUTH_URL}?${params}`, { "set-cookie": `${STATE_COOKIE}=${state}; Path=/gmail; Max-Age=600; HttpOnly; SameSite=Lax${secure(req)}` });
  }

  const stateParam = url.searchParams.get("state") ?? "";
  const stored = /(?:^|;\s*)pai_gmail_oauth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  const claims = verify<{ label: string; exp: number }>(stateParam);
  if (!claims || stored !== stateParam || claims.exp < Date.now()) return page("The connection attempt expired. Go back and open the connect link again.");
  const code = url.searchParams.get("code");
  if (!code) return page(`Google did not grant access: ${escapeHtml(url.searchParams.get("error") ?? "unknown error")}.`);

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: callbackUrl(req, url), grant_type: "authorization_code" }),
  });
  if (!tokenResponse.ok) {
    log.warn(`token exchange failed: ${tokenResponse.status} ${(await tokenResponse.text()).slice(0, 200)}`);
    return page("Google's token exchange failed. Go back and try connecting again.");
  }
  const tokens = (await tokenResponse.json()) as { refresh_token?: string; access_token?: string };
  if (!tokens.refresh_token || !tokens.access_token)
    return page("Google did not return a refresh token. Revoke pai's access at https://myaccount.google.com/permissions and connect again.");

  const profile = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!profile.ok) return page("Signed in, but reading the Gmail profile failed.");
  const { emailAddress } = (await profile.json()) as { emailAddress?: string };
  if (!emailAddress) return page("Google did not return an email address.");

  saveAccount(claims.label, emailAddress, tokens.refresh_token);
  log.info(`connected ${claims.label} (${emailAddress})`);
  return page(`Connected <b>${escapeHtml(claims.label)}</b> as ${escapeHtml(emailAddress)}. You can close this tab.`);
}

// --- Gmail API, one account at a time -----------------------------------------------------

const accessTokens = new Map<string, { token: string; exp: number }>();

async function accessToken(label: string): Promise<string> {
  const cached = accessTokens.get(label);
  if (cached && cached.exp > Date.now() + 5_000) return cached.token;
  const account = getAccount(label);
  if (!account) throw new Error(`no gmail account labeled "${label}" — see gmail_list_accounts`);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: account.refreshToken, client_id: config.google.clientId, client_secret: config.google.clientSecret, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`gmail: refreshing the token for "${label}" failed — reconnect it at /gmail/connect?label=${label}`);
  const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in: number };
  accessTokens.set(label, { token: access_token, exp: Date.now() + expires_in * 1000 });
  return access_token;
}

async function call<T>(label: string, path: string): Promise<T> {
  const token = await accessToken(label);
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`gmail: ${response.status} on ${path}`);
  return (await response.json()) as T;
}

export const headerValue = (headers: Headers[] | undefined, name: string) => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** The first text/plain part, depth-first; text/html only when nothing plain exists. */
export function findPart(part: MessagePart | undefined, mimeType: string): MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

export const decodeBody = (data: string) => Buffer.from(data, "base64url").toString("utf8");

export const stripHtml = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface SearchResult {
  readonly id: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: string;
  readonly date: string;
  readonly snippet: string;
}

export async function search(label: string, query: string, limit = 10): Promise<SearchResult[]> {
  const list = await call<{ messages?: { id: string }[] }>(label, `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(Math.max(limit, 1), 50)}`);
  return Promise.all(
    (list.messages ?? []).map(async ({ id }) => {
      const message = await call<{ id: string; threadId: string; snippet: string; payload?: { headers?: Headers[] } }>(
        label,
        `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      );
      return {
        id: message.id,
        threadId: message.threadId,
        subject: headerValue(message.payload?.headers, "Subject"),
        from: headerValue(message.payload?.headers, "From"),
        date: headerValue(message.payload?.headers, "Date"),
        snippet: message.snippet,
      };
    }),
  );
}

export async function read(label: string, id: string) {
  const message = await call<{ id: string; threadId: string; payload?: MessagePart & { headers?: Headers[] } }>(label, `/messages/${id}?format=full`);
  const headers = message.payload?.headers;
  const plain = findPart(message.payload, "text/plain");
  const html = plain ? undefined : findPart(message.payload, "text/html");
  const body = plain ? decodeBody(plain.body!.data!) : html ? stripHtml(decodeBody(html.body!.data!)) : "(no readable body)";
  return {
    id: message.id,
    threadId: message.threadId,
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    date: headerValue(headers, "Date"),
    body: body.slice(0, 20_000),
  };
}

// --- the tools sessions get -----------------------------------------------------------------

export function gmailTools() {
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const accountArg = z.string().describe("account label from gmail_list_accounts");
  return createSdkMcpServer({
    name: "gmail",
    version: "1.0.0",
    tools: [
      tool("gmail_list_accounts", "The Gmail accounts pai can read, by label. To connect another, open /gmail/connect?label=<name> in a browser.", {}, async () =>
        ok(listAccounts().map(({ label, email }) => ({ label, email }))),
      ),
      tool(
        "gmail_search",
        "Search one Gmail account with Gmail's own search syntax (e.g. 'from:someone is:unread newer_than:7d'). Returns id, subject, from, date and a snippet for each match, newest first.",
        { account: accountArg, query: z.string(), limit: z.number().optional() },
        async ({ account, query, limit }) => ok(await search(account, query, limit ?? 10).catch((err: Error) => ({ error: err.message }))),
      ),
      tool(
        "gmail_read",
        "The full headers and body text of one Gmail message.",
        { account: accountArg, id: z.string().describe("message id, from gmail_search") },
        async ({ account, id }) => ok(await read(account, id).catch((err: Error) => ({ error: err.message }))),
      ),
    ],
  });
}

export const gmailModule: Module = {
  name: "gmail",
  title: "Gmail",
  description: "Reads one or more Gmail accounts, each connected with its own Google consent.",
  kind: "tools",
  enabled: configured,
  status: () => ({ configured: configured(), accounts: listAccounts().map(({ label, email }) => ({ label, email })) }),
  tools: { server: "gmail", names: ["gmail_list_accounts", "gmail_search", "gmail_read"], kinds: ["main", "task"] },
  prompt: {
    text: "Gmail: gmail_list_accounts shows which mailboxes are connected (by label — e.g. personal, work), gmail_search finds messages in one of them with Gmail's search syntax, gmail_read gets a message's full text. Ask which account when it's ambiguous rather than guessing.",
    kinds: ["main", "task"],
  },
};
