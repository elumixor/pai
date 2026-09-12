import * as vscode from "vscode";
import { follow, history, type PaiEvent, post, type SessionSummary } from "./api.ts";

const panels = new Map<string, vscode.WebviewPanel>();

/** A thread is one webview: its event history, the live stream, a compose box and the question buttons. */
export function openThread(session: SessionSummary) {
  const existing = panels.get(session.shortId);
  if (existing) return existing.reveal();

  const panel = vscode.window.createWebviewPanel(
    "pai.thread",
    session.title || session.shortId,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panels.set(session.shortId, panel);
  panel.webview.html = html(session);

  const abort = new AbortController();
  panel.onDidDispose(() => {
    abort.abort();
    panels.delete(session.shortId);
  });

  panel.webview.onDidReceiveMessage(async (message: { type: string; text?: string }) => {
    try {
      if (message.type === "send" && message.text) await post("/send", { id: session.shortId, text: message.text });
      if (message.type === "answer" && message.text) await post("/answer", { id: session.shortId, text: message.text });
      if (message.type === "interrupt") await post("/stop", { id: session.shortId });
    } catch (err) {
      vscode.window.showErrorMessage(`pai: ${(err as Error).message}`);
    }
  });

  void stream(panel, session.shortId, abort.signal);
  return panel;
}

async function stream(panel: vscode.WebviewPanel, session: string, signal: AbortSignal) {
  try {
    for (const event of await history(session)) void panel.webview.postMessage(event);
    for await (const event of follow(session, signal)) void panel.webview.postMessage(event);
  } catch (err) {
    if (!signal.aborted) void panel.webview.postMessage({ kind: "client.error", ts: Date.now(), payload: { text: (err as Error).message } });
  }
}

export function eventText(event: PaiEvent) {
  const { text, summary, name } = event.payload as { text?: string; summary?: string; name?: string };
  return text ?? summary ?? name ?? JSON.stringify(event.payload);
}

function html(session: SessionSummary) {
  return /* html */ `
<style>
  body { font-family: var(--vscode-font-family); padding: 0 12px 88px; }
  .event { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .event time { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .kind { color: var(--vscode-textLink-foreground); min-width: 86px; }
  .text { white-space: pre-wrap; flex: 1; }
  .text.error { color: var(--vscode-errorForeground); }
  form { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 6px; padding: 10px 12px;
         background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
  input { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); }
  button { padding: 6px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; cursor: pointer; }
  #questions { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0; }
</style>
<h3>${session.title || session.shortId}${session.project ? ` · ${session.project}` : ""}</h3>
<div id="questions"></div>
<div id="events"></div>
<form id="compose">
  <input id="text" placeholder="message ${session.title || session.shortId}…" autofocus />
  <button type="submit">Send</button>
  <button type="button" id="interrupt">Interrupt</button>
</form>
<script>
  const vscode = acquireVsCodeApi();
  const events = document.getElementById("events");
  const questions = document.getElementById("questions");

  document.getElementById("compose").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("text");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    vscode.postMessage({ type: "send", text });
  });
  document.getElementById("interrupt").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));

  addEventListener("message", ({ data: event }) => {
    if (event.kind === "session.question") return ask(event.payload.questions ?? []);
    if (event.kind === "session.turn_end") questions.replaceChildren();
    const row = document.createElement("div");
    row.className = "event";
    row.innerHTML =
      '<time>' + new Date(event.ts).toLocaleTimeString() + '</time>' +
      '<span class="kind">' + event.kind.replace("session.", "") + '</span>' +
      '<span class="text"></span>';
    const payload = event.payload ?? {};
    row.lastElementChild.textContent = payload.text ?? payload.summary ?? payload.name ?? JSON.stringify(payload);
    if (payload.isError || event.kind === "client.error") row.lastElementChild.classList.add("error");
    events.append(row);
    scrollTo(0, document.body.scrollHeight);
  });

  function ask(list) {
    questions.replaceChildren();
    for (const question of list) {
      const label = document.createElement("div");
      label.textContent = question.question;
      questions.append(label);
      for (const option of question.options ?? []) {
        const button = document.createElement("button");
        button.textContent = option.label ?? option;
        button.onclick = () => vscode.postMessage({ type: "answer", text: button.textContent });
        questions.append(button);
      }
    }
  }
</script>`;
}
