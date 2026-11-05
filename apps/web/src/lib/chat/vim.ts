import { latinKey } from "@desk/core";
import { type Atom, clampCaret, VimEngine, type VimMode } from "./vim-engine";

export type { VimMode };

/** The block caret's box, in the coordinates of the editable element's offset parent. */
export interface CaretBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface VimOptions {
  onmode: (mode: VimMode) => void;
  oncaret: (box: CaretBox | null) => void;
  /** The layer rewrote the element's contents. */
  onchange: () => void;
  /** A put needs its own copy of a chip: the same element cannot stand in the box twice. */
  cloneChip: (chip: HTMLElement) => HTMLElement;
}

export interface VimLayer {
  readonly mode: VimMode;
  /** Runs one keydown; true when the layer used it and the host has nothing left to do. */
  keydown(event: KeyboardEvent): boolean;
  /** The host replaced the box's contents, by sending or by restoring a draft: nothing before this to undo into. */
  load(): void;
  detach(): void;
}

interface Place {
  readonly node: Node;
  readonly offset: number;
}
interface Reading {
  readonly atoms: readonly Atom<HTMLElement>[];
  /** Where each atom stands, plus one last entry for the end of the box. */
  readonly places: readonly Place[];
  readonly caret: number;
}

const NEWLINE = "\n";
const NAMED_KEYS: Readonly<Record<string, string>> = { ArrowLeft: "h", ArrowDown: "j", ArrowUp: "k", ArrowRight: "l", Home: "0", End: "$", Delete: "x", Backspace: "h", " ": "l" };
// What an input method reports instead of the key: a non-ASCII stand-in makes `latinKey` go by the physical key.
const COMPOSING_KEYS = new Set(["Process", "Unidentified"]);
const NON_LATIN = "Ж";
const DEAD_KEY = "Dead";
// Outside insert mode only what a person clearly did on purpose may change the text.
const ALLOWED_INPUT = /^(insertFromPaste|insertFromDrop|deleteByCut|deleteByDrag|history)/;
const FALLBACK_LINE_RATIO = 1.4;
const FALLBACK_CHAR_RATIO = 0.6;
const segmenter = new Intl.Segmenter();

const isChip = (node: Node): node is HTMLElement => node instanceof HTMLElement && node.contentEditable === "false";
const indexIn = (node: Node) => Array.prototype.indexOf.call(node.parentNode!.childNodes, node) as number;

/** The element's text as atoms. A final line break draws no line of its own in CSS, so it is not in the text. */
function read(root: HTMLElement): Reading {
  const atoms: Atom<HTMLElement>[] = [];
  const places: Place[] = [];
  const selection = window.getSelection();
  const focus = selection?.focusNode && root.contains(selection.focusNode) ? { node: selection.focusNode, offset: selection.focusOffset } : undefined;
  let caret: number | undefined;
  const mark = (node: Node, reached: boolean) => {
    if (caret === undefined && focus?.node === node && reached) caret = atoms.length;
  };
  const walk = (parent: Node) => {
    parent.childNodes.forEach((child, i) => {
      mark(parent, i === focus?.offset);
      visit(child);
    });
    mark(parent, true);
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let offset = 0;
      for (const { segment } of segmenter.segment(node.textContent ?? "")) {
        mark(node, offset >= (focus?.offset ?? 0));
        atoms.push(segment);
        places.push({ node, offset });
        offset += segment.length;
      }
      return mark(node, true);
    }
    if (node.nodeName === "BR" || isChip(node)) {
      atoms.push(node.nodeName === "BR" ? NEWLINE : (node as HTMLElement));
      places.push({ node: node.parentNode!, offset: indexIn(node) });
      return;
    }
    walk(node);
  };
  walk(root);
  const placeholder = atoms.at(-1) === NEWLINE ? places[atoms.length - 1] : undefined;
  if (placeholder) atoms.pop();
  const end = placeholder ?? { node: root, offset: root.childNodes.length };
  return { atoms, places: [...places.slice(0, atoms.length), end], caret: Math.min(caret ?? atoms.length, atoms.length) };
}

/** Writes the atoms back. A chip goes in as itself, so whatever the host keyed on that element still holds. */
function write(root: HTMLElement, atoms: readonly Atom<HTMLElement>[]) {
  const nodes: Node[] = [];
  let run = "";
  const flush = () => {
    if (run) nodes.push(document.createTextNode(run));
    run = "";
  };
  for (const atom of atoms) {
    if (typeof atom === "string" && atom !== NEWLINE) {
      run += atom;
      continue;
    }
    flush();
    nodes.push(typeof atom === "string" ? document.createElement("br") : atom);
  }
  flush();
  if (atoms.at(-1) === NEWLINE) nodes.push(document.createElement("br"));
  root.replaceChildren(...nodes);
}

