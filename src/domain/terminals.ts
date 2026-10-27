import { homedir } from "node:os";
import { get as getProject } from "./projects.ts";
import { Terminal, TerminalError, type TerminalOptions } from "./terminal.ts";
import { bus } from "../core/bus.ts";
import { logger } from "../core/log.ts";

const log = logger("terminals");

/** A terminal is a shell someone is typing into; more than a handful means something leaked. */
const MAX_TERMINALS = 8;

const DEFAULT_SIZE = { cols: 80, rows: 24 } as const;

const terminals = new Map<string, Terminal>();

export interface OpenOptions {
  readonly project?: string;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export function open(options: OpenOptions = {}) {
  reapDead();
  if (terminals.size >= MAX_TERMINALS) throw new TerminalError(`too many terminals open (${MAX_TERMINALS})`, "");

  const resolved: TerminalOptions = {
    cwd: resolveCwd(options),
    project: options.project,
    cols: options.cols ?? DEFAULT_SIZE.cols,
    rows: options.rows ?? DEFAULT_SIZE.rows,
  };
  const terminal = new Terminal(resolved);
  terminals.set(terminal.id, terminal);
  log.info(`opened ${terminal.id} in ${terminal.cwd}`);
  bus.emitEvent("terminal.opened", terminal.summary());
  return terminal;
}

export function get(id: string) {
  return terminals.get(id);
}

export function list() {
  reapDead();
  return [...terminals.values()].map((terminal) => terminal.summary());
}

export function close(id: string) {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.kill();
  terminals.delete(id);
  bus.emitEvent("terminal.closed", { id });
  return true;
}

export function closeAll() {
  for (const id of [...terminals.keys()]) close(id);
}

function reapDead() {
  for (const [id, terminal] of terminals) if (!terminal.alive) terminals.delete(id);
}

function resolveCwd(options: OpenOptions) {
  if (options.project) {
    const project = getProject(options.project);
    if (!project) throw new TerminalError(`unknown project: ${options.project}`, "");
    return project.path;
  }
  return options.cwd ?? homedir();
}
