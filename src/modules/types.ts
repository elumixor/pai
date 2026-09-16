import type { SessionKind } from "../domain/session.ts";

/**
 * A module is one capability of pai with up to four parts: tools a session can call, a
 * paragraph in the system prompt saying they exist, events it puts on the bus, and a card in
 * the dashboard. Modules never import each other; they meet on the bus and in a session.
 */
export interface ModuleTools {
  /** The MCP server name sessions see the tools under. */
  readonly server: string;
  readonly names: readonly string[];
  /** Which sessions get them; a terminal `claude` never does. */
  readonly kinds: readonly SessionKind[];
}

export interface ModuleSetting {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly secret?: boolean;
  /** `toggle` settings are "1"/"" ; the rest free text. */
  readonly type?: "text" | "toggle" | "number";
}

export interface Module {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** channel: talks to the user · tools: things a session can do · source: watches something and emits events · service: infrastructure */
  readonly kind: "channel" | "tools" | "source" | "service";
  readonly enabled: () => boolean;
  /** What it is doing right now, for its card. */
  readonly status: () => Record<string, unknown>;
  readonly tools?: ModuleTools;
  readonly prompt?: { readonly text: string; readonly kinds: readonly SessionKind[] };
  readonly events?: readonly { readonly kind: string; readonly description: string }[];
  readonly settings?: readonly ModuleSetting[];
  /** Pages of the daemon the card links to; `{value}` in the path is asked for with `prompt`. */
  readonly links?: readonly { readonly label: string; readonly path: string; readonly prompt?: string }[];
  /** A restart is what applies most settings; modules that can start and stop live say so. */
  readonly start?: () => void;
  readonly stop?: () => void;
}
