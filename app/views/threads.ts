import { ago, clear, el, json, post } from "../dom.ts";
import type { PaiEvent, SessionSummary } from "../types.ts";

let stream: EventSource | undefined;

function dotClass(session: SessionSummary) {
  if (session.waiting) return "dot waiting";
  if (session.state === "busy" || session.state === "starting") return "dot busy";
  if (session.state === "idle") return "dot idle";
  return "dot dead";
}

function line(event: PaiEvent) {
  const text = typeof event.payload.text === "string" ? event.payload.text : JSON.stringify(event.payload);
  return el(
    "div.event",
    {},
    el("time", {}, new Date(event.ts).toLocaleTimeString()),
    el("span.kind", {}, event.kind.replace("session.", "")),
    el("span.grow", {}, text.slice(0, 400)),
  );
}

export async function threads(side: HTMLElement, pane: HTMLElement) {
  const { live, recent } = await json<{ live: SessionSummary[]; recent: SessionSummary[] }>("/tasks");
  const sessions = [...live, ...recent.filter((r) => !live.some((l) => l.shortId === r.shortId))];

  const show = async (session: SessionSummary) => {
    stream?.close();
    const events = el("div.stream");
    const input = el("input", { type: "text", placeholder: `message ${session.title || session.shortId}…` });
    const form = el(
      "form.compose",
      {
        onsubmit: async (event: Event) => {
          event.preventDefault();
          const text = (input as HTMLInputElement).value.trim();
          if (!text) return;
          (input as HTMLInputElement).value = "";
          await post("/send", { id: session.shortId, text });
        },
      },
      input,
      el("button.action", { type: "submit" }, "Send"),
      el("button.action", { type: "button", onclick: () => post("/stop", { id: session.shortId }) }, "Interrupt"),
    );

    clear(
      pane,
      el("h3", {}, `${session.title || session.shortId} · ${session.state}${session.project ? ` · ${session.project}` : ""}`),
      form,
      events,
    );

    for (const event of await json<PaiEvent[]>(`/events?session=${session.shortId}`)) events.append(line(event));
    events.scrollTop = events.scrollHeight;

    stream = new EventSource(`/events?follow=1&session=${session.shortId}`);
    stream.addEventListener("message", (message) => {
      events.append(line(JSON.parse(message.data) as PaiEvent));
      events.scrollTop = events.scrollHeight;
    });
  };

  clear(
    side,
    el("h2", {}, "Sessions"),
    ...sessions.map((session) =>
      el(
        "button.row",
        { onclick: () => void show(session) },
        el("span", { class: dotClass(session) }),
        el("span.grow", {}, session.title || session.shortId),
        el("span.dim", {}, session.kind === "main" ? "main" : (session.project ?? "")),
      ),
    ),
  );

  if (sessions[0]) await show(sessions[0]);
  else clear(pane, el("p.empty", {}, "No sessions yet. Message the bot, or start a task."));
}

export function stopThreads() {
  stream?.close();
  stream = undefined;
}
