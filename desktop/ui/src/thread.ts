import { commands as listCommands, fileIndex, follow, isOnline, send, transcript, type Transcript, type TranscriptTool } from "./api.ts";
import { clear, el, modelName } from "./dom.ts";
import { icon } from "./icons.ts";
import { markdown } from "./markdown.ts";
import type { PaiEvent, Question, SessionSummary, SlashCommand } from "./types.ts";

export interface ThreadHandlers {
  /** Move this thread to the other pane. */
  readonly swap?: () => void;
  readonly close: () => void;
  /** The directory `@` mentions are resolved in. */
  readonly projectPath?: () => string | undefined;
}

interface Attachment {
  readonly media_type: string;
  readonly data: string;
  readonly preview: string;
}

/** A pasted image as the base64 the API takes, plus a data URL for the chip. */
const readImage = (file: File) =>
  new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ media_type: file.type, data: url.slice(url.indexOf(",") + 1), preview: url });
    };
    reader.readAsDataURL(file);
  });

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
  const input = el("textarea", { rows: 1, placeholder: "Message… (@ mentions a file, paste an image)", spellcheck: false }) as HTMLTextAreaElement;
  const note = el("span.note");
  const chips = el("div.chips.attachments");
  const attachments: Attachment[] = [];
  const drawChips = () =>
    clear(chips, ...attachments.map((a, i) => el("span.chip.image", {}, el("img", { src: a.preview, alt: "" }), el("button.iconbtn", { title: "remove", onclick: () => (attachments.splice(i, 1), drawChips()) }, icon("x", 11)))));
  input.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) attachments.push(await readImage(file));
    drawChips();
  });

  // One popup for both `@file` and `/command`: what it lists and what it inserts differ, the keys do not.
  interface Suggestion {
    readonly label: string;
    readonly hint?: string;
    readonly insert: string;
  }
  const mentions = el("div.mentions", { hidden: true });
  let index: string[] | undefined;
  let slash: SlashCommand[] | undefined;
  let menuStart = -1;
  let shown: Suggestion[] = [];
  const closeMenu = () => {
    mentions.setAttribute("hidden", "");
    menuStart = -1;
    shown = [];
  };
  const pick = (item: Suggestion) => {
    input.value = `${input.value.slice(0, menuStart)}${item.insert}${input.value.slice(input.selectionStart)}`;
    closeMenu();
    input.focus();
    input.selectionStart = input.selectionEnd = menuStart + item.insert.length;
    grow();
  };
  const showMenu = (items: Suggestion[]) => {
    shown = items;
    if (!items.length) return closeMenu();
    clear(
      mentions,
      ...items.map((item, i) =>
        el("button.mention", { class: `mention${i === 0 ? " active" : ""}`, onmousedown: (e: Event) => (e.preventDefault(), pick(item)) }, el("span.label", {}, item.label), item.hint ? el("span.dim.ellipsis", {}, item.hint) : undefined),
      ),
    );
    mentions.removeAttribute("hidden");
  };
  const showFiles = async (query: string) => {
    const root = handlers.projectPath?.();
    if (!root) return closeMenu();
    index ??= await fileIndex(root).catch(() => []);
    const q = query.toLowerCase();
    showMenu(index.filter((f) => f.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ label: f, insert: `@${root}/${f} ` })));
  };
  // The commands are the process's own: skills, plugins, and Claude Code's built-ins that make sense off a terminal.
  const showCommands = async (query: string) => {
    slash ??= await listCommands(id).catch(() => []);
    const q = query.toLowerCase();
    showMenu(
      slash
        .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 10)
        .map((c) => ({ label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`, hint: c.description, insert: `/${c.name} ` })),
    );
  };
  input.addEventListener("input", () => {
    const before = input.value.slice(0, input.selectionStart);
    const at = before.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\s/.test(before.slice(at + 1))) {
      menuStart = at;
      return void showFiles(before.slice(at + 1));
    }
    if (before.startsWith("/") && !/\s/.test(before)) {
      menuStart = 0;
      return void showCommands(before.slice(1));
    }
    closeMenu();
  });
  const stateTag = el("span.tag", {}, session.state);
  const modelTag = el("span.tag.model", { title: "the model answering this thread" }, modelName(session.model));
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
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    input.value = "";
    grow();
    closeMenu();
    const images = attachments.splice(0).map(({ media_type, data }) => ({ media_type, data }));
    drawChips();
    log.querySelector(".hint")?.remove();
    log.append(userLine(text || "(image)"));
    scroll();
    // A thread nobody named takes its name from the first message, as the daemon does.
    if (heading.textContent === "new thread" && text) heading.textContent = text.replace(/\s+/g, " ").slice(0, 60);
    // A terminal conversation is resumed by the daemon on its first message from here.
    const body = { id, text, images, ...(adopted ? {} : { cwd: session.cwd, title: session.title }) };
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
    if (menuStart >= 0 && shown.length) {
      const rows = [...mentions.querySelectorAll<HTMLElement>(".mention")];
      const active = Math.max(0, rows.findIndex((r) => r.classList.contains("active")));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (active + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        rows.forEach((r, i) => r.classList.toggle("active", i === next));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (shown[active]) pick(shown[active]);
        return;
      }
      if (event.key === "Escape") return closeMenu();
    }
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
    el("footer.compose.tui-compose", {}, mentions, chips, el("div.compose-row", {}, el("span.prompt-char", {}, "❯"), input), el("div.compose-foot", {}, el("span.dim", {}, session.project ?? (session.kind === "main" ? "workspace" : session.cwd?.replace(/^.*\//, "") ?? "")), el("span.grow"), note, el("span.dim", {}, "enter to send · shift+enter newline"))),
  );

  void (async () => {
    try {
      const history = await transcript(id, session.cwd);
      // Prepended: something may already have been typed while the transcript was on its way.
      log.prepend(...history.flatMap(render));
      if (!history.length && !log.childElementCount) log.append(el("p.hint", {}, "Nothing here yet."));
    } catch {
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
export const composeOf = (pane: HTMLElement) => pane.querySelector<HTMLTextAreaElement>(".tui-compose textarea");

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
