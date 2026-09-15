import { spawn as spawnProcess, type Subprocess } from "bun";
import { join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("terminal");

const HOST_SCRIPT = join(config.repo, "src", "domain", "pty-host.mjs");

/** Enough to redraw a screenful and a bit of history after a reconnect. */
const SCROLLBACK_LIMIT = 64 * 1024;

export interface TerminalOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly project?: string;
  readonly shell?: string;
}

export class TerminalError extends Error {
  constructor(message: string, readonly id: string) {
    super(message);
    this.name = "TerminalError";
  }
}

type Listener = (data: string) => void;

/**
 * One pseudo-terminal on the host. Output is kept as well as broadcast, so a client that
 * reconnects sees the screen it left rather than an empty one.
 */
export class Terminal {
  readonly id = crypto.randomUUID().slice(0, 8);
  readonly startedAt = new Date().toISOString();
  readonly cwd: string;
  readonly project?: string;

  #process: Subprocess<"pipe", "pipe", "pipe">;
  #scrollback = "";
  #listeners = new Set<Listener>();
  #cols: number;
  #rows: number;
  #exitCode?: number;
  #processName?: string;

  constructor(options: TerminalOptions) {
    this.cwd = options.cwd;
    this.project = options.project;
    this.#cols = options.cols;
    this.#rows = options.rows;
    const shell = options.shell ?? process.env.SHELL ?? "/bin/bash";
    this.#process = spawnProcess({
      cmd: ["node", HOST_SCRIPT, shell, this.cwd, String(this.#cols), String(this.#rows)],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#readOutput();
  }

  get cols() {
    return this.#cols;
  }

  get rows() {
    return this.#rows;
  }

  get exitCode() {
    return this.#exitCode;
  }

  get alive() {
    return this.#exitCode === undefined;
  }

  /** The foreground process, as the pty reports it; the shell's name until something runs. */
  get processName() {
    return this.#processName;
  }

  get scrollback() {
    return this.#scrollback;
  }

  summary() {
    return {
      id: this.id,
      cwd: this.cwd,
      project: this.project,
      process: this.#processName,
      cols: this.#cols,
      rows: this.#rows,
      startedAt: this.startedAt,
      alive: this.alive,
      exitCode: this.#exitCode,
    };
  }

  write(data: string) {
    this.#send({ type: "input", data });
  }

  resize(cols: number, rows: number) {
    this.#cols = cols;
    this.#rows = rows;
    this.#send({ type: "resize", cols, rows });
  }

  kill() {
    if (!this.alive) return;
    this.#send({ type: "kill" });
  }

  /** Replays what is on screen, then follows. The returned function unsubscribes. */
  subscribe(listener: Listener) {
    if (this.#scrollback) listener(this.#scrollback);
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #send(message: Record<string, unknown>) {
    if (!this.alive) throw new TerminalError("terminal has exited", this.id);
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
    this.#process.stdin.flush();
  }

  async #readOutput() {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of this.#process.stdout) {
      buffered += decoder.decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) this.#handle(line);
    }
    this.#exitCode ??= 0;
  }

  #handle(line: string) {
    if (!line.trim()) return;
    let message: { type: string; data?: string; exitCode?: number; name?: string };
    try {
      message = JSON.parse(line);
    } catch {
      log.warn(`unparsable line from pty host ${this.id}: ${line.slice(0, 120)}`);
      return;
    }
    if (message.type === "exit") {
      this.#exitCode = message.exitCode ?? 0;
      return;
    }
    if (message.type === "process") {
      this.#processName = message.name;
      return;
    }
    if (message.type !== "data" || message.data === undefined) return;
    this.#scrollback = (this.#scrollback + message.data).slice(-SCROLLBACK_LIMIT);
    for (const listener of this.#listeners) listener(message.data);
  }
}
