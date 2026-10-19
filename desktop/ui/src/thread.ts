import { follow, isOnline, send, transcript, type Transcript, type TranscriptTool } from "./api.ts";
import { compose, type Compose } from "./compose.ts";
import { clear, el, fresh, modelName, skeleton } from "./dom.ts";
import { icon } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { Question, SessionSummary } from "./types.ts";

export interface ThreadHandlers {
  /** Move this thread to the other pane. */
  readonly swap?: () => void;
  readonly close: () => void;
  /** The directory `@` mentions are resolved in. */
  readonly projectPath?: () => string | undefined;
}

export function thread(pane: HTMLElement, session: SessionSummary, handlers: ThreadHandlers): () => void {
  const id = session.sessionId;
  const log = el("div.tui", {}, skeleton("lines", 10));
  const stateTag = el("span.tag", {}, session.state);
  const modelTag = el("span.tag.model", { title: "the model answering this thread", hidden: !session.model }, modelName(session.model));
  const idButton = el(
    "button.iconbtn.slim.session-id",
    {
      title: `session ${session.sessionId}\nclick: copy the id`,
      onclick: () => {
        void navigator.clipboard?.writeText(session.sessionId);
        idButton.classList.add("copied");
        setTimeout(() => idButton.classList.remove("copied"), 1200);
      },
    },
    el("span.mono", {}, session.shortId),
    icon("copy", 11),
  );
  let adopted = session.kind !== "claude";
  const heading = el("h2.ellipsis", { title: session.title }, session.title || session.shortId);

  const scroll = () => (log.scrollTop = log.scrollHeight);

  const box: Compose = compose({
    placeholder: "Message… (@ mentions a file, paste an image)",
    mono: true,
    projectPath: handlers.projectPath,
    session: () => id,
    foot: () => session.project ?? (session.kind === "main" ? "workspace" : (session.cwd?.replace(/^.*\//, "") ?? "")),
    submit: async (text, images) => {
      log.querySelector(".hint")?.remove();
      log.append(fresh(userLine(text || "(image)")));
      scroll();
      // A thread nobody named takes its name from the first message, as the daemon does.
      if (heading.textContent === "new thread" && text) heading.textContent = text.replace(/\s+/g, " ").slice(0, 60);
      // A terminal conversation is resumed by the daemon on its first message from here.
      const body = { id, text, images, ...(adopted ? {} : { cwd: session.cwd, title: session.title }) };
      const result = await send("/send", body);
      if (result.error) box.note.textContent = result.error;
      else if (result.queued) box.note.textContent = "queued — sent when the daemon answers";
      else {
        box.note.textContent = "";
        adopted = true;
      }
    },
  });
  const note = box.note;

  clear(
    pane,
    el(
      "header.panel-head",
      {},
      icon(session.kind === "claude" ? "terminal" : session.kind === "code" ? "code" : "message", 14),
      heading,
      el("span.dim.ellipsis", { title: session.cwd ?? "" }, (session.project ?? session.cwd?.replace(/^.*\//, "") ?? "")),
      session.parent ? el("span.dim", { title: `started by session ${session.parent}` }, `↳ from ${session.parent.slice(0, 6)}`) : undefined,
      stateTag,
      modelTag,
      idButton,
      el("span.grow"),
      el("button.iconbtn", { title: "interrupt", onclick: () => void send("/stop", { id }) }, icon("stop", 14)),
      handlers.swap ? el("button.iconbtn", { title: "move to the other pane", onclick: handlers.swap }, icon("split", 14)) : undefined,
      el("button.iconbtn", { title: "close", onclick: handlers.close }, icon("x", 14)),
    ),
    log,
    box.node,
  );

  void (async () => {
    try {
      const history = await transcript(id, session.cwd);
      log.querySelector(":scope > .skeleton")?.remove();
      // Prepended: something may already have been typed while the transcript was on its way.
      log.prepend(...history.flatMap(render));
      if (!history.length && !log.childElementCount) log.append(el("p.hint", {}, "Nothing here yet."));
    } catch {
      log.querySelector(":scope > .skeleton")?.remove();
      if (!log.childElementCount) log.append(el("p.hint", {}, "No transcript cached for this thread yet."));
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

  const stop = follow(id, (event) => {
    const payload = event.payload as { text?: string; summary?: string; name?: string; id?: string; parent?: string; result?: string; questions?: Question[]; status?: string; level?: string; model?: string };
    switch (event.kind) {
      case "session.input":
        break;
      case "session.model":
        modelTag.textContent = modelName(payload.model);
        modelTag.hidden = !payload.model;
        break;
      case "session.delta":
        if (!liveText) {
          liveText = fresh(el("div.entry.assistant.live", {}, el("span.mark", {}, "⏺"), el("div.body")));
          log.append(liveText);
        }
        liveText.querySelector(".body")!.replaceChildren(markdown(payload.text ?? ""));
        stateTag.textContent = "busy";
        break;
      case "session.tool": {
        // A tool call closes the text entry before it; the next delta starts a fresh one.
        liveText = undefined;
        const entry = fresh(toolLine({ id: payload.id, name: payload.name ?? "tool", input: payload.summary }));
        entry.classList.add("live");
        if (payload.id) liveTools.set(payload.id, entry);
        // A subagent's calls sit under the Agent call that runs it.
        const host = payload.parent ? liveTools.get(payload.parent) : undefined;
        (host ?? log).append(entry);
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
      case "session.notice":
        // A slash command's output, or the loop's own notice (hook feedback, warnings).
        log.append(el("div.entry.notice", { class: `entry notice ${payload.level ?? ""}` }, el("span.mark", {}, payload.level === "output" ? "⏺" : "!"), el("pre.body", {}, payload.text ?? "")));
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
  }, { deltas: true, replay: false });
  return stop;
}

/** The compose box of a thread pane, for keyboard focus. */
export const composeOf = (pane: HTMLElement) => pane.querySelector<HTMLElement>(".tui-compose .input");

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
