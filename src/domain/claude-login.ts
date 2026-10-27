/**
 * The box's own Claude login: every session runs on it (connectors only load with a claude.ai login,
 * not with the setup token in the environment), so when it dies pai goes mute. The failure arrives as
 * an assistant message per turn ("Failed to authenticate: OAuth session expired…"), which used to land
 * in the log as a reply each time; now it is one task with a reconnect link, closed by the next turn
 * that gets through.
 *
 * The login has to be this machine's own. A refresh token is single-use: two machines sharing one login
 * (the Mac's keychain copied over) take turns invalidating each other, and whichever refreshes second
 * is signed out — which is how this broke. Reconnecting runs `claude auth login` here, the user
 * authorises it in their browser and pastes the code back on `/claude/login`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { bus, type PaiEvent } from "../core/bus.ts";
import { config } from "../core/config.ts";
import { kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { escapeHtml } from "../protocol/rich.ts";
import * as sessions from "./sessions.ts";
import * as tasks from "./tasks.ts";

const log = logger("claude-login");

export const LOGIN_PATH = "/claude/login";
const TITLE = "Reconnect Claude on the box";
/** Machine plumbing is pai's own area, as the mailboxes are. */
const OWNER = "pai-dev";
const LAST_EMAIL = "claude_login_email";
const EVERY_MS = 15 * 60_000;
const URL_TIMEOUT_MS = 20_000;
const CODE_TIMEOUT_MS = 60_000;

const bin = () => Bun.which("claude") ?? join(homedir(), ".local", "bin", "claude");

/** Without the setup token: with it `claude` reports that token as the login, which sessions never use. */
const env = () => {
  const out: Record<string, string> = { BROWSER: "true" };
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "CLAUDE_CODE_OAUTH_TOKEN") out[key] = value;
  return out;
};

export interface LoginStatus {
  readonly loggedIn: boolean;
  readonly email?: string;
}

export async function status(): Promise<LoginStatus> {
  const proc = Bun.spawn([bin(), "auth", "status"], { env: env(), cwd: homedir(), stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    const parsed = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; email?: string };
    return { loggedIn: Boolean(parsed.loggedIn) && parsed.authMethod === "claude.ai", email: parsed.email };
  } catch {
    return { loggedIn: false };
  }
}

// --- the task: one, its reason current ---------------------------------------------------

const link = () => `${config.baseUrl}${LOGIN_PATH}`;

function raise(why: string) {
  const email = kv.get(LAST_EMAIL);
  const nextAction = `[Reconnect Claude](${link()}) — sign in${email ? ` as ${email}` : ""} and paste the code back`;
  const notes = `${why} Every session on the box runs on this login, so pai cannot answer anything until it is reconnected.`;
  const open = tasks.list({ open: true }).find((t) => t.title === TITLE);
  if (open) {
    if (open.notes !== notes || open.nextAction !== nextAction || open.status !== "waiting_user") tasks.update(open.id, { notes, nextAction, status: "waiting_user" });
    return;
  }
  const task = tasks.add({ title: TITLE, status: "waiting_user", owner: OWNER, createdBy: "claude-login", nextAction, notes });
  log.warn(`${why} — task #${task.id}`);
}

/** Closes the task; true when there was one, so the caller knows the login just came back. */
function resolve(): boolean {
  const open = tasks.list({ open: true }).find((t) => t.title === TITLE);
  if (!open) return false;
  tasks.update(open.id, { status: "done", nextAction: "" });
  log.info("Claude login works again; task closed");
  return true;
}

/** The task's state is in the database; kept here too so a turn's end does not query it. */
let down = false;

function restored() {
  down = false;
  if (resolve()) bus.emitEvent("claude.login_restored", {});
}

/** A sign-out with no turn to show it (overnight, nothing running) still becomes the task. */
export async function check() {
  const s = await status();
  if (!s.loggedIn) {
    down = true;
    raise("The box has no Claude login.");
  }
}

/**
 * Auth failures raise the task, a turn that got through closes it, and a timer covers the hours
 * nobody writes. Its own timer, like the LinkedIn check: an observer must not depend on what it watches.
 */
export function startClaudeLoginCheck() {
  down = tasks.list({ open: true }).some((t) => t.title === TITLE);
  const handler = (e: PaiEvent) => {
    if (e.kind === "claude.auth_failed") {
      down = true;
      raise(`The Claude login on the box was refused (${String(e.payload.error ?? "authentication_failed")}).`);
    } else if (down && e.kind === "session.turn_end" && !e.payload.isError && !e.payload.authFailed) restored();
  };
  bus.on("event", handler);
  const tick = () => void check().catch((err: Error) => log.warn(`check: ${err.message}`));
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, EVERY_MS);
  return () => {
    bus.off("event", handler);
    clearTimeout(first);
    clearInterval(timer);
  };
}

// --- reconnecting: `claude auth login`, its URL to the browser, the code back ----------------

let flow: { proc: Subprocess<"pipe", "pipe", "pipe">; output: string } | undefined;

