/** What each connector said lately, for its page in the clients: the daemon's own log has every connector mixed in. */

const RING_SIZE = 200;

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  readonly at: number;
  readonly level: LogLevel;
  readonly text: string;
}

class ConnectorLogs {
  readonly #rings = new Map<string, readonly LogLine[]>();

  add(name: string, level: LogLevel, msg: string, rest: readonly unknown[]) {
    const text = [msg, ...rest.map((x) => Bun.inspect(x))].join(" ");
    this.#rings.set(name, [...this.of(name), { at: Date.now(), level, text }].slice(-RING_SIZE));
  }

  of(name: string): readonly LogLine[] {
    return this.#rings.get(name) ?? [];
  }
}

export const connectorLogs = new ConnectorLogs();
