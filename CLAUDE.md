# pai

Personal assistant over Telegram. A message in the root chat is a turn in the main Claude
Code session; a message in a topic is a turn in that topic's task session. Tasks are started
by the main session (`start_task` tool), by `/new <title>`, or by the user creating a topic.

## Feedback loop

Never test through Telegram. The CLI drives the identical code path.

```sh
bun run src/clients/cli.ts daemon [-f]             # detached; -f/--foreground = attached, verbose, telegram off
bun run src/clients/cli.ts chat "<text>"           # a main-conversation turn, waits for the reply
bun run src/clients/cli.ts task "<title>" "<text>" [--project <slug>]
bun run src/clients/cli.ts send <id> "<text>" [--wait]
bun run src/clients/cli.ts answer <id|main> "<text>"   # answer a pending AskUserQuestion
bun run src/clients/cli.ts tasks
bun run src/clients/cli.ts stop <id|main> [--kill]
bun run src/clients/cli.ts tail [id] [--raw]
bun run src/clients/cli.ts events [id]
bun run src/clients/cli.ts projects
bun run src/clients/cli.ts cost                    # Hetzner spend per month (HCLOUD_TOKEN in .env)
bun run src/clients/cli.ts memory [query]
bun run src/clients/cli.ts update [--check] [--force]  # pull, reinstall, rebuild menubar, restart
```

`--json` on any command. Session ids in full or as the 6-char short form. After
`install`, `pai <command>` is the same thing.

## How sessions work

`src/session.ts` wraps one Agent SDK `query()` in streaming-input mode: an inbox of
`SDKUserMessage`s is fed to the process, messages come back as SDK events and are turned
into bus events (`session.delta`, `session.text`, `session.tool`, `session.turn_end`,
`session.question`, …). `inject()` appends context with `shouldQuery: false`, which is how
task results reach the main conversation without a model call.

`prewarm()` keeps one initialised `task` process ready via `startup()`; a new task adopts it and its session id, so first replies take ~1s instead of ~30s. A dead process is revived with `resume` (`sessions.ensureLive()`); the transcript lives in
`~/.claude/projects`. `settingSources: ["project"]` keeps the user's global hooks and
plugins out of assistant sessions; claude.ai connectors still load.

Long-term memory (`src/memory.ts`) is one markdown file per fact under `workspace/memory/`,
frontmatter for name/type/description. Every session gets `remember` / `recall` / `forget`;
the index goes into the system prompt, so a memory change re-warms the task process. Saves
from tasks are injected into the main conversation.

`AskUserQuestion` reaches `canUseTool` even under `bypassPermissions`. It becomes a
`session.question` event; Telegram renders buttons, the CLI has `answer`.

## Layout

- `src/core/` — `config.ts`, `log.ts`, `bus.ts`, `db.ts`. Configuration is read once, at import.
- `src/domain/session.ts` — one SDK session, the event mapping, questions.
- `src/domain/sessions.ts` — registry, main session (`kv.main_session`), tasks, revival, reaper, task→main relay.
- `src/domain/memory.ts` — long-term memory files, index, search.
- `src/domain/terminal.ts`, `terminals.ts`, `pty-host.mjs` — PTYs on the host. node-pty only loads under Node, so each terminal is a small Node process the daemon talks to in JSON lines.
- `src/domain/tools.ts` — the in-process `pai` MCP server, one instance per session (bound through a ref, since warm processes exist before their session).
- `src/domain/browser.ts` — one Playwright MCP server per daemon over HTTP; sessions connect instead of spawning `npx`.
- `src/domain/prompts.ts` — instructions appended to the Claude Code system prompt, per session kind.
- `src/domain/catalog.ts` — coding projects under `~/dev`; `projects.json` overrides.
- `src/api/` — `server.ts` (transport, the terminal websocket, the app), `routes.ts`, `events.ts` (SSE), `port.ts`, `app.ts`.
- `src/clients/telegram.ts` — grammY frontend: routing by topic / reply, draft streaming, live cards, question keyboards, attachments.
- `src/clients/tg-user.ts` — the user's own Telegram account (gramjs, `TELEGRAM_USER_SESSION`) as the `tg` MCP server.
- `src/clients/cli.ts` — the CLI over the HTTP API.
- `src/protocol/rich.ts` — metadata trailer: plain text for stock clients, structured for ours.
- `src/host/` — `update.ts` and the launchd/systemd installers.
- `editor/vscode/` — the VS Code extension (threads, projects, terminals over the API). `bun run editor` builds it, installs it into code-server and serves the browser editor on 8788 (`PAI_EDITOR_PORT`, `PAI_EDITOR_BIND`, `PAI_EDITOR_PASSWORD`).
- `app/` — the web app (sessions, terminals) built to `app/dist` and served at `/app`.
- `infra/` — `provision.ts` (Hetzner), `cloud-init.yaml`, `bootstrap.ts`, borg backup.
- `menubar/main.swift` — menu bar status app; compiled and loaded by `install` on macOS.
- `workspace/` — the assistant's cwd; `CLAUDE.md` there is the persona, `inbox/` gets attachments.

## Tests

`bun run test` runs every `*.test.ts` in its own process (`scripts/test.ts`), because
configuration is frozen at import. Unit suites cover the protocol, memory, the catalog and
terminals; `test/api.e2e.test.ts` boots the real server on a scratch database and drives it
over HTTP, including a websocket terminal. No test spends model tokens.

## Not done yet

- Permission prompts: sessions run under `bypassPermissions`, so `canUseTool` only carries `AskUserQuestion`.
- Concurrency is unbounded and there is no usage readout.
- Project routing is explicit only — no `@project` prefix, no inference.
- The Telegram fork is designed but not built; the VS Code extension is unpublished and untested inside a real editor host.
- Documents other than images are saved to `inbox/` and mentioned by path only.