/** Starts a login and returns the URL to authorise it at. A new start replaces an unfinished one. */
export async function start(): Promise<string> {
  flow?.proc.kill();
  const email = kv.get(LAST_EMAIL);
  const proc = Bun.spawn([bin(), "auth", "login", "--claudeai", ...(email ? ["--email", email] : [])], { env: env(), cwd: homedir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const current = { proc, output: "" };
  flow = current;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) current.output += decoder.decode(chunk, { stream: true });
  };
  void read(proc.stdout);
  void read(proc.stderr);
  const deadline = Date.now() + URL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = current.output.match(/https:\/\/\S+oauth\/authorize\S+/)?.[0];
    if (url) return url;
    if (proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`claude auth login gave no sign-in link: ${current.output.trim().slice(-300) || "no output"}`);
}

/** Hands the pasted code to the waiting login; the status after it, or why it failed. */
export async function finish(code: string): Promise<LoginStatus> {
  const current = flow;
  if (!current || current.proc.exitCode !== null) throw new Error("no sign-in is waiting for a code — start again");
  const before = current.output.length;
  current.proc.stdin.write(`${code.trim()}\n`);
  await current.proc.stdin.flush();
  const exited = await Promise.race([current.proc.exited.then(() => true), Bun.sleep(CODE_TIMEOUT_MS).then(() => false)]);
  if (!exited) current.proc.kill();
  flow = undefined;
  const s = await status();
  if (!s.loggedIn) throw new Error(current.output.slice(before).replace(/Paste code here if prompted >/g, "").trim().slice(0, 300) || "the code was not accepted");
  if (s.email) kv.set(LAST_EMAIL, s.email);
  log.info(`signed in as ${s.email ?? "?"}`);
  bus.emitEvent("claude.login", { email: s.email });
  sessions.recycle();
  restored();
  return s;
}

// --- the page ------------------------------------------------------------------------------

export async function page(): Promise<Response> {
  const s = await status();
  let url: string | undefined;
  let error: string | undefined;
  try {
    url = await start();
  } catch (err) {
    error = (err as Error).message;
  }
  const email = kv.get(LAST_EMAIL);
  const state = s.loggedIn ? `Signed in as <b>${escapeHtml(s.email ?? "?")}</b>.` : down ? "Signed out — pai cannot answer until this is reconnected." : "Signed out.";
  const body = error
    ? `<p class="err">${escapeHtml(error)}</p><p><a href="${LOGIN_PATH}">Try again</a></p>`
    : `<ol>
<li><a class="btn" href="${escapeHtml(url!)}" target="_blank" rel="noopener">Sign in with Claude</a><span class="hint">${email ? `As ${escapeHtml(email)}, the account pai runs on.` : "With the account pai should run on."}</span></li>
<li><form id="f"><input id="code" placeholder="Paste the code" autocomplete="off" spellcheck="false" required><button class="btn">Connect</button></form></li>
</ol><p id="out"></p>
<script>
const f = document.getElementById("f"), out = document.getElementById("out");
f.onsubmit = async (e) => {
  e.preventDefault();
  out.className = ""; out.textContent = "Connecting…";
  const r = await fetch(${JSON.stringify(`${LOGIN_PATH}/code`)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("code").value }) });
  const d = await r.json().catch(() => ({ error: "no answer" }));
  if (d.error) { out.className = "err"; out.innerHTML = ""; out.append(d.error + " — "); const a = document.createElement("a"); a.href = location.pathname; a.textContent = "start over"; out.append(a); return; }
  f.closest("ol").remove();
  document.getElementById("state").innerHTML = "Signed in as <b></b>. pai is answering again.";
  document.querySelector("#state b").textContent = d.email || "?";
  out.innerHTML = '<a href="/">Back to pai</a>';
};
</script>`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude login</title>
<style>
:root{--bg:#f3f0ea;--ink:#2b2a27;--dim:#2b2a2799;--card:#fffdf9;--act:#2b2a27;--err:#b4412f}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a18;--ink:#ece8e1;--dim:#ece8e199;--card:#252421;--act:#ece8e1;--err:#e07a64}}
body{margin:0;padding:48px 16px;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:460px;margin:0 auto;background:var(--card);border-radius:20px;padding:28px;box-shadow:0 1px 3px #0000001a}
h1{font-size:19px;margin:0 0 6px}#state{color:var(--dim);margin:0 0 22px}
ol{padding-left:20px;margin:0}li{margin-bottom:18px}li::marker{color:var(--dim)}
.btn{display:inline-block;padding:8px 16px;border:0;border-radius:52px;background:var(--act);color:var(--bg);font:600 14px var(--font,inherit);text-decoration:none;cursor:pointer}
.hint{display:block;color:var(--dim);font-size:13px;margin-top:6px}
form{display:flex;gap:8px}input{flex:1;min-width:0;padding:8px 12px;border:1px solid #8884;border-radius:10px;background:transparent;color:var(--ink);font:14px ui-monospace,monospace}
.err{color:var(--err)}a{color:inherit}
</style><main><h1>Claude on the box</h1><p id="state">${state}</p>${body}</main>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
