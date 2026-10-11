import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../core/config.ts";
import { cursors, db } from "../core/db.ts";
import { bus } from "../core/bus.ts";
import * as messages from "../domain/messages.ts";
import * as tasks from "../domain/tasks.ts";
import { put as archive } from "../domain/recall.ts";
import { logger } from "../core/log.ts";
import { origin, sign } from "../api/auth.ts";
import type { Module } from "./types.ts";

const log = logger("gmail");

/**
 * Gmail for as many accounts as the user connects. claude.ai's own Gmail
 * connector holds one Google account at a time, which isn't enough for three mailboxes, so
 * this does its own OAuth: `/gmail/connect?label=<name>` names the address that label already
 * speaks as, then sends the browser to Google, and the sign-in callback (`/auth/google/callback`, the one redirect URI
 * the OAuth client knows) hands the code to `finishConnect`, which stores the refresh token
 * under that label together with the scopes Google granted. Tools then work one named account at a
 * time; a session picks the label from `gmail_list_accounts`.
 *
 * Mail only: the calendar is Balance's, and no account holds a calendar scope any more.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const GMAIL = "https://www.googleapis.com/auth/gmail.";
const READ = `${GMAIL}readonly`;
const SEND = `${GMAIL}send`;
const MODIFY = `${GMAIL}modify`;

/**
 * Everything this module will ever ask a mailbox for, asked at the first consent. A grant is frozen
 * at consent time, so a scope added later cannot be used by an account connected before it: widening
 * this list means asking the user to reconnect every mailbox, and the mailbox it is asked for while
 * he is away is the one that fails mid-task. `modify` (marking read, labelling, archiving) is in here
 * for that reason alone — nothing calls it yet.
 */
const REQUESTED = [READ, SEND, MODIFY];

/** What the tools here need. A mailbox short of one of these is a visible need, not a 403 mid-send. */
const REQUIRED: readonly { readonly scope: string; readonly what: string }[] = [
  { scope: READ, what: "read mail" },
  { scope: SEND, what: "send mail" },
];

/** A broader scope covers a narrower one: Google grants reading through `modify` too. */
const IMPLIED_BY: Record<string, readonly string[]> = { [READ]: [MODIFY] };

const granted = (scopes: readonly string[], scope: string) => scopes.includes(scope) || (IMPLIED_BY[scope] ?? []).some((s) => scopes.includes(s));

/** What a mailbox cannot do, in the words the user needs to act on it; empty = whole. */
export const shortfall = (scopes: readonly string[]): string[] => (scopes.length === 0 ? [] : REQUIRED.filter((r) => !granted(scopes, r.scope)).map((r) => r.what));

