import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, LanguageDescription, StreamLanguage, type StreamParser } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml as yamlMode } from "@codemirror/legacy-modes/mode/yaml";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { linter, lintGutter, type Diagnostic as LintDiagnostic } from "@codemirror/lint";
import { diagnostics as fetchDiagnostics } from "./api.ts";
import { Vim, vim } from "@replit/codemirror-vim";
import { file, saveFile } from "./api.ts";
import { basename, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { editorTheme } from "./highlight.ts";
import { current, onTheme } from "./theme.ts";

/**
 * The language for a file. Every mode CodeMirror knows is here — the common ones bundled,
 * the rest fetched on first use — plus the extension-less files a home directory is full of.
 */
async function language(path: string, text: string): Promise<Extension> {
  const name = basename(path);
  // A script with no extension says what it is on its first line.
  const shebang = /^#!.*\b(\w+)\s*$/.exec(text.split("\n", 1)[0] ?? "")?.[1];
  if (shebang && /^(sh|bash|zsh|fish|dash)$/.test(shebang)) return StreamLanguage.define(shell);
  if (shebang && /^(bun|node|deno)$/.test(shebang)) return LanguageDescription.matchLanguageName(languages, "typescript")?.load() ?? [];
  if (shebang && /^python\d?$/.test(shebang)) return LanguageDescription.matchLanguageName(languages, "python")?.load() ?? [];
  const byName = LEGACY_BY_NAME[name.replace(/^\./, "")];
  if (byName) return StreamLanguage.define(byName);
  const description = LanguageDescription.matchFilename(languages, name);
  if (description) return description.load();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const legacy = LEGACY_BY_EXT[ext];
  return legacy ? StreamLanguage.define(legacy) : [];
}

/** Vimscript has no mode of its own; comments, strings and the command word are enough to read one. */
const vimMode: StreamParser<unknown> = {
  token(stream) {
    if (stream.sol() && stream.match(/^\s*"/)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^'[^']*'/) || stream.match(/^"[^"]*"/)) return "string";
    if (stream.sol() || stream.string.slice(0, stream.pos).trim() === "") {
      if (stream.match(/^\s*[a-zA-Z]+/)) return "keyword";
    }
    if (stream.match(/^<[^>]+>/)) return "atom";
    if (stream.match(/^\d+/)) return "number";
    stream.next();
    return null;
  },
};

const LEGACY_BY_NAME: Record<string, StreamParser<unknown>> = {
  zshrc: shell, bashrc: shell, bash_profile: shell, profile: shell, zprofile: shell, zshenv: shell,
  gitconfig: properties, gitignore: properties, condarc: yamlMode, env: properties, editorconfig: properties, npmrc: properties,
};
const LEGACY_BY_EXT: Record<string, StreamParser<unknown>> = { vim: vimMode, conf: properties, ini: properties, terminfo: properties, sh: shell, zsh: shell };


let saveCurrent: (() => Promise<void>) | undefined;
Vim.defineEx("write", "w", () => void saveCurrent?.());
Vim.defineEx("wq", "wq", () => void saveCurrent?.());

/**
 * The editor: CodeMirror with vim keys, the language by extension, `:w` or ⌘S to save
 * through the daemon. The file is what is on the box, so a session can pick the change up.
 */
/** Line numbers as vim shows them with `relativenumber`: the distance from the cursor, the real number on its line. */
const relativeNumbers = lineNumbers({
  formatNumber: (line, state) => {
    const cursor = state.doc.lineAt(state.selection.main.head).number;
    return line === cursor ? String(line) : String(Math.abs(line - cursor));
  },
});

/** A JSON file's own syntax error, without asking the daemon. */
function jsonLint(text: string): LintDiagnostic[] {
  try {
    JSON.parse(text);
    return [];
  } catch (err) {
    const at = Number(/position (\d+)/.exec((err as Error).message)?.[1] ?? 0);
    return [{ from: Math.min(at, text.length), to: Math.min(at + 1, text.length), severity: "error", message: (err as Error).message }];
  }
}

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export async function editor(pane: HTMLElement, path: string) {
  const status = el("span.dim", {}, "");
  const head = el("header.panel-head", {}, icon("file", 13), el("h2", {}, basename(path)), el("span.dim.ellipsis", { title: path }, path), el("span.grow"), status);
  const host = el("div.cm-host");
  clear(pane, head, host);

  let contents;
  try {
    contents = await file(path);
  } catch {
    clear(pane, head, el("div.empty", {}, el("p", {}, "This file is not cached and the daemon is not reachable.")));
    return;
  }

  let dirty = false;
  const mark = () => {
    status.textContent = dirty ? "modified" : "";
    head.classList.toggle("dirty", dirty);
  };
  const save = async () => {
    const text = view.state.doc.toString();
    status.textContent = "saving…";
    const result = await saveFile(path, text);
    if (result.error) status.textContent = result.error;
    else if (result.queued) status.textContent = "queued — saved when the daemon answers";
    else {
      dirty = false;
      fresh = true;
      mark();
      status.textContent = "saved";
      setTimeout(mark, 1500);
    }
  };
  saveCurrent = save;

  const theme = new Compartment();
  // Type errors come from tsc on the daemon: fetched when the file opens and after a save.
  let fresh = false;
  const tsLint = linter(
    async (view) => {
      if (!TS_EXT.test(path)) return [];
      const result = await fetchDiagnostics(path, fresh).catch(() => ({ items: [] }));
      fresh = false;
      const doc = view.state.doc;
      return result.items
        .filter((d) => d.line <= doc.lines)
        .map((d) => {
          const line = doc.line(d.line);
          const from = Math.min(line.from + d.column - 1, line.to);
          return { from, to: line.to, severity: d.severity, message: `${d.message} (${d.code})` };
        });
    },
    { delay: 1500, needsRefresh: (update) => update.docChanged },
  );
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: contents.text,
      extensions: [
        vim(),
        relativeNumbers,
        lintGutter(),
        path.endsWith(".json") ? linter((v) => jsonLint(v.state.doc.toString())) : tsLint,
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        theme.of(editorTheme(current())),
        await language(path, contents.text),
        keymap.of([{ key: "Mod-s", run: () => (void save(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !dirty) {
            dirty = true;
            mark();
          }
        }),
        EditorState.readOnly.of(Boolean(contents.truncated)),
        // Leaving the editor saves it, like an editor with autosave.
        EditorView.domEventHandlers({ blur: () => void (dirty && save()) }),
      ],
    }),
  });
  if (contents.truncated) status.textContent = "truncated · read only";
  const stopTheme = onTheme(() => view.dispatch({ effects: theme.reconfigure(editorTheme(current())) }));
  view.focus();

  return () => {
    stopTheme();
    if (saveCurrent === save) saveCurrent = undefined;
    view.destroy();
  };
}

export function emptyEditor(pane: HTMLElement) {
  clear(
    pane,
    el("header.panel-head", {}, icon("code", 13), el("h2", {}, "Editor")),
    el("div.empty", {}, icon("file", 28), el("p", {}, "Pick a file, or ⌘K to find one."), el("p.dim", {}, "vim keys · :w or ⌘S saves")),
  );
}
