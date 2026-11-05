/** A buffer of atoms: a string is one character (`"\n"` breaks the line), anything else is a chip, one solid character. */
export type Atom<Chip> = string | Chip;
export type VimMode = "normal" | "insert" | "visual" | "line";

type MotionKind = "exclusive" | "inclusive" | "linewise";
type Motion = { readonly to: number; readonly kind: MotionKind; readonly from?: number };
type Operator = "d" | "c" | "y";
type FindKey = "f" | "t" | "F" | "T";
type Waiting = "g" | FindKey | "r" | "i" | "a";
type CharClass = "space" | "word" | "punct" | "chip";
interface Snapshot<Chip> {
  readonly atoms: readonly Atom<Chip>[];
  readonly caret: number;
}

const NEWLINE = "\n";
const WORD = /[\p{L}\p{N}\p{M}_]/u;
const OPERATORS = "dcy";
const FINDS = "ftFT";
const OBJECTS = "ia";
const SHORTHANDS: Readonly<Record<string, readonly [Operator, string]>> = { x: ["d", "l"], X: ["d", "h"], D: ["d", "$"], C: ["c", "$"], s: ["c", "l"], Y: ["y", "y"], S: ["c", "c"] };

const classOf = <Chip>(atom: Atom<Chip>): CharClass => (typeof atom !== "string" ? "chip" : !atom.trim() ? "space" : WORD.test(atom) ? "word" : "punct");
// `lastIndexOf` reads a negative start as counted from the end, so the first position needs no search.
const lineStart = <Chip>(atoms: readonly Atom<Chip>[], at: number) => (at <= 0 ? 0 : atoms.lastIndexOf(NEWLINE, at - 1) + 1);
const lineEnd = <Chip>(atoms: readonly Atom<Chip>[], at: number) => {
  const found = atoms.indexOf(NEWLINE, at);
  return found < 0 ? atoms.length : found;
};

/** Where a caret may stand outside insert mode: on a character, never past the last one of its line. */
export function clampCaret<Chip>(atoms: readonly Atom<Chip>[], at: number) {
  const within = Math.max(0, Math.min(at, atoms.length));
  return Math.max(lineStart(atoms, within), Math.min(within, lineEnd(atoms, within) - 1));
}

/**
 * Vim's keys over a list of atoms: no DOM, so whoever holds the text hands it over with `sync` and shows the result.
 * Undo is its own stack and holds the atoms themselves, so a chip comes back as the same object. A change made from
 * outside shows up at the next `sync` as one undo step; everything typed in one insert session is one step too.
 */
export class VimEngine<Chip> {
  #atoms: readonly Atom<Chip>[] = [];
  #caret = 0;
  #anchor = 0;
  #mode: VimMode = "insert";
  #register: { readonly atoms: readonly Atom<Chip>[]; readonly linewise: boolean } | undefined;
  #undo: Snapshot<Chip>[] = [];
  #redo: Snapshot<Chip>[] = [];
  #sessionSaved = false;
  #count = 0;
  #operatorCount = 0;
  #operator: Operator | undefined;
  #waiting: Waiting | undefined;
  #lastFind: { readonly key: FindKey; readonly target: string } | undefined;
  #goal: number | undefined;
  readonly #clone: (chip: Chip) => Chip;

  constructor(clone: (chip: Chip) => Chip) {
    this.#clone = clone;
  }

