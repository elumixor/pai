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
bun run desktop [--build|--install]                # the desktop app (dev, a .app/.dmg, or /Applications)
bun run src/clients/cli.ts sync [device id]        # file sync between machines; with an id, pair
bun run src/clients/cli.ts status                  # version, address, public URL, editor, sync
bun run src/clients/cli.ts settings [KEY=value …]  # read or change data/config.json; a change needs restart
bun run src/clients/cli.ts restart
bun run dev                                        # the client in a browser, rebuilt on save (port 5180)
bun run install [--no-app]                         # bundles, the service, `pai` on PATH, the Mac app in /Applications
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
- `src/api/` — `server.ts` (transport, the terminal websocket, the client), `routes.ts`, `events.ts` (SSE), `port.ts`, `app.ts` (serves the client at `/ui`), `auth.ts` (`PAI_TOKEN` for programs, a signed session cookie for browsers; loopback and the bundles are exempt), `google.ts` (Sign in with Google: `PAI_GOOGLE_CLIENT_ID/SECRET` in `.env`, `PAI_GOOGLE_ALLOWED` emails; `/auth/check` is Caddy's forward_auth for the editor).
- `src/domain/publish.ts` — `PAI_PUBLIC=1` runs Caddy as a child: https on 80/443 for `PAI_DOMAIN` or `<ip>.sslip.io`, `/` the client, `/editor` code-server; opens the Hetzner firewall itself. Only with a token or Google sign-in configured.
- `src/domain/sync.ts` — Syncthing as a child of the daemon: `devRoot` and `~/.claude/projects` shared with `PAI_SYNC_PEER`. `pai sync [device id]`.
- `src/clients/telegram.ts` — grammY frontend: routing by topic / reply, draft streaming, live cards, question keyboards, attachments.
- `src/clients/tg-user.ts` — the user's own Telegram account (gramjs, `TELEGRAM_USER_SESSION`) as the `tg` MCP server.
- `src/clients/cli.ts` — the CLI over the HTTP API.
- `src/domain/transcript.ts` — a thread's conversation read from `~/.claude/projects` (`GET /transcript`).
- `src/domain/settings.ts` — the editable settings in `data/config.json`, merged over the environment at import (`GET`/`PATCH /settings`; a change needs a restart).
- `src/protocol/rich.ts` — metadata trailer: plain text for stock clients, structured for ours.
- `src/host/` — `update.ts` and the launchd/systemd installers.
- `src/domain/editor.ts` — code-server on 8788, a supervised child of the daemon: builds `editor/vscode`, copies it into the extensions directory and registers it. `PAI_NO_EDITOR`, `PAI_EDITOR_PORT`, `PAI_EDITOR_BIND`, `PAI_EDITOR_PASSWORD`.
- `editor/vscode/` — the VS Code extension: threads, projects and terminals over the API. `bun run editor` serves it without the daemon.
- `desktop/` — the Tauri desktop app: `ui/` is the whole client — files, a viewer, a terminal dock, two thread panes, projects with their threads, dashboard and settings — with an offline cache and an outbox; `src-tauri/` is an empty Rust shell. `bun run dev` for the loop, `bun run desktop` for the window, `bun run desktop:build` for the bundle.
- `src/domain/usage.ts` — the Claude subscription's windows (`GET /usage`) with the Claude Code login on the machine, plus what the sessions cost.
- `src/modules/` — the module registry (`index.ts`): each module = tools for sessions + a prompt paragraph + bus events + settings, described for the dashboard (`GET /modules`). Built-ins are described there; `linkedin.ts` is the first real one (Voyager API with `li_at`/`JSESSIONID` cookies, `linkedin.message` events, `linkedin_*` tools).
- `src/domain/automations.ts` — `on <event> → notify | turn | task`, rows in the `automations` table, run from the bus; tasks capped at 6/h. `GET/POST/PATCH/DELETE /automations`.
- `src/domain/diagnostics.ts` — `GET /diagnostics?path=` runs tsc on the project around a file (cached a minute per project); the client's editor shows them inline.
- `src/domain/context.ts` — what each session kind is given (instructions, memories, skills, tools) with the surfaces that see it, for the dashboard's context view (`GET /context`).
- Projects are repos under `devRoot` or **contexts**: `workspace/projects/<slug>/` with a `CLAUDE.md` (voice, rules) and project-scoped memories (`project:` in the frontmatter, `remember` with `scope: "project"`). `POST /projects {name, about}` creates one; a task in it runs with that directory as cwd.
- `infra/` — `provision.ts` (Hetzner), `cloud-init.yaml`, `bootstrap.ts`, borg backup, `gateway.ts` (Caddy for a domain of your own, needs root), `firewall.ts` (open ports on the Hetzner firewall).
- `menubar/main.swift` — menu bar status app: pai tasks plus the Claude quota rings (session and model-scoped weekly, token read from the Claude Code keychain item); compiled and loaded by `install` on macOS.
- `workspace/` — the assistant's cwd; `CLAUDE.md` there is the persona, `inbox/` gets attachments.

## Releasing

A `v*` tag (`npm version <bump> && git push --follow-tags`) runs CI: checks, then on macOS the
universal desktop app and a daemon archive, a GitHub release with both (`pai-macos.dmg` is the
stable name the client links to), then `POST /update` on the host (`PAI_URL`, `PAI_TOKEN`
repository secrets) and a wait until `/health` reports the tag.

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