interface Account {
  readonly label: string;
  readonly email: string;
  readonly refreshToken: string;
  /** What Google granted, learned at consent and re-read on every token refresh; empty until one happens. */
  readonly scopes: readonly string[];
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

interface Row {
  readonly label: string;
  readonly email: string;
  readonly refresh_token: string;
  readonly scopes: string;
}

const COLUMNS = "label, email, refresh_token, scopes";

const toAccount = (row: Row): Account => ({
  label: row.label,
  email: row.email,
  refreshToken: row.refresh_token,
  scopes: row.scopes.split(" ").filter(Boolean),
});

export function listAccounts(): Account[] {
  return (db.query(`SELECT ${COLUMNS} FROM gmail_accounts ORDER BY label`).all() as Row[]).map(toAccount);
}

function getAccount(label: string): Account | undefined {
  const row = db.query(`SELECT ${COLUMNS} FROM gmail_accounts WHERE label = ?`).get(label) as Row | undefined;
  return row ? toAccount(row) : undefined;
}

function saveAccount(label: string, email: string, refreshToken: string, scopes: string) {
  db.prepare(
    "INSERT INTO gmail_accounts (label, email, refresh_token, scopes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(label) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, scopes = excluded.scopes",
  ).run(label, email, refreshToken, scopes, Date.now());
}

/** The grant as the token endpoint last reported it: it is Google's answer, so it cannot drift. */
function saveScopes(label: string, scopes: string) {
  db.prepare("UPDATE gmail_accounts SET scopes = ? WHERE label = ?").run(scopes, label);
}

// --- OAuth: one consent per account, landing a refresh token under its label -------------

const callbackUrl = (req: Request, url: URL) => `${origin(req, url)}/auth/google/callback`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (body: string, status = 200) =>
  new Response(`<!doctype html><body style="font-family:sans-serif;padding:2rem;max-width:32rem">${body}</body>`, { status, headers: { "content-type": "text/html" } });
const respondJson = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
const secure = (req: Request) => (req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "");

/** The state cookie name and path are the sign-in flow's: the callback that reads them is shared. */
export const STATE_COOKIE = "pai_oauth";

/** The mapping as it stands, so a connect page says which address each label speaks as. */
const mappingHtml = (label: string) => {
  const rows = listAccounts().map(({ label: l, email }) => `<li>${l === label ? "<b>" : ""}${escapeHtml(l)} → ${escapeHtml(email)}${l === label ? "</b>" : ""}</li>`);
  return rows.length ? `<p>Connected mailboxes:</p><ul>${rows.join("")}</ul>` : "<p>No mailbox is connected yet.</p>";
};

/**
 * `/gmail/connect?label=x`: the mapping first, Google second. The label is what every tool names a
 * mailbox by, and the consent screen signs in whichever Google account the browser happens to hold —
 * which is how `atmagaming` came to be a personal address and a company mail went out as him. So the
 * page says which address this label speaks as before anything is overwritten, and `confirm=1` is the
 * click that goes on.
 */
export function handleConnect(req: Request, url: URL): Response {
  if (!configured()) return respondJson({ error: "google sign-in is not configured (PAI_GOOGLE_CLIENT_ID, PAI_GOOGLE_CLIENT_SECRET)" }, 501);
  const label = (url.searchParams.get("label") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(label)) return respondJson({ error: "pass a short label, e.g. /gmail/connect?label=personal" }, 400);
  const existing = getAccount(label);
  const allow = (url.searchParams.get("allow") ?? "").trim().toLowerCase();
  if (url.searchParams.get("confirm") !== "1") {
    const what = existing
      ? allow && allow !== existing.email
        ? `You are about to make <b>${escapeHtml(label)}</b> speak as <b>${escapeHtml(allow)}</b> instead of ${escapeHtml(existing.email)}.`
        : `<b>${escapeHtml(label)}</b> is ${escapeHtml(existing.email)}. Sign in as that account — any other one is refused.`
      : `<b>${escapeHtml(label)}</b> is new: whichever Google account you sign in as becomes this mailbox.`;
    const go = `/gmail/connect?label=${encodeURIComponent(label)}&confirm=1${allow ? `&allow=${encodeURIComponent(allow)}` : ""}`;
    return page(`<h3>Connect a mailbox</h3><p>${what}</p>${mappingHtml(label)}<p><a href="${escapeHtml(go)}">Continue to Google</a></p>`);
  }
  const state = sign({ gmail: label, allow: allow || undefined, next: "/ui/", nonce: crypto.randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: callbackUrl(req, url),
    response_type: "code",
    scope: REQUESTED.join(" "),
    state,
    access_type: "offline",
    // Forces the consent screen every time, which is the only way Google hands back a
    // refresh token on an account that already granted access to this OAuth client.
    // `select_account` with it: the chooser is shown rather than whoever the browser holds.
    prompt: "consent select_account",
    include_granted_scopes: "true",
    ...(existing ? { login_hint: allow || existing.email } : {}),
  });
  return new Response(null, {
    status: 302,
    headers: { location: `${AUTH_URL}?${params}`, "set-cookie": `${STATE_COOKIE}=${state}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax${secure(req)}` },
  });
}

/** The sign-in callback's second half: a code that came back for a mailbox rather than a login. */
export async function finishConnect(req: Request, url: URL, label: string, allow?: string): Promise<Response> {
  const code = url.searchParams.get("code");
  const refusal = url.searchParams.get("error");
  if (!code) {
    const why =
      refusal === "access_denied"
        ? ` The OAuth app is in testing mode, so Google only lets its listed testers in: add this Google account under <b>Audience → Test users</b> at <a href="https://console.cloud.google.com/auth/audience?project=${escapeHtml(config.google.clientId.split("-")[0] ?? "")}">console.cloud.google.com/auth/audience</a> (or publish the app), then connect again.`
        : "";
    return page(`Google did not grant access: ${escapeHtml(refusal ?? "unknown error")}.${why}`, 400);
  }

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: callbackUrl(req, url), grant_type: "authorization_code" }),
  });
  if (!tokenResponse.ok) {
    log.warn(`token exchange failed: ${tokenResponse.status} ${(await tokenResponse.text()).slice(0, 200)}`);
    return page("Google's token exchange failed. Go back and try connecting again.", 502);
  }
  const tokens = (await tokenResponse.json()) as { refresh_token?: string; access_token?: string; scope?: string };
  if (!tokens.refresh_token || !tokens.access_token)
    return page("Google did not return a refresh token. Revoke pai's access at https://myaccount.google.com/permissions and connect again.", 502);

  const profile = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!profile.ok) return page("Signed in, but reading the Gmail profile failed. Is the Gmail API enabled for this OAuth client's project?", 502);
  const { emailAddress } = (await profile.json()) as { emailAddress?: string };
  if (!emailAddress) return page("Google did not return an email address.", 502);

  // The address a label speaks as is not a detail the browser's signed-in account gets to change by
  // accident: nothing is stored until the user says, on the retry link, that this is the new address.
  const existing = getAccount(label);
  if (existing && existing.email !== emailAddress && allow?.toLowerCase() !== emailAddress.toLowerCase()) {
    const retry = `/gmail/connect?label=${encodeURIComponent(label)}&allow=${encodeURIComponent(emailAddress)}`;
    log.warn(`refused to connect ${label} as ${emailAddress}: it is ${existing.email}`);
    return page(
      `<h3>Nothing was changed</h3><p><b>${escapeHtml(label)}</b> is ${escapeHtml(existing.email)}, but you consented as <b>${escapeHtml(emailAddress)}</b>. Mail sent as this label would have gone out from the wrong address, so the mailbox is untouched.</p>` +
        `<p>Sign in as ${escapeHtml(existing.email)} and <a href="/gmail/connect?label=${encodeURIComponent(label)}">connect again</a> — or, if ${escapeHtml(label)} really is ${escapeHtml(emailAddress)} now, <a href="${escapeHtml(retry)}">change it on purpose</a>.</p>`,
      409,
    );
  }

  const scopes = tokens.scope ?? "";
  saveAccount(label, emailAddress, tokens.refresh_token, scopes);
  accessTokens.delete(label);
  resolveNeed(label);
  const missing = shortfall(scopes.split(" ").filter(Boolean));
  if (missing.length) raiseNeed(label, emailAddress, `cannot ${missing.join(" or ")}`);
  log.info(`connected ${label} (${emailAddress})${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  return page(
    `Connected <b>${escapeHtml(label)}</b> as ${escapeHtml(emailAddress)}.` +
      (missing.length ? ` Google did not grant permission to ${escapeHtml(missing.join(" or "))} — connect again and leave every box ticked.` : "") +
      " You can close this tab.",
  );
}

export function removeAccount(label: string) {
  accessTokens.delete(label);
  return db.prepare("DELETE FROM gmail_accounts WHERE label = ?").run(label).changes > 0;
}

// --- Gmail API, one account at a time -----------------------------------------------------

const accessTokens = new Map<string, { token: string; exp: number }>();

/** The refresh token is dead: only the user can fix it, by consenting again. */
export class GmailAuthError extends Error {
  constructor(readonly label: string, why: string) {
    super(`gmail: the Google grant for "${label}" is no longer valid (${why}) — reconnect it at ${connectUrl(label)}`);
  }
}

/**
 * One access token from the refresh token, and the grant Google reports with it. The refresh answer
 * carries `scope`, so every refresh re-reads what this mailbox may do and the stored copy can never
 * be a guess. `invalid_grant` is the 7-day expiry of an OAuth app in Testing, a revoked grant or a
 * password change: it becomes a need the user can act on, not a line in the log.
 */
async function refresh(account: Account): Promise<{ token: string; expiresIn: number; scopes: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: account.refreshToken, client_id: config.google.clientId, client_secret: config.google.clientSecret, grant_type: "refresh_token" }),
  });
  const body = await response.text();
  if (!response.ok) {
    const error = (() => {
      try {
        return (JSON.parse(body) as { error?: string; error_description?: string }).error ?? `http ${response.status}`;
      } catch {
        return `http ${response.status}`;
      }
    })();
    if (error === "invalid_grant") {
      raiseNeed(account.label, account.email, "its Google grant expired or was revoked");
      throw new GmailAuthError(account.label, error);
    }
    throw new Error(`gmail: refreshing the token for "${account.label}" failed (${error})`);
  }
  const { access_token, expires_in, scope } = JSON.parse(body) as { access_token: string; expires_in: number; scope?: string };
  if (scope !== undefined && scope !== account.scopes.join(" ")) saveScopes(account.label, scope);
  return { token: access_token, expiresIn: expires_in, scopes: scope ?? account.scopes.join(" ") };
}

async function accessToken(label: string): Promise<string> {
  const cached = accessTokens.get(label);
  if (cached && cached.exp > Date.now() + 5_000) return cached.token;
  const account = getAccount(label);
  if (!account) throw new Error(`no gmail account labeled "${label}" — see gmail_list_accounts`);
  const { token, expiresIn } = await refresh(account);
  accessTokens.set(label, { token, exp: Date.now() + expiresIn * 1000 });
  return token;
}

/**
 * Every mailbox asked, at start and daily: is its grant still alive, and does it still cover what the
 * tools need? Both answers come from one refresh call, so this is what turns "the mailbox cannot send"
 * from a 403 in the middle of a send into a task before anything is drafted.
 */
export async function checkAccounts(): Promise<{ label: string; email: string; problem?: string }[]> {
  const checked = [];
  for (const account of listAccounts()) {
    try {
      const { scopes } = await refresh(account);
      const missing = shortfall(scopes.split(" ").filter(Boolean));
      if (missing.length) raiseNeed(account.label, account.email, `cannot ${missing.join(" or ")} — it was connected before pai asked for that permission`);
      else resolveNeed(account.label);
      checked.push({ label: account.label, email: account.email, problem: missing.length ? `cannot ${missing.join(" or ")}` : undefined });
    } catch (err) {
      checked.push({ label: account.label, email: account.email, problem: (err as Error).message });
    }
  }
  return checked;
}

// --- needs: a mailbox the user has to reconnect, on his list rather than in the log --------

const needTitle = (label: string) => `Reconnect the "${label}" mailbox`;

const connectUrl = (label: string) => `${config.baseUrl}/gmail/connect?label=${encodeURIComponent(label)}`;

/** One task per mailbox, its reason kept current: raised again every pass, never duplicated. */
function raiseNeed(label: string, email: string, why: string) {
  const nextAction = `Open ${connectUrl(label)} and consent as ${email}`;
  const notes = `${email} ${why}. A Google grant is frozen at consent time, so only reconnecting the mailbox changes it.`;
  const open = tasks.list({ open: true }).find((t) => t.title === needTitle(label));
  if (open) {
    if (open.notes !== notes || open.nextAction !== nextAction) tasks.update(open.id, { notes, nextAction, status: "waiting_user" });
    return;
  }
  const task = tasks.add({ title: needTitle(label), status: "waiting_user", createdBy: "gmail", nextAction, notes });
  log.warn(`${label}: ${why} — task #${task.id}`);
  bus.emitEvent("gmail.reconnect", { account: label, email, why, task: task.id, link: connectUrl(label) });
}

