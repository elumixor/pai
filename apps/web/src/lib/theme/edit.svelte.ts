import { theme } from "../theme.svelte";
import type { ElementId, TokenId } from "./catalog";
import type { CustomTheme, ElementStyle } from "./custom";

/** Dragging a colour is one change, not a hundred: edits to one field this close together undo as one. */
const COALESCE_MS = 600;

function without<T extends object>(from: T, key: keyof T): T {
  const { [key]: _gone, ...rest } = from;
  return rest as T;
}

/** One sitting in the editor: changes save as they are made, and can be taken back until it is left. */
export class ThemeEdit {
  readonly id: string;
  #past = $state<readonly CustomTheme[]>([]);
  #future = $state<readonly CustomTheme[]>([]);
  #lastField = "";
  #lastAt = 0;

  constructor(id: string) {
    this.id = id;
  }

  get theme() {
    return theme.find(this.id);
  }
  get canUndo() {
    return this.#past.length > 0;
  }
  get canRedo() {
    return this.#future.length > 0;
  }

  rename(name: string) {
    this.#change("name", (current) => ({ ...current, name }));
  }

  setToken(id: TokenId, value: string | undefined) {
    this.#change(`token:${id}`, (current) => ({ ...current, tokens: value === undefined ? without(current.tokens, id) : { ...current.tokens, [id]: value } }));
  }

  setElement<P extends keyof ElementStyle>(id: ElementId, prop: P, value: ElementStyle[P] | undefined) {
    this.#change(`element:${id}:${prop}`, (current) => {
      const style = current.elements[id] ?? {};
      const next = value === undefined ? without(style, prop) : { ...style, [prop]: value };
      return { ...current, elements: Object.keys(next).length ? { ...current.elements, [id]: next } : without(current.elements, id) };
    });
  }

  resetElement(id: ElementId) {
    this.#change(`reset:${id}`, (current) => ({ ...current, elements: without(current.elements, id) }));
  }

  resetAll() {
    this.#change("reset", (current) => ({ ...current, tokens: {}, elements: {} }));
  }

  undo() {
    const previous = this.#past.at(-1);
    const current = this.theme;
    if (!previous || !current) return;
    this.#past = this.#past.slice(0, -1);
    this.#future = [...this.#future, current];
    this.#lastField = "";
    theme.update(previous);
  }

  redo() {
    const next = this.#future.at(-1);
    const current = this.theme;
    if (!next || !current) return;
    this.#future = this.#future.slice(0, -1);
    this.#past = [...this.#past, current];
    this.#lastField = "";
    theme.update(next);
  }

  #change(field: string, change: (current: CustomTheme) => CustomTheme) {
    const current = this.theme;
    if (!current) return;
    const now = Date.now();
    if (field !== this.#lastField || now - this.#lastAt > COALESCE_MS) this.#past = [...this.#past, current];
    this.#future = [];
    this.#lastField = field;
    this.#lastAt = now;
    theme.update(change(current));
  }
}
