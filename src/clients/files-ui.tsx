/**
 * The live views of the files sync, drawn with Ink: `pai files watch` (every folder, what
 * Mutagen is doing to it, its conflicts and problems, redrawn as they change) and
 * `pai files diff tree` (the conflicts as a tree to walk, each one's diff beside it, settled
 * one at a time for this machine or the box). Both need a terminal; the plain commands cover
 * everything else.
 */
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import * as files from "../host/files.ts";
import type { Conflict, FolderStatus } from "../host/files.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const home = process.env.HOME ?? "";
const short = (p: string) => p.replace(home, "~");

const STATE: Record<string, string> = {
  watching: "in sync",
  scanning: "scanning",
  "staging-alpha": "staging here",
  "staging-beta": "staging to the box",
  reconciling: "reconciling",
  transitioning: "applying",
  saving: "saving",
  connecting: "connecting",
  "connecting-alpha": "connecting",
  "connecting-beta": "connecting to the box",
  "waiting-for-rescan": "waiting",
  "halted-on-root-emptied": "halted: a root was emptied (pai files reset)",
  "halted-on-root-deletion": "halted: a root was deleted",
  "halted-on-root-type-change": "halted: a root changed type",
  missing: "not set up",
};
export const stateWord = (x: FolderStatus) => (x.paused ? "paused" : (STATE[x.state] ?? x.state));

const size = (n?: number) => {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};
const count = (n?: number) => (n ?? 0).toLocaleString("en-US");

function useTick(ms = 80) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return tick;
}

function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (v) => live && (setValue(v), setError(undefined)),
        (err: Error) => live && setError(err.message),
      );
    void run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [ms, gen, ...deps]);
  return { value, error, refresh: () => setGen((g) => g + 1) };
}

const settled = (folders: readonly FolderStatus[]) => folders.every((x) => x.state === "watching" && !x.paused && !x.conflicts.length);

function Bar({ done, total, width }: { done: number; total: number; width: number }) {
  const ratio = total ? Math.min(1, done / total) : 0;
  const filled = Math.round(ratio * width);
  return (
    <Text>
      <Text color="cyan">{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(width - filled)}</Text>
      <Text> {Math.round(ratio * 100)}%</Text>
    </Text>
  );
}