/** The mailbox answers again: its own task closes itself. */
function resolveNeed(label: string) {
  const open = tasks.list({ open: true }).find((t) => t.title === needTitle(label));
  if (open) tasks.update(open.id, { status: "done", nextAction: "" });
}

async function call<T>(label: string, path: string): Promise<T> {
  const token = await accessToken(label);
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`gmail: ${response.status} on ${path}`);
  return (await response.json()) as T;
}

/** The scope an account was connected with is fixed; Google answers 403 until the user consents again. */
export class GmailScopeError extends Error {
  constructor(label: string, what: string) {
    super(`"${label}" was connected without permission to ${what} — reconnect it at ${connectUrl(label)}`);
  }
}

async function post<T>(label: string, path: string, payload: unknown): Promise<T> {
  const token = await accessToken(label);
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 403) throw new GmailScopeError(label, "send mail");
  if (!response.ok) throw new Error(`gmail: ${response.status} on ${path} — ${(await response.text()).slice(0, 300)}`);
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

const codePoint = (digits: string, radix: number) => {
  const value = Number.parseInt(digits, radix);
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
};

export const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith("#x")) return codePoint(key.slice(2), 16) || whole;
    if (key.startsWith("#")) return codePoint(key.slice(1), 10) || whole;
    return ENTITIES[key] ?? whole;
  });