  get atoms() {
    return this.#atoms;
  }
  get caret() {
    return this.#caret;
  }
  get mode() {
    return this.#mode;
  }
  /** The next key is a character to look for or to write, not a command: `f`, `t`, `r` and their kin. */
  get awaitsCharacter() {
    return this.#waiting !== undefined && this.#waiting !== "g" && !OBJECTS.includes(this.#waiting);
  }
  /** The atoms a visual selection covers, end exclusive. */
  get selection(): readonly [number, number] {
    const [low, high] = [Math.min(this.#anchor, this.#caret), Math.max(this.#anchor, this.#caret)];
    if (this.#mode !== "line") return [low, Math.min(high + 1, this.#atoms.length)];
    return [lineStart(this.#atoms, low), Math.min(lineEnd(this.#atoms, high) + 1, this.#atoms.length)];
  }

  /** Takes the box as it is now. Anything that differs from what the engine last left is a change from outside. */
  sync(atoms: readonly Atom<Chip>[], caret: number) {
    const changed = atoms.length !== this.#atoms.length || atoms.some((atom, i) => atom !== this.#atoms[i]);
    if (changed) {
      if (this.#mode !== "insert" || !this.#sessionSaved) this.#save();
      this.#sessionSaved = this.#mode === "insert";
      this.#redo = [];
      this.#atoms = atoms;
    }
    if (this.#mode === "normal" || this.#mode === "insert") this.#caret = caret;
    else this.#caret = clampCaret(atoms, this.#caret);
  }

  enter(mode: VimMode) {
    if (mode === "insert") this.#sessionSaved = false;
    else this.#caret = clampCaret(this.#atoms, this.#caret);
    this.#mode = mode;
    this.#clearPending();
  }

  /** Text that undo starts from: nothing before it to go back to. */
  load(atoms: readonly Atom<Chip>[]) {
    this.#atoms = atoms;
    this.#caret = 0;
    this.#undo = [];
    this.#redo = [];
    this.enter(atoms.length ? "normal" : "insert");
  }

  /** Esc: true when it did something here, false when it is the host's to use. */
  escape() {
    if (this.#mode === "insert") {
      const stepBack = this.#caret > lineStart(this.#atoms, this.#caret);
      this.#caret -= stepBack ? 1 : 0;
      this.enter("normal");
      return true;
    }
    if (this.#mode !== "normal") {
      this.enter("normal");
      return true;
    }
    const pending = Boolean(this.#operator || this.#waiting || this.#count);
    this.#clearPending();
    return pending;
  }

  redo() {
    this.#step(this.#redo, this.#undo);
    this.#clearPending();
  }

  /** One key outside insert mode. */
  press(key: string) {
    if (this.#waiting) return this.#answerWait(key);
    if (/[1-9]/.test(key) || (key === "0" && this.#count)) {
      this.#count = this.#count * 10 + Number(key);
      return;
    }
    if (key !== "j" && key !== "k") this.#goal = undefined;
    const visual = this.#mode !== "normal";
    const shorthand = SHORTHANDS[key];
    if (OPERATORS.includes(key)) return this.#pressOperator(key as Operator, visual);
    if (shorthand && !this.#operator) return visual ? this.#applyToSelection(shorthand[0]) : this.#pressShorthand(shorthand);
    if (OBJECTS.includes(key) && (this.#operator || visual)) return void (this.#waiting = key as Waiting);
    if (key === "g" || FINDS.includes(key) || (key === "r" && !this.#operator && !visual)) return void (this.#waiting = key as Waiting);

    const motion = this.#motion(key);
    if (motion) return this.#land(motion);
    if (this.#operator) return this.#clearPending();
    if (visual) this.#pressVisual(key);
    else this.#pressNormal(key);
    this.#clearPending();
  }

  get #total() {
    return Math.max(this.#operatorCount, 1) * Math.max(this.#count, 1);
  }
  get #counted() {
    return this.#operatorCount > 0 || this.#count > 0;
  }

  #clearPending() {
    this.#count = 0;
    this.#operatorCount = 0;
    this.#operator = undefined;
    this.#waiting = undefined;
  }
  #save() {
    this.#undo.push({ atoms: this.#atoms, caret: this.#caret });
    this.#redo = [];
  }
  #step(from: Snapshot<Chip>[], to: Snapshot<Chip>[]) {
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push({ atoms: this.#atoms, caret: this.#caret });
    this.#atoms = snapshot.atoms;
    this.#caret = clampCaret(snapshot.atoms, snapshot.caret);
    this.#goal = undefined;
  }

  #pressOperator(key: Operator, visual: boolean) {
    if (visual) return this.#applyToSelection(key);
    if (this.#operator === key) return this.#applyLines();
    if (this.#operator) return this.#clearPending();
    this.#operator = key;
    this.#operatorCount = this.#count;
    this.#count = 0;
  }

  #pressShorthand([operator, motion]: readonly [Operator, string]) {
    this.#operatorCount = this.#count;
    this.#count = 0;
    this.#operator = operator;
    this.press(motion);
  }

  #pressNormal(key: string) {
    const atoms = this.#atoms;
    const caret = this.#caret;
    const start = lineStart(atoms, caret);
    const end = lineEnd(atoms, caret);
    if (key === "i") this.#beginInsert(caret);
    else if (key === "a") this.#beginInsert(Math.min(caret + 1, end));
    else if (key === "I") this.#beginInsert(this.#firstBlank(start));
    else if (key === "A") this.#beginInsert(end);
    else if (key === "o") this.#openLine(end, end + 1);
    else if (key === "O") this.#openLine(start, start);
    else if (key === "p" || key === "P") this.#put(key === "p");
    else if (key === "u") for (let n = this.#total; n > 0; n--) this.#step(this.#undo, this.#redo);
    else if (key === "v" || key === "V") {
      this.#anchor = caret;
      this.enter(key === "v" ? "visual" : "line");
    }
  }

  #pressVisual(key: string) {
    if (key === "o") [this.#anchor, this.#caret] = [this.#caret, this.#anchor];
    else if (key === "v" || key === "V") this.enter((key === "v") === (this.#mode === "visual") ? "normal" : key === "v" ? "visual" : "line");
  }

  #beginInsert(at: number) {
    this.#caret = at;
    this.enter("insert");
  }

  #openLine(at: number, caret: number) {
    this.#save();
    this.#atoms = [...this.#atoms.slice(0, at), NEWLINE, ...this.#atoms.slice(at)];
    this.#caret = caret;
    this.enter("insert");
    this.#sessionSaved = true;
  }

  #firstBlank(start: number) {
    let at = start;
    while (at < this.#atoms.length && this.#atoms[at] !== NEWLINE && classOf(this.#atoms[at]!) === "space") at++;
    return at;
  }

  #answerWait(key: string) {
    const waiting = this.#waiting!;
    this.#waiting = undefined;
    this.#goal = undefined;
    if (waiting === "r") return this.#replace(key);
    if (waiting === "i" || waiting === "a") return this.#object(waiting === "a", key);
    if (waiting === "g") {
      if (key === "g") return this.#land({ to: this.#lineFrom(0, this.#counted ? this.#total - 1 : 0), kind: "linewise" });
      return this.#clearPending();
    }
    this.#lastFind = { key: waiting, target: key };
    const to = this.#find(waiting, key, false);
    if (to === undefined) return this.#clearPending();
    this.#land({ to, kind: waiting === "F" || waiting === "T" ? "exclusive" : "inclusive" });
  }

  #replace(key: string) {
    const end = this.#caret + this.#total;
    if (key.length > 1 || end > lineEnd(this.#atoms, this.#caret) || this.#caret >= this.#atoms.length) return this.#clearPending();
    this.#save();
    this.#atoms = this.#atoms.map((atom, i) => (i >= this.#caret && i < end ? key : atom));
    this.#caret = end - 1;
    this.#clearPending();
  }

  #object(around: boolean, key: string) {
    if (key !== "w" || this.#atoms[this.#caret] === undefined || this.#atoms[this.#caret] === NEWLINE) return this.#clearPending();
    const { from, to } = this.#wordObject(around);
    if (this.#mode === "normal") return this.#land({ from, to, kind: "exclusive" });
    this.#anchor = from;
    this.#caret = to - 1;
    this.#clearPending();
  }

  #wordObject(around: boolean) {
    const atoms = this.#atoms;
    const same = (at: number, cls: CharClass) => at >= 0 && at < atoms.length && atoms[at] !== NEWLINE && classOf(atoms[at]!) === cls;
    const cls = classOf(atoms[this.#caret]!);
    let from = this.#caret;
    let to = this.#caret + 1;
    if (cls !== "chip") {
      while (same(from - 1, cls)) from--;
      while (same(to, cls)) to++;
    }
    if (!around) return { from, to };
    const after = to;
    while (same(to, "space")) to++;
    if (to === after) while (same(from - 1, "space")) from--;
    return { from, to };
  }

  #motion(key: string): Motion | undefined {
    const atoms = this.#atoms;
    const at = this.#caret;
    const n = this.#total;
    const pending = Boolean(this.#operator);
    const start = lineStart(atoms, at);
    const end = lineEnd(atoms, at);
    if (key === "h") return { to: Math.max(start, at - n), kind: "exclusive" };
    if (key === "l") return { to: Math.min(at + n, pending ? end : Math.max(start, end - 1)), kind: "exclusive" };
    if (key === "0") return { to: start, kind: "exclusive" };
    if (key === "^") return { to: this.#firstBlank(start), kind: "exclusive" };
    if (key === "$") return { to: Math.max(start, lineEnd(atoms, this.#lineFrom(at, n - 1)) - 1), kind: "inclusive" };
    if (key === "j" || key === "k") return this.#vertical(key === "j" ? n : -n);
    if (key === "G") return { to: this.#lineFrom(0, this.#counted ? n - 1 : atoms.length), kind: "linewise" };
    if (key === "w") return this.#wordMotion(n);
    if (key === "e") return { to: this.#repeat(at, n, (i) => this.#wordEnd(i)), kind: "inclusive" };
    if (key === "b") return { to: this.#repeat(at, n, (i) => this.#wordBack(i)), kind: "exclusive" };
    if ((key === ";" || key === ",") && this.#lastFind) return this.#repeatFind(key === ",");
    return undefined;
  }

  #repeat(from: number, times: number, step: (at: number) => number) {
    let at = from;
    for (let n = 0; n < times; n++) at = step(at);
    return at;
  }

  #repeatFind(reverse: boolean): Motion | undefined {
    const { key, target } = this.#lastFind!;
    const flipped: Readonly<Record<FindKey, FindKey>> = { f: "F", F: "f", t: "T", T: "t" };
    const direction = reverse ? flipped[key] : key;
    const to = this.#find(direction, target, true);
    return to === undefined ? undefined : { to, kind: direction === "F" || direction === "T" ? "exclusive" : "inclusive" };
  }

  #find(key: FindKey, target: string, repeated: boolean) {
    const atoms = this.#atoms;
    const forward = key === "f" || key === "t";
    const short = key === "t" || key === "T";
    const direction = forward ? 1 : -1;
    const [low, high] = [lineStart(atoms, this.#caret), lineEnd(atoms, this.#caret)];
    // A repeated `t` already stands next to its target: it has to look past it or it would never move.
    let at = this.#caret + direction * (short && repeated ? 2 : 1);
    for (let left = this.#total; at >= low && at < high; at += direction) {
      if (atoms[at] === target && --left === 0) return short ? at - direction : at;
    }
    return undefined;
  }

  #vertical(lines: number): Motion | undefined {
    const atoms = this.#atoms;
    const start = lineStart(atoms, this.#caret);
    const target = this.#lineFrom(this.#caret, lines);
    if (target === start && lines !== 0) {
      if (this.#operator) return undefined;
      return { to: this.#caret, kind: "linewise" };
    }
    this.#goal ??= this.#caret - start;
    const keep = this.#goal;
    return { to: Math.min(target + keep, Math.max(target, lineEnd(atoms, target) - 1)), kind: "linewise" };
  }

  /** The start of the line `lines` away from `at`, stopping at the first or last line. */
  #lineFrom(at: number, lines: number) {
    const atoms = this.#atoms;
    let start = lineStart(atoms, at);
    for (let n = lines; n > 0; n--) {
      const end = lineEnd(atoms, start);
      if (end >= atoms.length) break;
      start = end + 1;
    }
    for (let n = lines; n < 0 && start > 0; n++) start = lineStart(atoms, start - 1);
    return start;
  }

  #wordMotion(times: number): Motion {
    const atoms = this.#atoms;
    const at = this.#caret;
    // `cw` on a word stops at its end instead of eating the space, the one motion Vim bends for an operator.
    if (this.#operator === "c" && atoms[at] !== undefined && classOf(atoms[at]!) !== "space") {
      return { to: this.#repeat(at - 1, times, (i) => this.#wordEnd(i)), kind: "inclusive" };
    }
    const to = this.#repeat(at, times, (i) => this.#wordForward(i));
    // A word motion under an operator ends with the line it started the last word on, joining nothing.
    if (this.#operator && to > lineEnd(atoms, at)) {
      return { to: lineEnd(atoms, this.#repeat(at, times - 1, (i) => this.#wordForward(i))), kind: "exclusive" };
    }
    return { to, kind: "exclusive" };
  }

  #wordForward(from: number) {
    const atoms = this.#atoms;
    const cls = from < atoms.length ? classOf(atoms[from]!) : "space";
    let at = from;
    if (cls !== "space") {
      at++;
      if (cls !== "chip") while (at < atoms.length && atoms[at] !== NEWLINE && classOf(atoms[at]!) === cls) at++;
    }
    while (at < atoms.length && classOf(atoms[at]!) === "space") {
      // An empty line counts as a word.
      if (atoms[at] === NEWLINE && atoms[at - 1] === NEWLINE && at > from) break;
      at++;
    }
    return at;
  }

  #wordEnd(from: number) {
    const atoms = this.#atoms;
    let at = from + 1;
    while (at < atoms.length && classOf(atoms[at]!) === "space") at++;
    if (at >= atoms.length) return Math.max(atoms.length - 1, 0);
    const cls = classOf(atoms[at]!);
    if (cls !== "chip") while (at + 1 < atoms.length && atoms[at + 1] !== NEWLINE && classOf(atoms[at + 1]!) === cls) at++;
    return at;
  }

  #wordBack(from: number) {
    const atoms = this.#atoms;
    let at = from - 1;
    while (at > 0 && classOf(atoms[at]!) === "space") {
      if (atoms[at] === NEWLINE && atoms[at - 1] === NEWLINE) return at;
      at--;
    }
    if (at <= 0) return 0;
    const cls = classOf(atoms[at]!);
    if (cls !== "chip") while (at > 0 && atoms[at - 1] !== NEWLINE && classOf(atoms[at - 1]!) === cls) at--;
    return at;
  }

  /** A motion finished: an operator takes it, otherwise the caret goes there. */
  #land(motion: Motion) {
    const operator = this.#operator;
    if (operator) {
      const origin = motion.from ?? this.#caret;
      const [low, high] = [Math.min(origin, motion.to), Math.max(origin, motion.to)];
      if (motion.kind === "linewise") this.#applyLineRange(operator, low, high);
      // An inclusive motion takes its last character, never the break of an empty line it stands on.
      else this.#apply(operator, low, motion.kind === "inclusive" ? Math.min(high + 1, lineEnd(this.#atoms, high)) : high, false);
    } else {
      this.#caret = clampCaret(this.#atoms, motion.to);
    }
    this.#clearPending();
  }

  #applyLines() {
    const low = lineStart(this.#atoms, this.#caret);
    this.#applyLineRange(this.#operator!, low, this.#lineFrom(low, this.#total - 1));
    this.#clearPending();
  }

  #applyToSelection(operator: Operator) {
    const linewise = this.#mode === "line";
    const [from, to] = this.selection;
    if (linewise) this.#applyLineRange(operator, from, Math.max(from, to - 1));
    else this.#apply(operator, from, to, false);
    if (operator !== "c") this.enter("normal");
    this.#clearPending();
  }

  /** Whole lines from the one holding `low` through the one holding `high`. */
  #applyLineRange(operator: Operator, low: number, high: number) {
    const atoms = this.#atoms;
    const start = lineStart(atoms, low);
    const end = lineEnd(atoms, high);
    // `cc` keeps the line itself; `dd` takes its break too, the one before it when it is the last line.
    if (operator === "c") return this.#apply(operator, start, end, true);
    if (operator === "y") return this.#apply(operator, start, end, true);
    if (!atoms.length) return;
    this.#register = { atoms: atoms.slice(start, end), linewise: true };
    this.#save();
    const from = end >= atoms.length ? Math.max(start - 1, 0) : start;
    const to = end >= atoms.length ? end : end + 1;
    this.#atoms = [...atoms.slice(0, from), ...atoms.slice(to)];
    this.#caret = clampCaret(this.#atoms, end >= atoms.length ? lineStart(this.#atoms, from) : from);
  }

  #apply(operator: Operator, from: number, to: number, linewise: boolean) {
    const empty = from >= to;
    if (empty && operator !== "c") return;
    if (!empty || linewise) this.#register = { atoms: this.#atoms.slice(from, to), linewise };
    if (operator === "y") {
      this.#caret = clampCaret(this.#atoms, from);
      if (this.#mode !== "normal") this.enter("normal");
      return;
    }
    if (!empty) this.#save();
    this.#atoms = [...this.#atoms.slice(0, from), ...this.#atoms.slice(to)];
    this.#caret = operator === "c" ? from : clampCaret(this.#atoms, from);
    if (operator === "c") {
      this.enter("insert");
      this.#sessionSaved = !empty;
    }
  }

  #put(after: boolean) {
    const register = this.#register;
    if (!register) return;
    const copies = Array.from({ length: this.#total }, () => register.atoms.map((atom) => (typeof atom === "string" ? atom : this.#clone(atom))));
    this.#save();
    const atoms = this.#atoms;
    if (register.linewise) {
      const lines = copies.flatMap((copy, i) => (i ? [NEWLINE, ...copy] : copy));
      if (after) {
        const end = lineEnd(atoms, this.#caret);
        this.#atoms = [...atoms.slice(0, end), NEWLINE, ...lines, ...atoms.slice(end)];
        this.#caret = end + 1;
      } else {
        const start = lineStart(atoms, this.#caret);
        this.#atoms = [...atoms.slice(0, start), ...lines, NEWLINE, ...atoms.slice(start)];
        this.#caret = start;
      }
      return;
    }
    const flat = copies.flat();
    const onChar = this.#caret < atoms.length && atoms[this.#caret] !== NEWLINE;
    const at = after && onChar ? this.#caret + 1 : this.#caret;
    this.#atoms = [...atoms.slice(0, at), ...flat, ...atoms.slice(at)];
    this.#caret = at + flat.length - 1;
  }
}
