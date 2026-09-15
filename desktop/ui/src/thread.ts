import { follow, isOnline, send, transcript, type Transcript } from "./api.ts";
import { ago, clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { PaiEvent, Question, SessionSummary } from "./types.ts";

export interface ThreadHandlers {
  /** Move this thread to the other pane. */
  readonly swap?: () => void;
  readonly close: () => void;
}

/**
 * A thread, the way `claude --resume` shows one: the conversation from the transcript on
 * disk, then whatever arrives while it is open — text as it streams, tool calls as chips,
 * a question as buttons. Sending a message is the same turn a Telegram message would be.
 */
export function thread(pane: HTMLElement, session: SessionSummary, handlers: ThreadHandlers): () => void {
  const messages = el("div.messages");
  const input = el("textarea", { rows: 1, placeholder: `Message ${session.title || session.shortId}…` }) as HTMLTextAreaElement;
  const note = el("span.note");
  const stateTag = el("span.tag", {}, session.state);

  const scroll = () => (messages.scrollTop = messages.scrollHeight);
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    messages.append(bubble({ role: "user", ts: new Date().toISOString(), text }));
    scroll();
    const { queued } = await send("/send", { id: session.shortId, text });
    note.textContent = queued ? "queued — sent when the daemon answers" : "";
  };

  input.addEventListener("input", grow);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  clear(
    pane,
    el(
      "header.panel-head",
      {},
      icon(session.kind === "main" ? "bot" : "message", 14),
      el("h2.ellipsis", { title: session.title }, session.title || session.shortId),
      el("span.dim", {}, session.kind === "main" ? "main" : (session.project ?? "")),
      stateTag,
      el("span.grow"),
      el("button.iconbtn", { title: "interrupt", onclick: () => void send("/stop", { id: session.shortId }) }, icon("stop", 14)),
      handlers.swap ? el("button.iconbtn", { title: "move to the other pane", onclick: handlers.swap }, icon("split", 14)) : undefined,
      el("button.iconbtn", { title: "close", onclick: handlers.close }, icon("x", 14)),
    ),
    messages,
    el("footer.compose", {}, input, el("button.iconbtn.send", { title: "send (enter)", onclick: () => void submit() }, icon("send", 15)), note),
  );

  void (async () => {
    try {
      const history = await transcript(session.shortId);
      clear(messages, ...history.map(bubble));
      if (!history.length) messages.append(el("div.empty", {}, el("p", {}, "Nothing here yet.")));
    } catch {
      messages.append(el("div.empty", {}, el("p", {}, "No transcript cached for this thread yet.")));
    }
    if (!isOnline()) note.textContent = "offline — showing the last transcript this app saw";
    scroll();
  })();

  // What the model is saying right now, replaced as the stream grows and dropped when the turn ends.
  let live: HTMLElement | undefined;
  let liveText: HTMLElement | undefined;
  let liveTools: HTMLElement | undefined;
  const ensureLive = () => {
    if (live) return;
    liveTools = el("div.tools");
    liveText = el("div.text");
    live = el("div.message.assistant.live", {}, el("div.meta-row", {}, el("span.who", {}, "pai"), el("span.typing", {}, "…")), liveTools, liveText);
    messages.append(live);
  };
  const dropLive = () => {
    live?.remove();
    live = liveText = liveTools = undefined;
  };

  return follow(session.shortId, (event) => {
    const payload = event.payload as { text?: string; summary?: string; name?: string; id?: string; questions?: Question[]; status?: string };
    switch (event.kind) {
      case "session.input":
        // Sent from somewhere else — Telegram, the CLI, another window; our own is already shown.
        break;
      case "session.delta":
        ensureLive();
        liveText!.replaceChildren(markdown(payload.text ?? ""));
        stateTag.textContent = "busy";
        break;
      case "session.tool":
        ensureLive();
        liveTools!.append(el("div.tool", {}, el("span.name", {}, payload.name ?? "tool"), el("span.dim.ellipsis", {}, payload.summary ?? "")));
        break;
      case "session.text":
        // A block is complete; the delta has already shown it, the turn end replaces everything.
        break;
      case "session.question":
        ensureLive();
        live!.append(questionBox(session.shortId, payload.id ?? "", payload.questions ?? []));
        stateTag.textContent = "waiting";
        break;
      case "session.answer":
        live?.querySelector(".question")?.remove();
        break;
      case "session.status":
        stateTag.textContent = payload.status ?? "busy";
        break;
      case "session.turn_end": {
        const tools = [...(liveTools?.children ?? [])].map((tool) => ({ name: tool.querySelector(".name")?.textContent ?? "", input: tool.querySelector(".dim")?.textContent ?? "" }));
        dropLive();
        if (payload.text || tools.length) messages.append(bubble({ role: "assistant", ts: new Date().toISOString(), text: payload.text ?? "", tools }));
        stateTag.textContent = "idle";
        break;
      }
      case "session.exit":
        stateTag.textContent = "detached";
        break;
      default:
        return;
    }
    scroll();
  });
}

function bubble(message: Transcript) {
  const tools = message.tools?.length
    ? el("div.tools", {}, ...message.tools.map((tool) => el("div.tool", {}, el("span.name", {}, tool.name), el("span.dim.ellipsis", {}, tool.input ?? ""))))
    : undefined;
  return el(
    `div.message.${message.role}${message.meta ? ".meta" : ""}`,
    {},
    el("div.meta-row", {}, el("span.who", {}, message.role === "user" ? "you" : "pai"), el("time", {}, ago(message.ts))),
    tools,
    message.text ? el("div.text", {}, markdown(message.text)) : undefined,
  );
}

/** The pending AskUserQuestion: one answer per question, sent as the session expects it. */
function questionBox(session: string, id: string, questions: Question[]) {
  const answers: Record<string, string> = {};
  const box = el("div.question");
  const render = (index: number) => {
    const q = questions[index];
    if (!q) {
      clear(box, el("p.dim", {}, "answered"));
      return;
    }
    clear(
      box,
      el("p.q-head", {}, q.header),
      el("p.q-text", {}, q.question),
      el(
        "div.q-options",
        {},
        ...q.options.map((option) =>
          el(
            "button.btn",
            {
              title: option.description,
              onclick: async () => {
                answers[q.question] = option.label;
                await send("/answer", { id: session, text: option.label });
                render(index + 1);
              },
            },
            option.label,
          ),
        ),
      ),
    );
  };
  render(0);
  return box;
}
