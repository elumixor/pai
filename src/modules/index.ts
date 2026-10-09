import { config } from "../core/config.ts";
import { editorStatus } from "../domain/editor.ts";
import { publicStatus } from "../domain/publish.ts";
import * as settings from "../domain/settings.ts";
import { gmailModule } from "./gmail.ts";
import type { Module } from "./types.ts";

/**
 * Everything pai is made of, as the dashboard shows it. The built-in pieces are described
 * here rather than moved: they keep their own files, this is the one list that says what
 * they are, what they add to a session, and which switch turns them off.
 */
export const modules: readonly Module[] = [
  {
    name: "browser",
    title: "Browser",
    description: "One Playwright browser on the box, shared by every session, so logins persist.",
    kind: "tools",
    enabled: () => true,
    status: () => ({ port: config.browserPort }),
    tools: { server: "playwright", names: ["browser_navigate", "browser_click", "browser_snapshot", "…"], kinds: ["chat", "code"] },
    prompt: {
      // Measured on LinkedIn, 2026-10-07: with every non-GET request aborted in the browser, the
      // page still rendered the message as sent. Ten "sent" messages that never existed came from
      // trusting that render.
      text: "The browser proves nothing by itself: a page will show a write as done — a message sent, a form submitted — even when nothing reached the site, so a click and the DOM that follows it are not evidence. Confirm a write by reading it back from the site's own data afterwards (the inbox, the thread, the profile, the confirmation page fetched fresh); if you cannot, say the write is unconfirmed and let the user check. Never report it as done, and never retry it blindly — the first attempt may have gone through.",
      kinds: ["chat", "code"],
    },
  },
  {
    name: "tasks",
    title: "Threads",
    description: "Another session in a project, with its own topic: start_thread, for coding work and one-offs.",
    kind: "tools",
    enabled: () => true,
    status: () => ({}),
    tools: { server: "pai", names: ["start_thread", "send_to_thread", "list_threads", "thread_output", "stop_thread", "progress", "list_projects", "describe_project"], kinds: ["chat"] },
  },
  gmailModule,
  {
    name: "editor",
    title: "Browser editor",
    description: "code-server with the pai extension, on the API's address, for a machine with nothing installed.",
    kind: "service",
    enabled: () => config.editor.enabled,
    status: () => editorStatus(),
    settings: [{ key: "PAI_NO_EDITOR", label: "Turned off", type: "toggle" }],
  },
  {
    name: "public",
    title: "Public address",
    description: "Caddy with https on 80/443, run by the daemon, behind Google sign-in or the token.",
    kind: "service",
    enabled: () => config.public,
    status: () => publicStatus() as Record<string, unknown>,
    settings: [
      { key: "PAI_PUBLIC", label: "Enabled", type: "toggle" },
      { key: "PAI_DOMAIN", label: "Domain", hint: "empty means <ip>.sslip.io" },
    ],
  },
];

export const byName = (name: string) => modules.find((m) => m.name === name);

/** The list for the dashboard: static description plus what each one is doing. */
export function describeModules() {
  return modules.map((m) => ({
    name: m.name,
    title: m.title,
    description: m.description,
    kind: m.kind,
    enabled: m.enabled(),
    status: m.status(),
    tools: m.tools,
    prompt: m.prompt,
    events: m.events,
    accounts: m.accounts ? { items: m.accounts.list(), connectPath: m.accounts.connectPath, removePath: m.accounts.removePath, hint: m.accounts.hint } : undefined,
    settings: m.settings?.map((s) => ({ ...s, value: s.secret ? (settings.effective()[s.key as settings.Editable] ? "set" : "") : (settings.effective()[s.key as settings.Editable] ?? "") })),
    live: Boolean(m.start),
  }));
}

export function startModules() {
  for (const m of modules) m.start?.();
  return () => {
    for (const m of modules) m.stop?.();
  };
}
