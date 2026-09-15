import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { file, saveFile } from "./api.ts";
import { basename, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";

/** The language by file extension; anything else is plain text with line numbers. */
function language(path: string): LanguageSupport | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "css":
      return css();
    case "html":
    case "svelte":
    case "vue":
      return html();
    case "rs":
      return rust();
    case "py":
      return python();
    case "yml":
    case "yaml":
      return yaml();
    default:
      return undefined;
  }
}

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
        language(path) ?? [],
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