function FolderCard({ x, tick, width }: { x: FolderStatus; tick: number; width: number }) {
  const busy = !x.paused && x.state !== "watching" && x.state !== "missing" && !x.state.startsWith("halted");
  const icon = x.paused ? <Text color="yellow">⏸</Text> : x.state === "watching" ? (x.conflicts.length ? <Text color="red">!</Text> : <Text color="green">✓</Text>) : busy ? <Text color="cyan">{FRAMES[tick % FRAMES.length]}</Text> : <Text color="red">✗</Text>;
  const facts = [x.files !== undefined && `${count(x.files)} files`, x.size !== undefined && size(x.size), x.cycles !== undefined && `${x.cycles} cycles`].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {icon} <Text bold>{short(x.local).padEnd(12)}</Text> <Text color={x.paused ? "yellow" : x.state === "watching" ? "green" : "cyan"}>{stateWord(x)}</Text>
        {facts ? <Text dimColor>  {facts}</Text> : null}
        {!x.connected && x.state !== "missing" ? <Text color="yellow">  · box unreachable</Text> : null}
      </Text>
      {x.progress ? (
        <Box marginLeft={3}>
          <Bar done={x.progress.done} total={x.progress.total} width={Math.max(10, Math.min(30, width - 50))} />
          <Text dimColor wrap="truncate-middle">
            {"  "}
            {x.progress.path}
          </Text>
        </Box>
      ) : null}
      {x.error ? (
        <Text color="red" wrap="truncate">
          {"   "}
          {x.error}
        </Text>
      ) : null}
      {x.conflicts.length ? (
        <Box flexDirection="column" marginLeft={3}>
          <Text color="red">
            {x.conflicts.length} conflict{x.conflicts.length > 1 ? "s" : ""}
          </Text>
          {x.conflicts.slice(0, 6).map((c) => (
            <Text key={c.path} wrap="truncate-middle">
              {"  "}
              {c.path}
              <Text dimColor>
                {"  "}here {c.local} · box {c.remote}
              </Text>
            </Text>
          ))}
          {x.conflicts.length > 6 ? <Text dimColor>  … {x.conflicts.length - 6} more</Text> : null}
        </Box>
      ) : null}
      {x.problems.length ? (
        <Box flexDirection="column" marginLeft={3}>
          <Text color="yellow">
            {x.problems.length} problem{x.problems.length > 1 ? "s" : ""}
          </Text>
          {x.problems.slice(0, 4).map((p) => (
            <Text key={`${p.side}:${p.path}`} wrap="truncate">
              {"  "}
              <Text dimColor>{p.side}</Text> {p.path} <Text dimColor>{p.error}</Text>
            </Text>
          ))}
          {x.problems.length > 4 ? <Text dimColor>  … {x.problems.length - 4} more (pai files status)</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}

function Watch({ forever }: { forever: boolean }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const tick = useTick();
  const { value: folders, error, refresh } = usePoll(files.status, 700);
  const [note, setNote] = useState<string>();
  const [mode, setMode] = useState<"watch" | "tree">("watch");
  const width = stdout.columns || 100;
  const done = folders ? settled(folders) : false;

  useEffect(() => {
    if (done && !forever && mode === "watch") exit();
  }, [done, forever, mode, exit]);

  const act = (label: string, run: () => Promise<unknown>) => {
    setNote(`${label}…`);
    run().then(
      () => (setNote(undefined), refresh()),
      (err: Error) => setNote(err.message),
    );
  };

  useInput((input, key) => {
    if (mode !== "watch") return;
    if (input === "q" || (key.ctrl && input === "c") || key.escape) exit();
    else if (input === "p") act(folders?.some((x) => x.paused) ? "resuming" : "pausing", () => (folders?.some((x) => x.paused) ? files.resume() : files.pause()));
    else if (input === "s") act("syncing", files.flush);
    else if (input === "d" && folders?.some((x) => x.conflicts.length)) setMode("tree");
  });

  if (mode === "tree" && folders) return <Tree folders={folders} onBack={() => (setMode("watch"), refresh())} />;

  return (
    <Box flexDirection="column">
      {error ? <Text color="red">{error}</Text> : null}
      {folders?.map((x) => <FolderCard key={x.name} x={x} tick={tick} width={width} />)}
      <Text>
        {note ? (
          <Text color="yellow">{note}</Text>
        ) : done ? (
          <Text color="green">in sync</Text>
        ) : folders?.every((x) => x.state === "watching" && !x.paused) ? (
          <Text color="red">{folders.reduce((n, x) => n + x.conflicts.length, 0)} conflicts, nothing else to do</Text>
        ) : folders ? (
          <Text>
            <Text color="cyan">{FRAMES[tick % FRAMES.length]}</Text> syncing
          </Text>
        ) : (
          <Text dimColor>reading…</Text>
        )}
        <Text dimColor>
          {"   "}q quit · p {folders?.some((x) => x.paused) ? "resume" : "pause"} · s sync now{folders?.some((x) => x.conflicts.length) ? " · d diffs" : ""}
        </Text>
      </Text>
    </Box>
  );
}

/* ---------- the conflicts as a tree ---------- */

interface Node {
  readonly key: string;
  readonly folder: string;
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly dir: boolean;
  readonly conflict?: Conflict;
  readonly children: Node[];
}

function buildTree(folders: readonly FolderStatus[]): Node[] {
  const roots: Node[] = [];
  for (const f of folders) {
    if (!f.conflicts.length) continue;
    const root: Node = { key: f.name, folder: f.name, path: "", name: short(f.local), depth: 0, dir: true, children: [] };
    roots.push(root);
    for (const c of [...f.conflicts].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = c.path.split("/");
      let at = root;
      parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        const path = parts.slice(0, i + 1).join("/");
        let next = at.children.find((n) => n.name === part && n.dir === !last);
        if (!next) {
          next = { key: `${f.name}:${path}`, folder: f.name, path, name: part, depth: i + 1, dir: !last, conflict: last ? c : undefined, children: [] };
          at.children.push(next);
        }
        at = next;
      });
    }
  }
  return roots;
}

/** Directories with one child fold into it, so `a/b/c/file` is one row, not four. */
function collapse(node: Node): Node {
  if (node.dir && node.depth > 0 && node.children.length === 1 && node.children[0]!.dir) {
    const only = collapse(node.children[0]!);
    return { ...only, name: `${node.name}/${only.name}`, depth: node.depth };
  }
  return { ...node, children: node.children.map(collapse) };
}

const under = (node: Node): Node[] => (node.dir ? node.children.flatMap(under) : [node]);

function flatten(nodes: Node[], open: Set<string>, depth = 0): (Node & { depth: number })[] {
  return nodes.flatMap((n) => {
    const row = { ...n, depth };
    return n.dir && open.has(n.key) ? [row, ...flatten(n.children, open, depth + 1)] : [row];
  });
}

function Tree({ folders, onBack }: { folders: readonly FolderStatus[]; onBack?: () => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [status, setStatus] = useState(folders);
  const roots = useMemo(() => buildTree(status).map(collapse), [status]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots.flatMap((r) => [r.key, ...under(r).map((n) => n.key)]).concat(allDirs(roots))));
  const [cursor, setCursor] = useState(0);
  const [focus, setFocus] = useState<"tree" | "diff">("tree");
  const [scroll, setScroll] = useState(0);
  const [diff, setDiff] = useState<{ key: string; text: string }>();
  const [note, setNote] = useState<string>();
  const rows = flatten(roots, open);
  const current = rows[Math.min(cursor, rows.length - 1)];
  const width = stdout.columns || 100;
  const height = Math.max(8, (stdout.rows || 30) - 3);
  const treeWidth = Math.min(48, Math.max(24, Math.floor(width * 0.38)));
  const diffWidth = width - treeWidth - 3;

  useEffect(() => {
    if (!current || current.dir) return void setDiff(undefined);
    let live = true;
    files.diff(current.folder, current.path, true).then(
      (text) => live && (setDiff({ key: current.key, text }), setScroll(0)),
      (err: Error) => live && setDiff({ key: current.key, text: err.message }),
    );
    return () => {
      live = false;
    };
  }, [current?.key]);

  const reload = () =>
    files.status().then((s) => {
      setStatus(s);
      if (!s.some((x) => x.conflicts.length)) (onBack ?? exit)();
    });

  const settle = (winner: "local" | "remote") => {
    if (!current) return;
    const keys = under(current).map((n) => `${n.folder}:${n.path}`);
    setNote(`settling ${keys.length} for ${winner === "local" ? "this machine" : "the box"}…`);
    files.resolve(winner, keys).then(
      () => (setNote(undefined), reload()),
      (err: Error) => setNote(err.message),
    );
  };

  const diffLines = diff?.text.split("\n") ?? [];
  const pageSize = height - 1;

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return (onBack ?? exit)();
    if (key.escape) return focus === "diff" ? setFocus("tree") : (onBack ?? exit)();
    if (key.tab) return setFocus(focus === "tree" ? "diff" : "tree");
    if (input === "l") return settle("local");
    if (input === "r") return settle("remote");
    if (focus === "diff") {
      const max = Math.max(0, diffLines.length - pageSize);
      if (key.downArrow || input === "j") setScroll((s) => Math.min(max, s + 1));
      else if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
      else if (key.pageDown || input === " " || input === "f") setScroll((s) => Math.min(max, s + pageSize));
      else if (key.pageUp || input === "b") setScroll((s) => Math.max(0, s - pageSize));
      else if (input === "g") setScroll(0);
      else if (input === "G") setScroll(max);
      return;
    }
    if (key.downArrow || input === "j") setCursor((c) => Math.min(rows.length - 1, c + 1));
    else if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.rightArrow && current?.dir) setOpen((o) => new Set(o).add(current.key));
    else if (key.leftArrow && current) {
      if (current.dir && open.has(current.key)) setOpen((o) => (o.delete(current.key), new Set(o)));
      else {
        const parent = rows.slice(0, cursor).reverse().find((r) => r.dir && r.depth < current.depth);
        if (parent) setCursor(rows.indexOf(parent));
      }
    } else if (key.return && current) {
      if (current.dir) setOpen((o) => (o.has(current.key) ? (o.delete(current.key), new Set(o)) : new Set(o).add(current.key)));
      else setFocus("diff");
    }
  });

  const from = Math.max(0, Math.min(cursor - Math.floor(height / 2), rows.length - height));
  const visible = rows.slice(from, from + height);

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width={treeWidth} borderStyle="single" borderColor={focus === "tree" ? "cyan" : "gray"} borderTop={false} borderBottom={false} borderLeft={false} paddingRight={1}>
          {visible.map((n) => {
            const at = rows.indexOf(n) === cursor;
            const mark = n.dir ? (open.has(n.key) ? "▾ " : "▸ ") : n.conflict?.local === "deleted" ? "− " : n.conflict?.remote === "deleted" ? "+ " : "± ";
            const line = `${"  ".repeat(n.depth)}${mark}${n.name}${n.dir ? ` (${under(n).length})` : ""}`;
            return (
              <Text key={n.key} inverse={at && focus === "tree"} bold={at} color={n.dir ? undefined : n.conflict?.local === "deleted" ? "red" : n.conflict?.remote === "deleted" ? "green" : "yellow"} wrap="truncate">
                {line}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" width={diffWidth} marginLeft={1}>
          {current && !current.dir ? (
            diff?.key === current.key ? (
              diffLines.slice(scroll, scroll + pageSize).map((l, i) => (
                <Text key={scroll + i} wrap="truncate">
                  {l || " "}
                </Text>
              ))
            ) : (
              <Text dimColor>loading diff…</Text>
            )
          ) : (
            <Text dimColor>{current ? `${under(current).length} conflict${under(current).length === 1 ? "" : "s"} under ${current.name}` : "no conflicts"}</Text>
          )}
        </Box>
      </Box>
      <Text>
        {note ? <Text color="yellow">{note}  </Text> : null}
        {current && !current.dir ? (
          <Text dimColor>
            here {current.conflict?.local} · box {current.conflict?.remote}
            {diff?.key === current.key && diffLines.length > pageSize ? ` · ${scroll + 1}-${Math.min(diffLines.length, scroll + pageSize)}/${diffLines.length}` : ""}
            {"   "}
          </Text>
        ) : null}
        <Text dimColor>{focus === "tree" ? "↑↓ move · ←→ fold · enter diff · l keep here · r keep box · q quit" : "↑↓ scroll · space/b page · esc back · l keep here · r keep box"}</Text>
      </Text>
    </Box>
  );
}

const allDirs = (nodes: Node[]): string[] => nodes.flatMap((n) => (n.dir ? [n.key, ...allDirs(n.children)] : []));

export async function watch(forever: boolean) {
  const app = render(<Watch forever={forever} />, { exitOnCtrlC: true });
  await app.waitUntilExit();
}

export async function tree() {
  const folders = await files.status();
  if (!folders.some((x) => x.conflicts.length)) return false;
  const app = render(<Tree folders={folders} />, { exitOnCtrlC: true });
  await app.waitUntilExit();
  return true;
}
