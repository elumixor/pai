import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, LanguageDescription, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml as yamlMode } from "@codemirror/legacy-modes/mode/yaml";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { file, saveFile } from "./api.ts";
import { basename, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";

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

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

let saveCurrent: (() => Promise<void>) | undefined;
Vim.defineEx("write", "w", () => void saveCurrent?.());
Vim.defineEx("wq", "wq", () => void saveCurrent?.());

/**
 * The editor: CodeMirror with vim keys, the language by extension, `:w` or ⌘S to save
 * through the daemon. The file is what is on the box, so a session can pick the change up.
 */
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
      mark();
      status.textContent = "saved";
      setTimeout(mark, 1500);
    }
  };
  saveCurrent = save;

  const theme = new Compartment();
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: contents.text,
      extensions: [
        vim(),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        theme.of(dark() ? oneDark : []),
        await language(path, contents.text),
        keymap.of([{ key: "Mod-s", run: () => (void save(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !dirty) {
            dirty = true;
            mark();
          }
        }),
        EditorState.readOnly.of(Boolean(contents.truncated)),
      ],
    }),
  });
  if (contents.truncated) status.textContent = "truncated · read only";
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => view.dispatch({ effects: theme.reconfigure(scheme.matches ? oneDark : []) });
  scheme.addEventListener("change", onScheme);
  view.focus();

  return () => {
    scheme.removeEventListener("change", onScheme);
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