/** Tags that separate text: their boundaries become line breaks, so the result keeps the message's shape. */
const BLOCK_TAGS = /<\/?(?:p|div|br|tr|li|ul|ol|table|h[1-6]|blockquote|section|article|header|footer|hr|pre)\b[^>]*>/gi;

/** A link as readable text: the anchor's words, then the target, so a url that exists only in the markup survives. */
const anchor = (href: string, inner: string) => {
  const url = decodeEntities(href).trim();
  const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (!url || url.startsWith("#") || url.toLowerCase().startsWith("javascript:")) return ` ${text} `;
  if (!text || url.includes(text)) return ` ${url} `;
  return ` ${text} (${url}) `;
};

/**
 * An HTML mail part as text that keeps its links. The plain-text alternative a sender provides is
 * often a stub, and a booking or confirmation url can exist only in the HTML part, so every anchor
 * is rendered as its words followed by its target rather than dropped with the tag.
 */
export const htmlToText = (html: string) =>
  decodeEntities(
    html
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => anchor(href, inner))
      .replace(/<a\b[^>]*\bhref\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => anchor(href, inner))
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
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

/** How much of a body one `gmail_read` returns when the caller does not say. */
const BODY_WINDOW = 20_000;

export interface ReadResult {
  readonly id: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly date: string;
  readonly body: string;
  /** Characters in the whole body, so a caller knows what it has not seen. */
  readonly length: number;
  readonly offset: number;
  /** More body after this window: read on with `offset` = `offset` + the body's length. */
  readonly truncated: boolean;
}

