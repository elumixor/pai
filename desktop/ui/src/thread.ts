import { follow, isOnline, send, transcript, type Transcript } from "./api.ts";
import { ago, clear, el } from "./dom.ts";
import type { PaiEvent, SessionSummary } from "./types.ts";

/**
 * A thread, the way `claude --resume` shows one: the conversation from the transcript on
 * disk, then whatever arrives while it is open. Sending a message is the same turn a
 * Telegram message or `pai send` would be.
 */
export function thread(pane: HTMLElement, session: SessionSummary): () => void {
  const messages = el("div.messages");
  const input = el("textarea", { rows: 2, placeholder: `message ${session.title || session.shortId}…` }) as HTMLTextAreaElement;
  const note = el("span.note");

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    messages.append(bubble({ role: "user", ts: new Date().toISOString(), text }));
    messages.scrollTop = messages.scrollHeight;
    const { queued } = await send("/send", { id: session.shortId, text });
    note.textContent = queued ? "queued — will be sent when the daemon answers" : "";
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  clear(
    pane,
    el(
      "header.pane-head",
      {},
      el("h2", {}, session.title || session.shortId),
      el("span.dim", {}, [session.kind === "main" ? "main" : session.project, session.state].filter(Boolean).join(" · ")),
      el("span.grow"),
      el("button.action", { onclick: () => void send("/stop", { id: session.shortId }) }, "Interrupt"),
    ),
    messages,
    el(
      "footer.compose",
      {},
      input,
      el("button.action.primary", { onclick: () => void submit() }, "Send"),
      note,
    ),
  );

  void (async () => {
    try {
      for (const message of await transcript(session.shortId)) messages.append(bubble(message));
    } catch {
      messages.append(el("p.empty", {}, "No transcript cached for this thread yet."));
    }
    if (!isOnline()) note.textContent = "offline — showing the last transcript this app saw";
    messages.scrollTop = messages.scrollHeight;
  })();

  // Live turns arrive as events; the transcript on disk catches up when the thread is reopened.
  return follow(session.shortId, (event) => {
    const line = liveLine(event);
    if (!line) return;
    messages.append(line);
    messages.scrollTop = messages.scrollHeight;
  });
}

function bubble(message: Transcript) {
  const tools = message.tools?.length
    ? el(
        "div.tools",
        {},
        ...message.tools.map((tool) => el("div.tool", {}, el("span.name", {}, tool.name), el("span.dim", {}, tool.input ?? ""))),
      )
    : undefined;
  return el(
    `div.message.${message.role}${message.meta ? ".meta" : ""}`,
    {},
    el("div.meta-row", {}, el("span.who", {}, message.role), el("time", {}, ago(message.ts))),
    message.text ? el("div.text", {}, message.text) : undefined,
    tools,
  );
}

function liveLine(event: PaiEvent) {
  const payload = event.payload as { text?: string; summary?: string; name?: string };
  if (event.kind === "session.tool")
    return el("div.message.assistant.live", {}, el("div.tools", {}, el("div.tool", {}, el("span.name", {}, payload.name ?? "tool"), el("span.dim", {}, payload.summary ?? ""))));
  if (event.kind === "session.text" || event.kind === "session.turn_end")
    return payload.text ? el("div.message.assistant.live", {}, el("div.text", {}, payload.text)) : undefined;
  return undefined;
}
