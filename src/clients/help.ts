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

/** A top-level word a module answers (`pai files`), with its own subcommands for the completion. */
export interface Verb extends Command {
  readonly subcommands?: readonly Command[];
}

export interface ModuleHelp {
  readonly name: string;
  readonly description: string;
  readonly commands: readonly Command[];
  readonly verbs: readonly Verb[];
}

export const CORE: readonly Command[] = [
  { name: "claude", args: "[--resume [id]] [args…]", description: "a new conversation with the assistant; --resume continues one (an id, or claude's picker)" },
  { name: "status", description: "version, address, what is on" },
  { name: "cost", args: "[days] [--by agent|project|model|source|day]", description: "Claude limits, the box, and where the tokens went: API price beside the real one" },
  { name: "threads", args: "[project]", description: "every conversation by project; pick one to continue it here (`projects` is the same)" },
  { name: "agents", description: "pai and its staff as a tree: status, open tasks, spend today" },
  { name: "log", args: "[agent] [--limit n]", description: "the message log: everything said between you, pai and the agents; an agent's chat" },
  { name: "tasks", args: "[add <title>|done <id>|drop <id>] [--all] [--owner a]", description: "the task list: what is on your plate" },
  { name: "asks", description: "what the agents are waiting on you for" },
  { name: "answer", args: "<id> <text>", description: "answer an ask" },
  { name: "routines", description: "what runs on a schedule or an event, and whom it wakes" },
  { name: "snapshot", args: "[export [file]|import <file>]", description: "the state of things as one markdown document: memory, staff, tasks, decisions, routines; import hands it to pai to rebuild from" },
  { name: "audit", args: "[agent] [--q words] [--limit n]", description: "what the sessions did outside: sends, posts, writes, clicks in signed-in sites" },
  { name: "recall", args: "<words…>", description: "search transcripts, the message log, mail and chats" },
  { name: "tools", args: "[server]", description: "what the sessions can call, by MCP server; a name lists its tools" },
  { name: "skills", args: "[name]", description: "the skills sessions load; a name prints one" },
  { name: "instructions", args: "[name|--full]", description: "the system prompt in its parts: general, per module, per project; a name prints one" },
  { name: "memories", args: "[name]", description: "what the assistant remembers: MEMORY.md and Claude Code's memory files" },
  { name: "modules", args: "[update|restart]", description: "the modules: state, health" },
  { name: "completion", args: "[zsh]", description: "install shell completion (zsh); `zsh` prints the script" },
  { name: "version", description: "pai here and on the box" },
  { name: "update", args: "[--check] [--force]", description: "update pai on the box, and here when this is a laptop" },
];

export const DEV: readonly Command[] = [
  { name: "say", args: "<text>", description: "a turn in pai's one chat; waits for the reply" },
  { name: "rotate", description: "rebuild pai's session now (journal, briefing)" },
  { name: "chat", args: "<text> [--id <thread>]", description: "a turn in a new conversation, or in one" },
  { name: "task", args: "<title> <text> [--project <slug>]", description: "start a task" },
  { name: "send", args: "<id> <text> [--wait]", description: "a turn in a task" },
  { name: "answer", args: "<id> <text>", description: "answer a pending question" },
  { name: "tasks", description: "running and recent tasks" },
  { name: "stop", args: "<id> [--kill]", description: "interrupt or kill a session" },
  { name: "tail", args: "[id] [--raw]", description: "follow the event stream" },
  { name: "events", args: "[id]", description: "recent events" },
  { name: "settings", args: "[KEY=value…]", description: "the daemon's settings" },
  { name: "restart", description: "restart the daemon" },
  { name: "daemon", args: "[--foreground]", description: "start the daemon" },
  { name: "install", args: "[--uninstall]", description: "this machine: `pai` on PATH, the box's systemd service" },
  { name: "release", args: "[patch|minor|major]", description: "tag, push, wait for the box to report it" },
  { name: "update", args: "[--check] [--force]", description: "update pai on the box, and here when this is a laptop" },
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
      if (m.verbs.length) lines.push(...table(`${c.pai("pai")} `, m.verbs).map((l) => `  ${l}`));
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
  const verbs = modules.flatMap((m) => m.verbs);
  const dev = modules.find((m) => m.name === "dev");
  const top = [...CORE, ...verbs, ...modules.filter((m) => m !== dev).map((m) => ({ name: m.name, description: m.description })), { name: "dev", description: "the daemon's own controls" }];
  const subs: string[] = [`    dev) sub=(${entries([...DEV, ...(dev?.commands ?? [])])});;`, `    modules) sub=('update:pull them all' 'restart:reload');;`, `    completion) sub=('zsh:print the script');;`];
  for (const v of verbs) if (v.subcommands?.length) subs.push(`    ${v.name}) sub=(${entries(v.subcommands)});;`);
  for (const m of modules) if (m !== dev) subs.push(`    ${m.name}) sub=(${entries(m.commands)});;`);
  return `#compdef pai
# pai shell completion — generated by \`pai completion\`; regenerated by \`pai update\`.
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
