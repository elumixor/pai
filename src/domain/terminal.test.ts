import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { Terminal, TerminalError } from "./terminal.ts";
import { close, closeAll, get, list, open } from "./terminals.ts";

const opened: Terminal[] = [];

function terminal(cols = 80, rows = 24) {
  const term = new Terminal({ cwd: tmpdir(), cols, rows, shell: "/bin/sh" });
  opened.push(term);
  return term;
}

/** Terminals are asynchronous by nature; poll rather than guess a delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return false;
}

afterEach(() => {
  for (const term of opened.splice(0)) term.kill();
  closeAll();
});

describe("Terminal", () => {
  it("runs a command and reports its output", async () => {
    const term = terminal();
    let output = "";
    term.subscribe((data) => {
      output += data;
    });
    term.write("echo pai-terminal-works\n");
    expect(await waitFor(() => output.includes("pai-terminal-works"))).toBe(true);
  });

  it("starts in the requested directory", async () => {
    const term = terminal();
    let output = "";
    term.subscribe((data) => {
      output += data;
    });
    term.write("pwd\n");
    await waitFor(() => output.includes("/"));
    expect(output).toContain(tmpdir().replace(/\/$/, "").split("/").pop() ?? "tmp");
  });

  it("replays the screen to a client that connects late", async () => {
    const term = terminal();
    term.write("echo replayed-line\n");
    expect(await waitFor(() => term.scrollback.includes("replayed-line"))).toBe(true);

    let replayed = "";
    term.subscribe((data) => {
      replayed += data;
    });
    expect(replayed).toContain("replayed-line");
  });

  it("tells the shell about a resize", async () => {
    const term = terminal(80, 24);
    term.resize(120, 40);
    expect(term.cols).toBe(120);
    expect(term.rows).toBe(40);

    let output = "";
    term.subscribe((data) => {
      output += data;
    });
    term.write("stty size\n");
    expect(await waitFor(() => output.includes("40 120"))).toBe(true);
  });

  it("reports its exit and refuses further input", async () => {
    const term = terminal();
    term.write("exit 3\n");
    expect(await waitFor(() => !term.alive)).toBe(true);
    expect(term.exitCode).toBe(3);
    expect(() => term.write("echo late\n")).toThrow(TerminalError);
  });

  it("unsubscribes cleanly", async () => {
    const term = terminal();
    let seen = 0;
    const stop = term.subscribe(() => {
      seen += 1;
    });
    term.write("echo one\n");
    await waitFor(() => seen > 0);
    stop();
    const before = seen;
    term.write("echo two\n");
    await Bun.sleep(200);
    expect(seen).toBe(before);
  });
});

describe("terminals registry", () => {
  it("opens, lists and closes", async () => {
    const term = open({ cwd: tmpdir(), cols: 80, rows: 24 });
    expect(get(term.id)).toBe(term);
    expect(list().map((t) => t.id)).toContain(term.id);
    expect(close(term.id)).toBe(true);
    expect(get(term.id)).toBeUndefined();
    expect(close(term.id)).toBe(false);
  });

  it("refuses an unknown project", () => {
    expect(() => open({ project: "no-such-project" })).toThrow(TerminalError);
  });

  it("caps how many can be open at once", () => {
    for (let i = 0; i < 8; i++) open({ cwd: tmpdir() });
    expect(() => open({ cwd: tmpdir() })).toThrow(TerminalError);
  });
});
