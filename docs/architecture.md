# Architecture and rebuild plan

This supersedes the earlier VPS migration notes. It records what pai is, the decisions
behind it, and the order the rebuild happens in.

## The shape

One API, many thin clients. Every surface — Telegram, the web app, the CLI, the menu bar,
an editor extension — is a client of the same HTTP/WebSocket API. Anything that
reimplements what the API already does does not get built.

```
Telegram   ──┐
web app    ──┼──►  pai API  ──►  session manager  ──►  Claude Agent SDK
CLI        ──┤     (tailnet      (thread ↔ project      (resume, permissions)
editor ext ──┘      only)         ↔ cwd ↔ sessionId)
                                        │
                                   ~/dev/**  ── git ──►  GitHub
                                        │
                                   Storage Box (borg)
```

## Decisions

| Question | Answer | Because |
| --- | --- | --- |
| Host | Hetzner CX43 | 8 vCPU / 16 GB / 160 GB for ~€12/mo, ~10 ms from Prague. The GCP e2-micro it replaces has 0.95 GB and already swaps. |
| GCP | dropped | Free-tier e2-micro is the only cheap shape and it is too small; anything adequate costs several times Hetzner. |
| Remote access | Tailscale | `tailscale ssh`, port 22 closed, the API bound to the tailnet interface. Nothing public. |
| Ingress for the web app | Tailscale, not a public tunnel | The API is remote code execution by design. It gets an identity boundary, not a URL. |
| Terraform | after the box works | `cloud-init` plus a snapshot covers a single host. Terraform earns its place at several resources. |
| Backups | borg → Hetzner Storage Box | `pai.db`, `workspace/memory`, and project checkouts live on one disk today. |
| Linux CI | GitHub-hosted | Self-hosted runners would steal CPU from the sessions the box exists for. |
| Release flow | tag push, host pulls | `PAI_UPDATE_CHANNEL=tag`; nothing reaches into the host, so no deploy key is handed to CI. |
| Terminals | in the API | A PTY over WebSocket, rendered by xterm.js. This is how software gets installed on the box without SSH. |
| Desktop client | Tauri 2, the UI in plain TypeScript | A native webview around a ~100 KB bundle: it starts instantly, has only the six surfaces the work needs, and carries no extension ecosystem. The window is all it asks of Rust. |
| Offline | cache every read, queue every write | The app is local files, so it opens without the box; reads fall back to the last answer and writes wait in an outbox. Settings stay the daemon's, so clients cannot disagree. |
| Binding | the Tailscale address, automatically | The daemon finds its own 100.64/10 address and binds there, so other devices reach it with no tunnel and the internet still cannot. |
| Editor baseline | VS Code extension | Runs unmodified in desktop VS Code and in `code-server` in the browser. Webview panels mean no fork is needed for real UI. |
| Editor rich tier | the existing Zed fork | Already has the status bar, hooks and sidebar work. It extends the same API; it does not replace it. |
| Telegram baseline | stock Bot API | Everything the mockups showed — project chips, status lines, separators — is bold text, edited messages and glyphs. |
| Telegram rich tier | native iOS fork | Telegram-iOS is GPLv2 and forkable. It renders the metadata the stock client hides. |
| GPU rental | no | Inference is Anthropic-side; the box is a thin client. |

## Graceful degradation, both surfaces

The same rule holds for the chat client and the editor: **the stock app must be fully
usable, and the fork only adds rendering.**

For Telegram this means a message is plain text that reads correctly in any client, with
structured metadata carried in a trailer: an HTML anchor whose href is
`https://<host>/m/<base64url payload>` and whose text is a single marker glyph. A stock
client shows the message plus an unobtrusive link. The fork parses the payload, renders a
card — tool calls, diffs, token counts, project chips — and hides the trailer.

For the editor the same split: the extension speaks to the API and gets threads, sessions
and terminals in any VS Code; the Zed fork adds native panels on top of the same
endpoints.

## Rebuild plan

Nothing is patched in place. The daemon is restructured into layers with tests, the host
is rebuilt from cloud-init, and the old instance is deleted rather than left running.

### Phase 1 — the daemon, re-layered and tested

- `src/core` — config, logging, event bus, SQLite. No knowledge of clients.
- `src/domain` — projects, threads, sessions, memory. The model of the system.
- `src/api` — HTTP routes, the SSE event stream, the terminal WebSocket.
- `src/clients` — Telegram, dashboard push, CLI. Each one talks only to the API surface.
- `src/protocol` — the rich-message codec, shared by the daemon and every client.
- `src/host` — service installation and self-update.

Unit tests for every pure module; an end-to-end suite that boots a real daemon on a
scratch database and drives it over HTTP with a stub session backend, so the suite runs
without spending model tokens. One opt-in smoke test does a real turn.

### Phase 2 — terminals

A `POST /terminals` opens a PTY on the host, `GET /terminals/:id/stream` is the
WebSocket, and the web app renders it with xterm.js. Scoped to a project directory, with
a session-lifetime cap and scrollback kept server-side so a reconnect resumes.

### Phase 3 — the box

`infra/cloud-init.yaml` builds the host from nothing: users, Tailscale, Bun, Node, git,
the checkout, the systemd unit, borg. `infra/provision.ts` drives the hcloud API.
Cutover copies `.env`, `pai.db` and `workspace/memory`, then the GCP instance is deleted.

### Phase 4 — the clients

The web app gains the session views and the terminal. The VS Code extension follows:
`editor/vscode` is threads, projects and terminals as views over the same endpoints. It is
served by the daemon itself, through code-server on port 8788, so the editor is a URL on the
tailnet rather than something installed on a laptop, and an update of the daemon is an update
of the editor — the fallback surface for a machine with nothing installed.

The desktop app (`desktop/`) is the client the work actually happens in: a Tauri window over
the same API, with threads grouped by project, a thread's conversation from its transcript, a
file tree and viewer, a terminal and the daemon's settings. The Telegram fork is last, and
only once the protocol has been in use long enough to be stable.
