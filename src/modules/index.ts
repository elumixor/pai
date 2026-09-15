import { config } from "../core/config.ts";
import { enabled as tgUserEnabled } from "../clients/tg-user.ts";
import { editorStatus } from "../domain/editor.ts";
import { publicStatus } from "../domain/publish.ts";
import { syncStatus } from "../domain/sync.ts";
import * as settings from "../domain/settings.ts";
import { linkedinModule } from "./linkedin.ts";
import type { Module } from "./types.ts";

/**
 * Everything pai is made of, as the dashboard shows it. The built-in pieces are described
 * here rather than moved: they keep their own files, this is the one list that says what
 * they are, what they add to a session, and which switch turns them off.
 */
export const modules: readonly Module[] = [
  {
    name: "telegram",
    title: "Telegram bot",
    description: "The chat the user talks to pai from: the root chat is the main conversation, every topic a task.",
    kind: "channel",
    enabled: () => config.telegram.enabled && Boolean(config.telegram.token),
    status: () => ({ configured: Boolean(config.telegram.token && config.telegram.chatId) }),
    events: [{ kind: "session.input", description: "a message the user sent" }],
    settings: [{ key: "PAI_NO_TELEGRAM", label: "Turned off", type: "toggle", hint: "a laptop daemon next to the box's leaves the bot to the box" }],
  },
  {
    name: "tg-user",
    title: "Telegram account",
    description: "The user's own Telegram: sessions can read chats, search them, and write as the user.",
    kind: "tools",
    enabled: tgUserEnabled,
    status: () => ({ configured: tgUserEnabled() }),
    tools: { server: "tg", names: ["list_chats", "read_chat", "search", "send_message", "…"], kinds: ["main", "task", "code"] },
    prompt: { text: "The user's own Telegram account is available as the tg tools.", kinds: ["main", "task", "code"] },
  },
  {
    name: "browser",
    title: "Browser",
    description: "One Playwright browser on the box, shared by every session, so logins persist.",
    kind: "tools",
    enabled: () => true,
    status: () => ({ port: config.browserPort }),
    tools: { server: "playwright", names: ["browser_navigate", "browser_click", "browser_snapshot", "…"], kinds: ["main", "task", "code"] },
  },
  {
    name: "memory",
    title: "Memory",
    description: "Long-term facts as markdown files; the index is in every session's prompt, a project's own facts only in its sessions.",
    kind: "tools",
    enabled: () => true,
    status: () => ({}),
    tools: { server: "pai", names: ["remember", "recall", "forget"], kinds: ["main", "task", "code"] },
  },
  {
    name: "tasks",
    title: "Tasks",
    description: "The orchestrator's way of doing work: start_task opens another session in a project, with its own topic.",
    kind: "tools",
    enabled: () => true,
    status: () => ({}),
    tools: { server: "pai", names: ["start_task", "send_to_task", "list_tasks", "task_output", "stop_task", "progress", "list_projects", "describe_project"], kinds: ["main"] },
  },
  linkedinModule,
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
  {
    name: "sync",
    title: "File sync",
    description: "Syncthing between the machines that run pai: the projects and the Claude Code transcripts.",
    kind: "service",
    enabled: () => config.sync.enabled,
    status: () => syncStatus() as Record<string, unknown>,
    settings: [
      { key: "PAI_SYNC", label: "Enabled", type: "toggle" },
      { key: "PAI_SYNC_PEER", label: "Peer device id" },
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
