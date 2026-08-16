import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { bus } from "./bus.ts";
import { logger } from "./log.ts";

const log = logger("session");

export type SessionState = "starting" | "idle" | "busy" | "dead";

export interface SessionRow {
  session_id: string;
  short_id: string;
  project: string;
  cwd: string;
  title: string;
  state: SessionState;
  pid: number | null;
  started_at: number;
  last_activity: number;
  last_result: string | null;
}

interface SpawnOptions {
  project: string;
  cwd: string;
  title?: string;
  /** Resume an existing on-disk session instead of starting a fresh one. */
  resume?: string;
  model?: string;
}

/**
 * One Claude Code process driven over the stream-json protocol.
 *
 * The process is disposable; the session is not. Everything needed to bring a
 * session back lives in ~/.claude/projects, so a dead process is respawned with
 * --resume rather than treated as lost work.
 */
export class Session {
  readonly id: string;
  readonly shortId: string;
  readonly project: string;
  readonly cwd: string;
  title: string;
  state: SessionState = "starting";

  private proc?: Subprocess<"pipe", "pipe", "pipe">;
  private queue: string[] = [];
  private buffer = "";
  private turnText = "";

  constructor(opts: SpawnOptions) {
    this.id = opts.resume ?? randomUUID();
    this.shortId = this.id.slice(0, 6);
    this.project = opts.project;
    this.cwd = opts.cwd;
    this.title = opts.title ?? "";
    this.start(opts.resume !== undefined, opts.model);
  }

  private start(resume: boolean, model?: string) {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      config.session.permissionMode,
      "--model",
      model ?? config.session.model,
      "-n",
      `builder/${this.project}/${this.shortId}`,
    ];
    if (resume) args.push("--resume", this.id);
    else args.push("--session-id", this.id);

    this.proc = Bun.spawn(["claude", ...args], {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUILDER_SESSION: this.id },
    }) as Subprocess<"pipe", "pipe", "pipe">;

    this.persist();
    bus.emitEvent(
      resume ? "session.resumed" : "session.started",
      { shortId: this.shortId, cwd: this.cwd, title: this.title },
      this.id,
      this.project,
    );

    void this.readLoop();
    void this.watchExit();
  }

  private async readLoop() {
    const dec = new TextDecoder();
    for await (const chunk of this.proc!.stdout) {
      this.buffer += dec.decode(chunk as Uint8Array);
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handle(JSON.parse(line) as Record<string, any>);
        } catch {
          log.debug(`${this.shortId} unparsable line`, line.slice(0, 200));
        }
      }
    }
  }

  private async watchExit() {
    const code = await this.proc!.exited;
    const stderr = await new Response(this.proc!.stderr).text();
    this.state = "dead";
    this.persist();
    bus.emitEvent("session.exit", { code, stderr: stderr.slice(-2000) }, this.id, this.project);
    log.info(`${this.shortId} exited code=${code}`);
  }

  private handle(msg: Record<string, any>) {
    this.touch();
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && this.state === "starting") {
          this.state = "busy";
          this.persist();
        }
        break;

      case "assistant": {
        for (const block of (msg.message?.content ?? []) as Record<string, any>[]) {
          if (block.type === "text" && block.text) {
            this.turnText += block.text;
            bus.emitEvent("session.text", { text: block.text }, this.id, this.project);
          } else if (block.type === "tool_use") {
            bus.emitEvent(
              "session.tool",
              { name: block.name, summary: summarizeTool(block.name, block.input) },
              this.id,
              this.project,
            );
          }
        }
        break;
      }

      case "rate_limit_event":
        bus.emitEvent("rate_limit", msg.rate_limit_info ?? {}, this.id, this.project);
        break;

      case "result": {
        const text = (msg.result as string) ?? this.turnText;
        this.turnText = "";
        db.prepare("UPDATE sessions SET last_result = ? WHERE session_id = ?").run(text.slice(0, 4000), this.id);
        bus.emitEvent(
          "session.turn_end",
          {
            text,
            isError: Boolean(msg.is_error),
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd,
          },
          this.id,
          this.project,
        );
        this.state = "idle";
        this.persist();
        this.flush();
        break;
      }
    }
  }

  /** Enqueue a user turn. Sent immediately when the session is idle, otherwise after the current turn. */
  send(text: string) {
    this.queue.push(text);
    bus.emitEvent("session.input", { text }, this.id, this.project);
    this.flush();
  }

  private flush() {
    // "starting" is sendable: the CLI emits system/init only once it has a first
    // turn to work on, so waiting for init before writing would deadlock.
    if (this.state === "busy" || this.state === "dead") return;
    if (this.queue.length === 0 || !this.proc) return;
    const text = this.queue.shift()!;
    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    this.proc.stdin.write(frame + "\n");
    this.proc.stdin.flush();
    this.state = "busy";
    this.persist();
  }

  kill() {
    this.queue = [];
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.state = "dead";
    this.persist();
  }

  private touch() {
    db.prepare("UPDATE sessions SET last_activity = ? WHERE session_id = ?").run(now(), this.id);
  }

  private persist() {
    db.prepare(
      `INSERT INTO sessions (session_id, short_id, project, cwd, title, state, pid, started_at, last_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET state=excluded.state, pid=excluded.pid,
         title=excluded.title, last_activity=excluded.last_activity`,
    ).run(
      this.id,
      this.shortId,
      this.project,
      this.cwd,
      this.title,
      this.state,
      this.proc?.pid ?? null,
      now(),
      now(),
    );
  }

  toJSON() {
    return {
      sessionId: this.id,
      shortId: this.shortId,
      project: this.project,
      cwd: this.cwd,
      title: this.title,
      state: this.state,
      pid: this.proc?.pid,
      queued: this.queue.length,
    };
  }
}

function summarizeTool(name: string, input: Record<string, any> | undefined): string {
  if (!input) return name;
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 120);
    case "Read":
    case "Edit":
    case "Write":
      return String(input.file_path ?? "").replace(process.env.HOME ?? "", "~");
    case "Grep":
    case "Glob":
      return String(input.pattern ?? "");
    case "Task":
      return String(input.description ?? "");
    default:
      return "";
  }
}