/**
 * One message as text, a window at a time. The HTML part wins when there is one: its anchors carry
 * urls that the sender's plain-text alternative often leaves out entirely.
 */
export async function read(label: string, id: string, offset = 0, limit = BODY_WINDOW): Promise<ReadResult> {
  const message = await call<{ id: string; threadId: string; payload?: MessagePart & { headers?: Headers[] } }>(label, `/messages/${id}?format=full`);
  const headers = message.payload?.headers;
  const html = findPart(message.payload, "text/html");
  const plain = findPart(message.payload, "text/plain");
  const full = html ? htmlToText(decodeBody(html.body!.data!)) : plain ? decodeBody(plain.body!.data!) : "(no readable body)";
  const from = Math.max(0, Math.min(Math.trunc(offset), full.length));
  const window = Math.max(1, Math.trunc(limit));
  const body = full.slice(from, from + window);
  return {
    id: message.id,
    threadId: message.threadId,
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    date: headerValue(headers, "Date"),
    body,
    length: full.length,
    offset: from,
    truncated: from + body.length < full.length,
  };
}

// --- watchers: new mail and meetings coming up, as bus events ------------------------------

/** How often the mailboxes are looked at: one list call per account, nothing more when nothing is new. */
const MAIL_EVERY = 5 * 60_000;
/** A meeting is announced this long before it starts. */
const UPCOMING_MS = 30 * 60_000;

interface ListedMessage {
  readonly id: string;
  readonly threadId: string;
}

/**
 * New messages in one inbox since the last look, oldest first. The cursor is the newest
 * internalDate seen; the first look only sets it, so connecting a mailbox does not replay it.
 */
