import { api, type ChatConfidence } from "../api";
import type { Effort } from "../types";

export type NewKind = "detached" | "dev" | "goal" | "private";
const WAIT_MS = 400;
const MIN_CHARS = 8;

/** A chat not started yet: what is typed, and its choices. Jev fills each until the user sets that one himself. */
class NewChat {
  kind = $state<NewKind | undefined>();
  project = $state<string | undefined>();
  model = $state("opus");
  effort = $state<Effort>("medium");
  dirty = $state(false);
  failed = $state(false);
  confidence = $state<ChatConfidence | undefined>();
  private chosen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private asked = 0;

  reset() {
    clearTimeout(this.timer);
    this.asked++;
    this.chosen.clear();
    this.kind = this.project = undefined;
    this.model = "opus";
    this.effort = "medium";
    this.dirty = false;
    this.failed = false;
    this.confidence = undefined;
  }

  isChosen = (key: string) => this.chosen.has(key);

  /** Back to nothing suggested, keeping what the user set himself. */
  private forget() {
    clearTimeout(this.timer);
    this.asked++;
    this.failed = false;
    this.confidence = undefined;
    if (!this.chosen.has("kind")) this.kind = undefined;
    if (!this.chosen.has("project")) this.project = undefined;
    if (!this.chosen.has("model")) this.model = "opus";
    if (!this.chosen.has("effort")) this.effort = "medium";
  }

  choose(changes: { kind?: NewKind; project?: string; model?: string | null; effort?: Effort | null }) {
    for (const key of Object.keys(changes)) this.chosen.add(key);
    if (changes.kind) this.kind = changes.kind;
    if (changes.project !== undefined) this.project = changes.project;
    if (changes.model) this.model = changes.model;
    if (changes.effort) this.effort = changes.effort;
  }

  typed(text: string, attached: boolean) {
    this.dirty = Boolean(text || attached);
    if (text.length < MIN_CHARS) return this.forget();
    clearTimeout(this.timer);
    this.asked++;
    this.timer = setTimeout(() => void this.suggest(text), WAIT_MS);
  }

  /** Asks Jev now; an answer overtaken by newer typing is dropped. */
  async suggest(text: string) {
    clearTimeout(this.timer);
    const asked = ++this.asked;
    const { data } = await api.suggestChat(text);
    if (asked !== this.asked) return;
    this.failed = !data;
    if (!data) return;
    this.confidence = data.confidence;
    if (!this.chosen.has("kind")) this.kind = data.kind;
    if (!this.chosen.has("project")) this.project = data.project;
    if (!this.chosen.has("model")) this.model = data.model;
    if (!this.chosen.has("effort")) this.effort = data.effort;
  }
}

export const newChat = new NewChat();