/**
 * Vim on a contenteditable element. Normal and visual keys are run against the atoms read from the element and the
 * result written back; insert mode leaves the browser alone. Adds no node to the element: the block caret is the
 * host's to draw, from `oncaret`.
 */
class Layer implements VimLayer {
  readonly #root: HTMLElement;
  readonly #options: VimOptions;
  readonly #engine: VimEngine<HTMLElement>;
  readonly #observer: MutationObserver;
  #shownMode: VimMode | undefined;
  #leftWindow = false;

  constructor(root: HTMLElement, options: VimOptions) {
    this.#root = root;
    this.#options = options;
    this.#engine = new VimEngine(options.cloneChip);
    this.#observer = new MutationObserver(this.#refresh);
    this.#observer.observe(root, { childList: true, characterData: true, subtree: true });
    root.addEventListener("focus", this.#focused);
    root.addEventListener("blur", this.#blurred);
    root.addEventListener("scroll", this.#refresh);
    root.addEventListener("beforeinput", this.#beforeInput);
    document.addEventListener("selectionchange", this.#refresh);
    window.addEventListener("resize", this.#refresh);
    if (document.activeElement === root) this.#focused();
    else this.#announce();
  }

  get mode() {
    return this.#engine.mode;
  }

  detach() {
    this.#observer.disconnect();
    this.#root.removeEventListener("focus", this.#focused);
    this.#root.removeEventListener("blur", this.#blurred);
    this.#root.removeEventListener("scroll", this.#refresh);
    this.#root.removeEventListener("beforeinput", this.#beforeInput);
    document.removeEventListener("selectionchange", this.#refresh);
    window.removeEventListener("resize", this.#refresh);
  }

  load() {
    this.#engine.load(read(this.#root).atoms);
    this.#announce();
  }

  keydown(event: KeyboardEvent) {
    if (event.isComposing || !this.#root.isContentEditable || event.metaKey || event.altKey) return false;
    const inserting = this.#engine.mode === "insert";
    if (event.ctrlKey) return this.#controlKey(event, inserting);
    if (event.key === "Escape") return this.#escape(event);
    if (inserting) return false;
    if (event.key === "Enter") {
      if (event.shiftKey) event.preventDefault();
      else this.#run(() => this.#engine.escape());
      return event.shiftKey;
    }
    const key = this.#plainKey(event);
    if (key === undefined) return false;
    event.preventDefault();
    if (key !== DEAD_KEY) this.#run(() => this.#engine.press(key));
    return true;
  }

  #controlKey(event: KeyboardEvent, inserting: boolean) {
    const key = latinKey(event);
    if (key === "r") {
      event.preventDefault();
      if (!inserting) this.#run(() => this.#engine.redo());
      return true;
    }
    if (key !== "[" && key !== "c") return false;
    // Off a Mac this is also the copy key, and a selection is what a copy is for.
    const copying = key === "c" && this.#engine.mode !== "visual" && this.#engine.mode !== "line" && window.getSelection()?.isCollapsed === false;
    if (copying) return false;
    event.preventDefault();
    this.#run(() => this.#engine.escape());
    return true;
  }

  #escape(event: KeyboardEvent) {
    const used = this.#run(() => this.#engine.escape());
    if (used) event.preventDefault();
    return used;
  }

  /** The key as Vim names it, whatever layout or input method is on; undefined when it is not Vim's to take. */
  #plainKey(event: KeyboardEvent) {
    const { key, code, shiftKey } = event;
    if (this.#engine.awaitsCharacter && key.length === 1) return key;
    const latin = latinKey({ key: COMPOSING_KEYS.has(key) ? NON_LATIN : key, code, shiftKey });
    if (latin.length === 1 && latin !== " ") return latin;
    return NAMED_KEYS[latin] ?? (latin === DEAD_KEY ? latin : undefined);
  }

  /** Reads the box, runs one engine step, shows what came of it. */
  #run<T>(step: () => T) {
    const before = read(this.#root);
    this.#engine.sync(before.atoms, this.#engine.mode === "normal" ? clampCaret(before.atoms, before.caret) : before.caret);
    const held = this.#engine.atoms;
    const result = step();
    if (this.#engine.atoms !== held) {
      write(this.#root, this.#engine.atoms);
      this.#options.onchange();
    }
    this.#place();
    this.#announce();
    return result;
  }

  /** Puts the browser's selection where the engine says. */
  #place() {
    const { atoms, places } = read(this.#root);
    const selection = window.getSelection();
    const mode = this.#engine.mode;
    if (mode === "visual" || mode === "line") {
      const [from, to] = this.#engine.selection;
      const [start, end] = [places[from], places[to]];
      if (start && end) selection?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    } else {
      const place = places[this.#engine.caret] ?? places.at(-1)!;
      selection?.collapse(place.node, place.offset);
    }
    if (mode === "insert") this.#roomAfterChip(atoms);
    this.#reveal();
  }

  /** A caret cannot rest after a chip that ends the box: it gets the same spacer a dropped chip comes with. */
  #roomAfterChip(atoms: readonly Atom<HTMLElement>[]) {
    if (this.#engine.caret !== atoms.length || typeof atoms.at(-1) === "string" || !atoms.length) return;
    const room = document.createTextNode(" ");
    this.#root.append(room);
    window.getSelection()?.collapse(room, 1);
  }

  #announce() {
    const mode = this.#engine.mode;
    if (mode !== this.#shownMode) this.#options.onmode((this.#shownMode = mode));
    this.#refresh();
  }

  #beforeInput = (event: InputEvent) => {
    if (this.#engine.mode !== "insert" && !ALLOWED_INPUT.test(event.inputType)) event.preventDefault();
  };

  #focused = () => {
    if (this.#leftWindow) {
      this.#leftWindow = false;
      return this.#refresh();
    }
    const { atoms } = read(this.#root);
    this.#engine.sync(atoms, this.#engine.caret);
    this.#engine.enter(atoms.length ? "normal" : "insert");
    this.#announce();
  };

  #blurred = () => {
    this.#leftWindow = !document.hasFocus();
    this.#options.oncaret(null);
  };

  #refresh = () => {
    this.#options.oncaret(this.#caretBox());
  };

  #caretIndex(reading: Reading) {
    const mode = this.#engine.mode;
    return mode === "normal" ? clampCaret(reading.atoms, reading.caret) : Math.min(this.#engine.caret, reading.atoms.length);
  }

  #caretBox(): CaretBox | null {
    if (this.#engine.mode === "insert" || document.activeElement !== this.#root) return null;
    const reading = read(this.#root);
    const client = this.#clientBox(reading, this.#caretIndex(reading));
    const box = this.#root.getBoundingClientRect();
    if (client.top + client.height <= box.top || client.top >= box.bottom) return null;
    const parent = this.#root.offsetParent;
    const origin = parent?.getBoundingClientRect();
    return { ...client, left: client.left - (origin?.left ?? 0) - (parent?.clientLeft ?? 0), top: client.top - (origin?.top ?? 0) - (parent?.clientTop ?? 0) };
  }

  #clientBox(reading: Reading, index: number): CaretBox {
    const style = getComputedStyle(this.#root);
    const fontSize = Number.parseFloat(style.fontSize);
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * FALLBACK_LINE_RATIO;
    const fallbackWidth = fontSize * FALLBACK_CHAR_RATIO;
    const atom = reading.atoms[index];
    const place = reading.places[index];
    const drawn = place && this.#placeRect(place, typeof atom === "string" ? atom.length : 1);
    if (drawn?.height) return { left: drawn.left, top: drawn.top, width: drawn.width || fallbackWidth, height: drawn.height };
    const box = this.#root.getBoundingClientRect();
    return { left: box.left, top: box.top, width: fallbackWidth, height: lineHeight };
  }

  /** A place is inside a text node, or names a chip or a `<br>` by its index; the end of an empty box names nothing. */
  #placeRect({ node, offset }: Place, length: number) {
    if (node.nodeType !== Node.TEXT_NODE) return (node.childNodes[offset] as Element | undefined)?.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + length);
    return [...range.getClientRects()].at(-1);
  }

  /** Scrolls the box just enough to keep the block caret in it. */
  #reveal() {
    const reading = read(this.#root);
    const client = this.#clientBox(reading, this.#caretIndex(reading));
    const box = this.#root.getBoundingClientRect();
    if (client.top < box.top) this.#root.scrollTop -= box.top - client.top;
    else if (client.top + client.height > box.bottom) this.#root.scrollTop += client.top + client.height - box.bottom;
  }
}

export const attach = (root: HTMLElement, options: VimOptions): VimLayer => new Layer(root, options);
