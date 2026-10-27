import { api } from "../api";
import type { LogMessage, PaiEvent, Question, Upload } from "../types";
import { live } from "./live.svelte";
import { notices } from "./notices.svelte";

const PAGE = 80;
const PAI = "pai";

export interface LiveTool {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  done: boolean;
}

export interface PendingQuestion {
  readonly id: string;
  readonly questions: readonly Question[];
}

/**
 * One chat: the message log for an agent (pai's is the user's one chat), plus — for the session behind it — the
 * turn in progress: the reply as it streams, the tool calls it is making, and an `AskUserQuestion` waiting.
 */
export class Conversation {
  messages = $state<LogMessage[]>([]);
  loaded = $state(false);
  hasOlder = $state(true);
  streaming = $state("");
  tools = $state<LiveTool[]>([]);
  working = $state(false);
  question = $state<PendingQuestion | null>(null);
  #session = $state<string | null>(null);

  /** The session behind this chat, once known: what an `AskUserQuestion` is answered on. */
  get sessionId() {
    return this.#session;
  }
  #unsubscribe: (() => void)[] = [];

  constructor(readonly agent: string) {}

  async open() {
    live.start();
    this.#unsubscribe.push(live.on((event) => this.#onEvent(event)), live.onReconnect(() => void this.refresh()));
    await this.refresh();
  }

  close() {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
  }

  async refresh() {
    try {
      const [messages, session] = await Promise.all([
        api.messages(this.agent, { limit: PAGE }),
        this.agent === PAI ? api.pai().then((p) => p.session) : Promise.resolve(null),
      ]);
      this.messages = messages;
      this.hasOlder = messages.length === PAGE;
      if (session) {
        this.#session = session.sessionId;
        this.working = session.state === "busy";
      }
    } catch (error) {
      notices.error(error);
    } finally {
      this.loaded = true;
    }
  }

  async loadOlder() {
    const first = this.messages[0];
    if (!first || !this.hasOlder) return;
    try {
      const older = await api.messages(this.agent, { before: first.id, limit: PAGE });
      this.hasOlder = older.length === PAGE;
      this.messages = [...older, ...this.messages];
    } catch (error) {
      notices.error(error);
    }
  }

  async send(text: string, images: readonly Upload[]) {
    try {
      if (this.agent === PAI) {
        const session = await api.sendPai(text, images);
        this.#session = session.sessionId;
      } else {
        await api.messageAgent(this.agent, text, images);
      }
      this.working = true;
      return true;
    } catch (error) {
      notices.error(error);
      return false;
    }
  }

  #belongs(message: LogMessage) {
    if (this.agent === PAI) return message.from === PAI || message.to === PAI || message.meta.agent === PAI || ["ask", "answer"].includes(message.kind);
    return message.from === this.agent || message.to === this.agent || message.meta.agent === this.agent;
  }

  #onEvent(event: PaiEvent) {
    if (event.kind === "message.new" || event.kind === "message.updated") {
      const message = event.payload as unknown as LogMessage;
      if (!this.#belongs(message)) return;
      const at = this.messages.findIndex((m) => m.id === message.id);
      this.messages = at === -1 ? [...this.messages, message] : this.messages.with(at, message);
      return;
    }
    if (!this.#session || event.sessionId !== this.#session) return;
    switch (event.kind) {
      case "session.input":
        this.working = true;
        break;
      case "session.delta":
        this.working = true;
        this.streaming = String(event.payload.turn ?? event.payload.text ?? "");
        break;
      case "session.tool":
        this.tools = [...this.tools, { id: String(event.payload.id), name: String(event.payload.name), summary: String(event.payload.summary ?? ""), done: false }];
        break;
      case "session.tool_result":
        this.tools = this.tools.map((t) => (t.id === event.payload.id ? { ...t, done: true } : t));
        break;
      case "session.question":
        this.question = { id: String(event.payload.id), questions: event.payload.questions as Question[] };
        break;
      case "session.answer":
        this.question = null;
        break;
      case "session.turn_end":
      case "session.error":
      case "session.exit":
        this.working = false;
        this.streaming = "";
        this.tools = [];
        break;
    }
  }
}
