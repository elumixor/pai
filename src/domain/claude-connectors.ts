import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";
import { describeServers } from "./mcp-describe.ts";
import { sessionEnv } from "./session.ts";
import { applyTools } from "./sessions.ts";
import { claudeSync, setConnectors, syncedConnectors, type SyncedConnector } from "./tool-registry.ts";

const log = logger("claude-connectors");

/**
 * What the account has connected on claude.ai. Nothing in the SDK lists them except a session that loaded the user's
 * settings, so one is started with no prompt, asked, and closed: no model call. Sessions themselves never load those
 * settings, since that would also bring the user's plugins and their own MCP servers.
 */
const EVERY_MS = 60 * 60_000;
const SETTLE_MS = 45_000;
const POLL_MS = 2_000;

/** Stays open with nothing to say: the process answers control requests without a turn. */
const silent = (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });

export async function discover() {
  const q = query({
    prompt: silent(),
    options: { cwd: config.workspace, env: sessionEnv(), settingSources: ["user"], settings: { disableAllHooks: true }, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
  });
  try {
    const deadline = Date.now() + SETTLE_MS;
    let status = await q.mcpServerStatus();
    while (status.some((s) => s.status === "pending") && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
      status = await q.mcpServerStatus();
    }
    const proxies = status.filter((s) => (s.config as { type?: string } | undefined)?.type === "claudeai-proxy");
    const described = await describeServers(proxies, {});
    const found: SyncedConnector[] = proxies.map((s) => {
      const c = s.config as unknown as { url: string; id: string };
      return { name: s.name, id: c.id, url: c.url, status: s.status, tools: described[s.name] ?? (s.tools ?? []).map((t) => ({ name: t.name, description: t.description })) };
    });
    // An account that answers with nothing is more likely a failed login than one with no connectors.
    if (!found.length && syncedConnectors().length) return log.warn("found no connectors, keeping the last list");
    const before = JSON.stringify(syncedConnectors().map((c) => [c.name, c.id, c.status]));
    setConnectors(found);
    if (before !== JSON.stringify(found.map((c) => [c.name, c.id, c.status]))) applyTools();
  } finally {
    q.close();
  }
}

export function startClaudeConnectors() {
  const tick = () => {
    if (claudeSync()) discover().catch((err: Error) => log.warn(`discovery failed: ${err.message}`));
  };
  tick();
  const timer = setInterval(tick, EVERY_MS);
  return () => clearInterval(timer);
}
