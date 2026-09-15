import { follow, isOnline, send, transcript, type Transcript, type TranscriptTool } from "./api.ts";
import { clear, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { PaiEvent, Question, SessionSummary } from "./types.ts";

export interface ThreadHandlers {
  /** Move this thread to the other pane. */
  readonly swap?: () => void;
  readonly close: () => void;
}

/**
 * A thread, drawn the way the terminal draws it: `❯` before what you typed, `⏺` before
 * each thing the model said or did, `⎿` under a tool call for what came back. The history
 * is the transcript on disk — the same file `claude --resume` reads — and the rest streams
 * in as it happens. A conversation started in a terminal is taken over by the daemon the
 * first time a message is sent to it here.
 */
export function thread(pane: HTMLElement, session: SessionSummary, handlers: ThreadHandlers): () => void {
  const id = session.sessionId;
  const log = el("div.tui");
  const input = el("textarea", { rows: 1, placeholder: "Message… (enter sends)" }) as HTMLTextAreaElement;
  const note = el("span.note");
  const stateTag = el("span.tag", {}, session.state);
  let adopted = session.kind !== "claude";

  const scroll = () => (log.scrollTop = log.scrollHeight);
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    log.append(userLine(text));
    scroll();
    // A terminal conversation is resumed by the daemon on its first message from here.
    const body = adopted ? { id, text } : { id, text, cwd: session.cwd, title: session.title };
    const result = await send("/send", body);
    if (result.error) note.textContent = result.error;
    else if (result.queued) note.textContent = "queued — sent when the daemon answers";
    else {
      note.textContent = "";
      adopted = true;
    }
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
      icon(session.kind === "main" ? "bot" : session.kind === "claude" ? "terminal" : "message", 14),
      el("h2.ellipsis", { title: session.title }, session.title || session.shortId),
      el("span.dim.ellipsis", { title: session.cwd ?? "" }, session.kind === "main" ? "main" : (session.project ?? session.cwd?.replace(/^.*\//, "") ?? "")),
      stateTag,
      el("span.grow"),
      el("button.iconbtn", { title: "interrupt", onclick: () => void send("/stop", { id }) }, icon("stop", 14)),
      handlers.swap ? el("button.iconbtn", { title: "move to the other pane", onclick: handlers.swap }, icon("split", 14)) : undefined,
      el("button.iconbtn", { title: "close", onclick: handlers.close }, icon("x", 14)),
    ),
    log,
    el("footer.compose.tui-compose", {}, el("span.prompt-char", {}, "❯"), input, el("button.iconbtn.send", { title: "send (enter)", onclick: () => void submit() }, icon("send", 15)), note),
  );

  void (async () => {
    try {
      const history = await transcript(id, session.cwd);
      clear(log, ...history.flatMap(render));
      if (!history.length) log.append(el("p.hint", {}, "Nothing here yet."));
    } catch {
      log.append(el("p.hint", {}, "No transcript cached for this thread yet."));
    }
    if (!isOnline()) note.textContent = "offline — showing the last transcript this app saw";
    scroll();
  })();

  // What the model is doing right now: a text entry that grows with the stream, tool entries
  // that get their result when it comes back, a question with its buttons.
  let liveText: HTMLElement | undefined;
  const liveTools = new Map<string, HTMLElement>();
  const finishLive = () => {
    liveText?.classList.remove("live");
    liveText = undefined;
    for (const tool of liveTools.values()) tool.classList.remove("live");
    liveTools.clear();
  };

  return follow(id, (event) => {
    const payload = event.payload as { text?: string; summary?: string; name?: string; id?: string; result?: string; questions?: Question[]; status?: string };
    switch (event.kind) {
      case "session.input":
        break;
      case "session.delta":
        if (!liveText) {
          liveText = el("div.entry.assistant.live", {}, el("span.mark", {}, "⏺"), el("div.body"));
          log.append(liveText);
        }
        liveText.querySelector(".body")!.replaceChildren(markdown(payload.text ?? ""));
        stateTag.textContent = "busy";
        break;
      case "session.tool": {
        // A tool call closes the text entry before it; the next delta starts a fresh one.
        liveText = undefined;
        const entry = toolLine({ id: payload.id, name: payload.name ?? "tool", input: payload.summary });
        entry.classList.add("live");
        if (payload.id) liveTools.set(payload.id, entry);
        log.append(entry);
        break;
      }
      case "session.tool_result": {
        const entry = payload.id ? liveTools.get(payload.id) : undefined;
        if (entry) {
          entry.classList.remove("live");
          entry.append(resultLine(payload.result ?? ""));
        }
        break;
      }
      case "session.text":
        break;
      case "session.question":
        log.append(questionBox(id, payload.id ?? "", payload.questions ?? []));
        stateTag.textContent = "waiting";
        break;
      case "session.answer":
        log.querySelector(".question")?.remove();
        break;
      case "session.status":
        stateTag.textContent = payload.status ?? "busy";
        break;
      case "session.turn_end":
        finishLive();
        stateTag.textContent = "idle";
        break;
      case "session.exit":
        finishLive();
        stateTag.textContent = "detached";
        break;
      default:
        return;
    }
    scroll();
  });
}

function userLine(text: string) {
  return el("div.entry.user", {}, el("span.mark", {}, "❯"), el("div.body", {}, text));
}

/** `⏺ Bash(ls -la)` — the tool and the gist of its input, the result folded under it. */
function toolLine(tool: TranscriptTool) {
  const name = tool.name.replace(/^mcp__/, "").replace(/__/g, ":");
  const input = (tool.input ?? "").replace(/^\$ /, "");
  const node = el(
    "div.entry.tool",
    {},
    el("span.mark", {}, "⏺"),
    el("div.body", {}, el("span.tool-name", {}, name), input ? el("span.tool-args", {}, `(${input})`) : undefined),
  );
  if (tool.result !== undefined) node.append(resultLine(tool.result));
  return node;
}

function resultLine(result: string) {
  return el("div.result", {}, el("span.mark", {}, "⎿"), el("pre.body", {}, result || "(no output)"));
}

/** One transcript message becomes one entry per thing in it, in the order the terminal shows them. */
function render(message: Transcript): HTMLElement[] {
  if (message.role === "user") {
    if (message.meta) return [el("div.entry.meta", { title: message.text }, el("span.mark", {}, "·"), el("div.body.ellipsis", {}, message.text.replace(/\s+/g, " ").slice(0, 120)))];
    return message.text ? [userLine(message.text)] : [];
  }
  const out: HTMLElement[] = [];
  if (message.text) out.push(el("div.entry.assistant", {}, el("span.mark", {}, "⏺"), el("div.body", {}, markdown(message.text))));
  for (const tool of message.tools ?? []) out.push(toolLine(tool));
  return out;
}

/** The pending AskUserQuestion: one answer per question, sent as the session expects it. */
function questionBox(session: string, id: string, questions: Question[]) {
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