// --- sending ------------------------------------------------------------------------------

export interface SendInput {
  /** One address or several, comma-separated, as a mail client would take them. */
  readonly to: string;
  readonly subject: string;
  /** Plain text; sent as UTF-8, base64 encoded, so long lines and non-ASCII survive. */
  readonly body: string;
  readonly cc?: string;
  /** The message being answered: its thread, subject and Message-ID are carried over. */
  readonly replyTo?: string;
}

/** A header value Google will accept: anything beyond ASCII goes as an RFC 2047 encoded word. */
export const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** The message as RFC 2822 text. Pure, so what goes on the wire can be read in a test. */
export function mimeMessage(from: string, input: Readonly<SendInput>, reply?: Readonly<{ messageId: string; references: string }>): string {
  const headers = [
    `From: ${from}`,
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(reply?.messageId ? [`In-Reply-To: ${reply.messageId}`, `References: ${reply.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  // Base64 in 76-character lines, as the transfer encoding requires.
  const body = (Buffer.from(input.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** What a reply has to carry so Gmail hangs it under the original instead of starting a thread. */
async function replyContext(label: string, id: string) {
  const original = await call<{ threadId: string; payload?: { headers?: Headers[] } }>(label, `/messages/${id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
  const messageId = headerValue(original.payload?.headers, "Message-ID");
  const references = [headerValue(original.payload?.headers, "References"), messageId].filter(Boolean).join(" ");
  const subject = headerValue(original.payload?.headers, "Subject");
  return { threadId: original.threadId, messageId, references, subject };
}

/**
 * Sends as the account itself — the one thing here the user cannot undo, so a session must have
 * the user's approval (`check_outbound`) before it calls this. What went out is logged against the
 * agent that sent it and archived, so `recall` finds it later.
 */
export async function send(label: string, input: Readonly<SendInput>, by?: string) {
  const account = getAccount(label);
  if (!account) throw new Error(`no gmail account labeled "${label}" — see gmail_list_accounts`);
  // The grant is known before anything is composed: a mailbox connected without `gmail.send` is told
  // so here rather than by Google's 403 after the text was written and approved.
  if (shortfall(account.scopes).includes("send mail")) {
    raiseNeed(label, account.email, "cannot send mail — it was connected before pai asked for that permission");
    throw new GmailScopeError(label, "send mail");
  }
  if (!input.to.trim()) throw new Error("gmail_send needs a recipient");
  if (!input.body.trim()) throw new Error("gmail_send needs a body");
  const reply = input.replyTo ? await replyContext(label, input.replyTo) : undefined;
  // A reply keeps the original subject unless the caller wrote one.
  const subject = input.subject.trim() || (reply ? (reply.subject.startsWith("Re:") ? reply.subject : `Re: ${reply.subject}`) : "");
  if (!subject) throw new Error("gmail_send needs a subject");
  const raw = Buffer.from(mimeMessage(account.email, { ...input, subject }, reply), "utf8").toString("base64url");
  const sent = await post<{ id?: string; threadId?: string }>(label, "/messages/send", { raw, ...(reply ? { threadId: reply.threadId } : {}) });
  // Gmail answers with the id it filed the message under. A 2xx without one is not a send,
  // and reporting it as one is how a tool comes to claim something that never happened.
  if (!sent.id || !sent.threadId) throw new Error(`gmail: ${label} accepted the message but returned no id — it was not sent. Check the Sent folder of ${account.email} before sending again.`);
  const link = `https://mail.google.com/mail/u/${account.email}/#sent/${sent.threadId}`;
  messages.event(by ?? "pai", "sent", `email from ${account.email} to ${input.to}: ${subject}`, { meta: { link } });
  archive("mail", sent.id, `${account.email} → ${input.to} — ${subject}`, input.body);
  log.info(`${label}: sent to ${input.to}`);
  return { id: sent.id, threadId: sent.threadId, from: account.email, to: input.to, subject, link };
}

export async function newMail(label: string): Promise<{ id: string; threadId: string; from: string; subject: string; snippet: string; at: number }[]> {
  const key = `gmail:${label}`;
  const since = Number(cursors.get(key) ?? 0);
  const list = await call<{ messages?: ListedMessage[] }>(label, `/messages?q=${encodeURIComponent("in:inbox newer_than:2d")}&maxResults=25`);
  const found = [];
  let newest = since;
  for (const { id } of list.messages ?? []) {
    const m = await call<{ id: string; threadId: string; snippet: string; internalDate: string; payload?: { headers?: Headers[] } }>(label, `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
    const at = Number(m.internalDate);
    newest = Math.max(newest, at);
    // Messages come newest first: everything at or before the cursor was seen.
    if (at <= since) break;
    found.push({ id: m.id, threadId: m.threadId, from: headerValue(m.payload?.headers, "From"), subject: headerValue(m.payload?.headers, "Subject"), snippet: m.snippet, at });
  }
  cursors.set(key, String(newest || Date.now()));
  return since ? found.reverse() : [];
}

interface CalendarEvent {
  readonly id: string;
  readonly summary?: string;
  readonly description?: string;
  readonly htmlLink?: string;
  readonly start?: { dateTime?: string };
  readonly attendees?: { email: string; self?: boolean }[];
  readonly status?: string;
}

/** Meetings starting within the next half hour that were not announced yet. */
export async function upcoming(label: string): Promise<CalendarEvent[]> {
  const token = await accessToken(label);
  const from = new Date().toISOString();
  const to = new Date(Date.now() + UPCOMING_MS).toISOString();
  const response = await fetch(`${CALENDAR_API}/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${from}&timeMax=${to}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 403) throw new CalendarScopeError(label);
  if (!response.ok) throw new Error(`calendar: ${response.status}`);
  const events = ((await response.json()) as { items?: CalendarEvent[] }).items ?? [];
  const key = `calendar:${label}`;
  const announced = new Set((cursors.get(key) ?? "").split(",").filter(Boolean));
  const fresh = events.filter((e) => e.status !== "cancelled" && e.start?.dateTime && !announced.has(e.id));
  cursors.set(key, [...announced, ...fresh.map((e) => e.id)].slice(-200).join(","));
  return fresh;
}

class CalendarScopeError extends Error {
  constructor(label: string) {
    super(`${label} has no calendar access (the calendar is Balance's)`);
  }
}

/** Polls every connected mailbox and calendar; each new thing becomes a bus event. */
export function startWatch(emit: (kind: string, payload: Record<string, unknown>) => void) {
  const noCalendar = new Set<string>();
  const pass = async () => {
    for (const { label, email } of listAccounts()) {
      try {
        for (const m of await newMail(label)) {
          emit("gmail.new", { account: label, email, id: m.id, threadId: m.threadId, from: m.from, subject: m.subject, snippet: m.snippet, link: `https://mail.google.com/mail/u/${email}/#inbox/${m.threadId}` });
          archive("mail", m.id, `${m.from} — ${m.subject}`, m.snippet, m.at);
        }
      } catch (err) {
        log.warn(`${label}: ${(err as Error).message}`);
      }
      if (noCalendar.has(label)) continue;
      try {
        for (const e of await upcoming(label)) {
          const attendees = (e.attendees ?? []).filter((a) => !a.self).map((a) => a.email);
          emit("calendar.upcoming", { account: label, id: e.id, summary: e.summary ?? "", start: e.start?.dateTime, attendees, description: (e.description ?? "").slice(0, 1000), link: e.htmlLink });
          archive("calendar", e.id, e.summary ?? "meeting", `${e.start?.dateTime} with ${attendees.join(", ")}\n${e.description ?? ""}`, Date.now());
        }
      } catch (err) {
        if (err instanceof CalendarScopeError) noCalendar.add(label);
        log.warn(`${label} calendar: ${(err as Error).message}`);
      }
    }
  };
  const first = setTimeout(pass, 20_000);
  const timer = setInterval(pass, MAIL_EVERY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// --- the tools sessions get -----------------------------------------------------------------

export function gmailTools(by?: string) {
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
        "The headers and body text of one Gmail message, links included: an anchor comes back as its words followed by its url, so a booking or confirmation link that only exists in the HTML part is readable. Long bodies come in windows — when `truncated` is true, call again with `offset` past what you have.",
        {
          account: accountArg,
          id: z.string().describe("message id, from gmail_search"),
          offset: z.number().int().min(0).optional().describe("characters to skip, to read on after a truncated body"),
          limit: z.number().int().min(1).max(100_000).optional().describe("characters to return (default 20000)"),
        },
        async ({ account, id, offset, limit }) => ok(await read(account, id, offset, limit).catch((err: Error) => ({ error: err.message }))),
      ),
      tool(
        "gmail_send",
        "Sends an email as that mailbox — it leaves immediately and cannot be taken back, so get the user's approval (check_outbound, then ask_user with the final text) before calling it. Pass reply_to_message_id to answer a message in its own thread; the subject is then optional.",
        {
          account: accountArg,
          to: z.string().describe("one address, or several comma-separated"),
          subject: z.string().describe("optional only when replying"),
          body: z.string().describe("plain text"),
          cc: z.string().optional(),
          reply_to_message_id: z.string().optional().describe("message id from gmail_search: sends as a reply in that thread"),
        },
        async ({ account, to, subject, body, cc, reply_to_message_id }) =>
          ok(await send(account, { to, subject, body, cc, replyTo: reply_to_message_id }, by).catch((err: Error) => ({ error: err.message }))),
      ),
    ],
  });
}

/** Once a day is enough for a 7-day expiry, and one refresh call per mailbox costs nothing. */
const CHECK_EVERY = 24 * 3600_000;

let stopWatch: (() => void) | undefined;
let stopCheck: (() => void) | undefined;

/** The grant check at start and daily; a failure here is a need, so nothing is thrown away. */
function startCheck() {
  const pass = () => void checkAccounts().catch((err: Error) => log.warn(`grant check: ${err.message}`));
  const first = setTimeout(pass, 10_000);
  const timer = setInterval(pass, CHECK_EVERY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export const gmailModule: Module = {
  name: "gmail",
  title: "Gmail",
  description: "Reads one or more Gmail accounts and sends as them, each connected with its own Google consent.",
  kind: "tools",
  enabled: configured,
  status: () => ({
    configured: configured(),
    accounts: listAccounts().map(({ label, email, scopes }) => ({ label, email, missing: shortfall(scopes) })),
  }),
  tools: { server: "gmail", names: ["gmail_list_accounts", "gmail_search", "gmail_read", "gmail_send"], kinds: ["chat"] },
  events: [
    { kind: "gmail.new", description: "a new message in a connected inbox (account, from, subject, snippet, link)" },
    { kind: "calendar.upcoming", description: "a meeting starts within 30 minutes (summary, start, attendees, link)" },
    { kind: "gmail.reconnect", description: "a mailbox has to be reconnected: its grant expired, was revoked, or never covered what pai needs (account, email, why, link)" },
  ],
  start: () => {
    if (!configured()) return;
    stopWatch = startWatch((kind, payload) => bus.emitEvent(kind, payload));
    stopCheck = startCheck();
  },
  stop: () => {
    stopWatch?.();
    stopCheck?.();
  },
  accounts: {
    list: () => listAccounts().map(({ label, email, scopes }) => ({ label, detail: shortfall(scopes).length ? `${email} — cannot ${shortfall(scopes).join(" or ")}` : email })),
    connectPath: "/gmail/connect?label={label}",
    removePath: "/gmail/accounts?label={label}",
    hint: "a short name for the mailbox: personal, work, atma",
  },
  prompt: {
    text: "Gmail: gmail_list_accounts shows which mailboxes are connected (by label — e.g. personal, work), gmail_search finds messages in one of them with Gmail's search syntax, gmail_read gets a message's text with its links (windowed: when it says truncated, read on with offset), gmail_send sends as that mailbox. Ask which account when it's ambiguous rather than guessing. Sending is irreversible and goes out in the user's name: check_outbound first, then their approval of the final text, and reply with reply_to_message_id so it threads. A mailbox whose Google grant does not cover sending says so before composing and puts a reconnect task on the user's list; that task is his to do and nothing can work around it.",
    kinds: ["chat"],
  },
};
