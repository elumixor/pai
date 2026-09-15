// node-pty is a native module that only loads correctly under Node, so the daemon (Bun)
// runs one of these per terminal and talks to it in JSON lines: input and control on
// stdin, output and exit on stdout.
import { spawn } from "node-pty";
import { createInterface } from "node:readline";

const [shell, cwd, cols, rows] = process.argv.slice(2);

const term = spawn(shell, [], {
  name: "xterm-256color",
  cwd,
  cols: Number(cols),
  rows: Number(rows),
  env: { ...process.env, TERM: "xterm-256color" },
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

term.onData((data) => send({ type: "data", data }));

// What is running in the foreground — the shell itself, or vim, bun, ssh… — so a client can
// label the terminal by it. Polled, because node-pty has no event for a title change.
let lastProcess;
setInterval(() => {
  const name = term.process;
  if (name === lastProcess) return;
  lastProcess = name;
  send({ type: "process", name });
}, 1500).unref();
term.onExit(({ exitCode }) => {
  send({ type: "exit", exitCode });
  process.exit(0);
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "input") term.write(message.data);
  else if (message.type === "resize") term.resize(message.cols, message.rows);
  else if (message.type === "kill") term.kill();
});
