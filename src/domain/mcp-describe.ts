/**
 * What each MCP tool does. Claude Code's status lists a server's tools by name only, so the
 * descriptions are asked of the servers themselves: an in-process server has them in its
 * registry, an http server answers `tools/list`, and a claude.ai connector answers it too,
 * through Anthropic's proxy with the account's Claude Code login.
 */
import type { McpServerConfig, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../core/log.ts";
import { accessToken } from "./usage.ts";

const log = logger("mcp");

export interface ToolDescription {
  readonly name: string;
  readonly description?: string;
}

type Registered = { _registeredTools?: Record<string, { description?: string }> };

async function overHttp(url: string, headers: Record<string, string>): Promise<ToolDescription[]> {
  const client = new Client({ name: "pai", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description }));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Descriptions per server, keyed by the server's configured name. `configured` is what the
 * session was started with (in-process instances live there); `status` is what Claude Code
 * reports, which includes the account's connectors with their proxy addresses.
 */
export async function describeServers(status: readonly McpServerStatus[], configured: Record<string, McpServerConfig>): Promise<Record<string, ToolDescription[]>> {
  const out: Record<string, ToolDescription[]> = {};
  const token = await accessToken().catch(() => undefined);
  await Promise.all(
    status.map(async (s) => {
      try {
        const own = configured[s.name] as (McpServerConfig & { instance?: { server?: Registered } & Registered }) | undefined;
        const instance = own && "instance" in own ? own.instance : undefined;
        const registry = instance?._registeredTools ?? instance?.server?._registeredTools;
        if (registry) {
          out[s.name] = Object.entries(registry).map(([name, t]) => ({ name, description: t.description }));
          return;
        }
        const config = (s.config ?? own) as { type?: string; url?: string } | undefined;
        if (config?.type === "http" && config.url) out[s.name] = await overHttp(config.url, {});
        else if (config?.type === "claudeai-proxy" && config.url && token) out[s.name] = await overHttp(config.url, { authorization: `Bearer ${token}` });
      } catch (err) {
        log.debug(`${s.name}: no descriptions (${(err as Error).message.slice(0, 120)})`);
      }
    }),
  );
  return out;
}
