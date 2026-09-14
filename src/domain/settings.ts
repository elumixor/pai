import { config } from "../core/config.ts";

/**
 * The settings a client may change, kept in `data/config.json` and merged over the
 * environment when the daemon starts. Configuration is read once at import, so a change
 * takes effect on the next restart — which is why `changed` says so out loud.
 */

export const EDITABLE = [
  "PAI_BIND",
  "PAI_BASE_URL",
  "PAI_MAIN_MODEL",
  "PAI_TASK_MODEL",
  "PAI_UPDATE_CHANNEL",
  "PAI_AUTO_UPDATE",
  "PAI_IDLE_SHUTDOWN_MS",
  "PAI_TOKEN",
  "PAI_GOOGLE_ALLOWED",
  "PAI_PUBLIC",
  "PAI_DOMAIN",
  "PAI_SYNC",
  "PAI_SYNC_PEER",
  "PAI_NO_EDITOR",
  "PAI_NO_TELEGRAM",
  "PAI_EDITOR_PORT",
  "PAI_EDITOR_BIND",
] as const;

export type Editable = (typeof EDITABLE)[number];

export async function current(): Promise<Record<string, string>> {
  const file = Bun.file(config.overridesPath);
  return (await file.exists()) ? ((await file.json()) as Record<string, string>) : {};
}

/** Values in use right now, so a client can show what a setting does before it is overridden. */
export function effective() {
  return {
    PAI_BIND: config.host,
    PAI_BASE_URL: config.baseUrl,
    PAI_MAIN_MODEL: config.models.main,
    PAI_TASK_MODEL: config.models.task,
    PAI_UPDATE_CHANNEL: config.updateChannel,
    PAI_AUTO_UPDATE: config.autoUpdate ? "1" : "0",
    PAI_IDLE_SHUTDOWN_MS: String(config.idleShutdownMs),
    PAI_TOKEN: config.token ? "set" : "",
    PAI_GOOGLE_ALLOWED: config.google.allowed.join(", "),
    PAI_PUBLIC: config.public ? "1" : "0",
    PAI_DOMAIN: config.domain,
    PAI_SYNC: config.sync.enabled ? "1" : "0",
    PAI_SYNC_PEER: config.sync.peer,
    PAI_NO_EDITOR: config.editor.enabled ? "0" : "1",
    PAI_NO_TELEGRAM: config.telegram.enabled ? "0" : "1",
    PAI_EDITOR_PORT: String(config.editor.port),
    PAI_EDITOR_BIND: config.editor.host,
  } satisfies Record<Editable, string>;
}

export class SettingError extends Error {}

export async function write(changes: Record<string, unknown>) {
  const overrides = await current();
  for (const [key, value] of Object.entries(changes)) {
    if (!(EDITABLE as readonly string[]).includes(key)) throw new SettingError(`${key} is not an editable setting`);
    if (value === null || value === "") delete overrides[key];
    else overrides[key] = String(value);
  }
  await Bun.write(config.overridesPath, JSON.stringify(overrides, null, 2));
  return { overrides, restartRequired: true };
}
