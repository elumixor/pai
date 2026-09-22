/**
 * The help and the shell completion, from one table of commands. Colour when the terminal
 * has it (a tty, no NO_COLOR): `pai` in one colour, a module in another, commands, their
 * arguments and options, and the descriptions each their own.
 */

export interface Command {
  readonly name: string;
  /** `<required> [optional] [--flags]`, shown after the name. */
  readonly args?: string;
  readonly description: string;
}

export interface ModuleHelp {
  readonly name: string;
  readonly description: string;
  readonly commands: readonly Command[];
}

export const CORE: readonly Command[] = [
  { name: "claude", args: "[--resume] [args…]", description: "a new conversation with the assistant; --resume picks an earlier one" },
  { name: "ssh", args: "[command…]", description: "a shell on the box, or one command there" },
  { name: "status", description: "version, address, what is on" },
  { name: "sync", description: "watch the files sync until in step" },
  { name: "files", args: "[command]", description: "files here and on the box; `pai files help`" },
  { name: "update", description: "update pai here and on the box" },
  { name: "cost", description: "Claude limits and what the box costs" },
  { name: "menubar", args: "[install|uninstall]", description: "the menu bar app on this Mac" },
  { name: "modules", args: "[update|restart]", description: "the modules: state, health" },
  { name: "completion", args: "[install]", description: "shell completion for zsh" },
  { name: "version", description: "pai here and on the box" },
];

export const FILES: readonly Command[] = [
  { name: "status", description: "what is in sync, what is not" },
  { name: "watch", args: "[on|off] [--forever]", description: "live; on/off pauses and resumes" },
  { name: "sync", args: "[--local|--remote]", description: "one cycle; conflicts listed, settled only with a side" },
  { name: "push", description: "sync --local" },
  { name: "pull", description: "sync --remote" },
  { name: "diff", description: "the conflicts" },
  { name: "reset", description: "forget what was agreed; compare afresh" },
];

export const DEV: readonly Command[] = [
  { name: "chat", args: "<text> [--id <thread>]", description: "a turn in a new conversation, or in one" },
  { name: "task", args: "<title> <text> [--project <slug>]", description: "start a task" },
  { name: "send", args: "<id> <text> [--wait]", description: "a turn in a task" },
  { name: "answer", args: "<id> <text>", description: "answer a pending question" },
  { name: "tasks", description: "running and recent tasks" },
  { name: "stop", args: "<id> [--kill]", description: "interrupt or kill a session" },
  { name: "tail", args: "[id] [--raw]", description: "follow the event stream" },
  { name: "events", args: "[id]", description: "recent events" },
  { name: "projects", args: "[--refresh]", description: "projects as the assistant sees them" },
  { name: "settings", args: "[KEY=value…]", description: "the daemon's settings" },
  { name: "restart", description: "restart the daemon" },
  { name: "daemon", args: "[--foreground]", description: "start the daemon" },
  { name: "install", args: "[--uninstall]", description: "the systemd service on the box" },
  { name: "update", args: "[--check] [--force]", description: "this daemon only" },
];

const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: string) => (s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  pai: paint("1;36"),
  module: paint("1;35"),
  command: paint("32"),
  args: paint("33"),
  text: paint("0"),
  dim: paint("2"),
  head: paint("1"),
};

/** `<x>` and `[y]` coloured as arguments; the words around them stay plain. */
const args = (s?: string) => (s ? ` ${s.replace(/(<[^>]+>|\[[^\]]+\]|--[\w-]+)/g, (m) => c.args(m))}` : "");
const width = (cmds: readonly Command[]) => Math.max(...cmds.map((x) => `${x.name}${x.args ? ` ${x.args}` : ""}`.length), 8);

function table(prefix: string, cmds: readonly Command[]) {
  const w = width(cmds);
  return cmds.map((x) => {
    const visible = `${x.name}${x.args ? ` ${x.args}` : ""}`;
    return `  ${prefix}${c.command(x.name)}${args(x.args)}${" ".repeat(Math.max(1, w - visible.length + 2))}${c.dim(x.description)}`;
  });
}

export function usage(modules: readonly ModuleHelp[] = []) {
  const lines = [`${c.pai("pai")} ${c.dim("— the assistant on the box, from here")}`, "", ...table("", CORE)];
  if (modules.length) {
    lines.push("", c.head("Modules:"));
    for (const m of modules) {
      lines.push("", `  ${c.pai("pai")} ${c.module(m.name)}${" ".repeat(Math.max(1, 14 - m.name.length))}${c.dim(m.description)}`);
      const w = width(m.commands.map((x) => ({ ...x, name: `${m.name} ${x.name}`.trim() })));
      for (const x of m.commands) {
        const visible = `${m.name} ${x.name}${x.args ? ` ${x.args}` : ""}`.trim();
        lines.push(`    ${c.pai("pai")} ${c.module(m.name)}${x.name ? ` ${c.command(x.name)}` : ""}${args(x.args)}${" ".repeat(Math.max(1, w - visible.length + 2))}${c.dim(x.description)}`);
      }
    }
  }
  lines.push("", c.dim("--json on any command for raw output"));
  return lines.join("\n");
}

export const section = (title: string, cmds: readonly Command[], prefix = "") => [`${c.pai("pai")} ${c.module(title)}`, "", ...table(prefix, cmds)].join("\n");

/** A zsh completion function for everything above, modules included, as of now. */
export function zshCompletion(modules: readonly ModuleHelp[]) {
  const q = (s: string) => s.replace(/'/g, "'\\''").replace(/:/g, "\\:");
  const entries = (cmds: readonly Command[]) => cmds.filter((x) => x.name).map((x) => `'${q(x.name.split(" ")[0]!)}:${q(x.description)}'`).join(" ");
  const top = [...CORE, ...modules.map((m) => ({ name: m.name, description: m.description })), { name: "dev", description: "the daemon's own controls" }];
  const subs: string[] = [`    files|fs) sub=(${entries(FILES)});;`, `    dev) sub=(${entries(DEV)});;`, `    menubar) sub=('install:install' 'uninstall:remove' 'status:status');;`, `    modules) sub=('update:pull them all' 'restart:reload');;`, `    completion) sub=('zsh:print the script' 'install:write it and source it from .zshrc');;`];
  for (const m of modules) subs.push(`    ${m.name}) sub=(${entries(m.commands)});;`);
  return `#compdef pai
# pai shell completion — generated by \`pai completion zsh\`; regenerated by \`pai update\`.
_pai() {
  local -a cmds sub
  cmds=(${entries(top)})
  if (( CURRENT == 2 )); then _describe 'command' cmds; return; fi
  case $words[2] in
${subs.join("\n")}
    *) _files; return;;
  esac
  if (( CURRENT == 3 )); then _describe 'subcommand' sub; else _files; fi
}
compdef _pai pai
`;
}
