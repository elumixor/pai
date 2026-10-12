# pai

Personal assistant that runs on a box (Hetzner) and is used from a Mac (`pai …`, the menu bar
app, the desktop app) and from Telegram. The core here is the daemon: sessions (one Claude Code
session each, over the Agent SDK), the HTTP API, the client, files, hosting. Everything else is
a module from its own repository (`pai.config.ts`): `pai-browser` (a signed-in headless browser on the
box, one session per site, logins captured from the Mac's Arc), `pai-builder` (coding threads),
`pai-telegram` (the chat and the user's account), `pai-linkedin` (requires browser). A module's
`requires` orders loading; `ctx.use(name)` hands it another module's `api`. pai is one chat (the
orchestrator, `main.ts`): Telegram's pai topic, Paigram's bot chat, `pai dev say`. Its staff are agents
(`agents.ts`): standing (own an area, own topic), sub (one job, reports once, closes), service (answers
requests, e.g. Voice); depth pai › standing › sub. Other topics and `pai claude` are plain threads (`chat`);
a builder thread in a repo is `code`.

## Feedback loop

Never test through Telegram. The CLI drives the identical code path.

```sh
pai claude [--resume [id]] # a new conversation with the assistant on the box; --resume <id> continues a thread
pai ssh [command]          # a shell (or one command) on the box; `connect` is the same
pai status | update | cost | files [status|watch|sync|push|pull|diff|on|off|reset]
pai threads [project]      # every conversation by project; in a terminal a list to pick from: the choice runs
                           # `pai claude --resume <id>` (that thread's directory and model). `projects` = same
pai tools | skills | instructions | memories [name]   # what sessions are given (`GET /context`); a name prints one
pai menubar [install|uninstall]     # the Mac menu bar app: quota rings, what runs, files, links
pai channel install                 # `claude` in this shell loads the pai channel: Paigram messages reach the terminal
pai completion                      # installs zsh completion (src/clients/help.ts is the one table: help + completion)
bun run infra [--destroy]  # the Hetzner host from nothing (provision + bootstrap), idempotent

pai dev daemon [-f]        # detached; -f/--foreground = attached, verbose, telegram off
pai agents | log [agent] | tasks [add|done|drop] | asks | answer <id> <text> | routines | recall <words>
pai dev say "<text>"       # a turn in pai's one chat, waits for the reply; `pai dev rotate` rebuilds its session
pai dev chat "<text>"      # a turn in a new plain thread, waits for the reply
pai dev task "<title>" "<text>" [--project <slug>]
pai dev send <id> "<text>" [--wait]
pai dev answer <id|main> "<text>"   # answer a pending AskUserQuestion
pai dev tasks | stop <id|main> [--kill] | tail [id] [--raw] | events [id] | memory [query]
pai dev settings [KEY=value …]      # read or change data/config.json; a change needs restart
pai dev restart | update [--check] [--force] | install [--uninstall]
bun run dev                # the client in a browser, rebuilt on save (port 5180)
bun run install [--no-app] # bundles, the service, `pai` on PATH, the Mac app in /Applications
```

`--json` on any command. Session ids in full or as the 6-char short form. `pai` is
`bun run src/clients/cli.ts`; the user-facing commands are the first block, `pai dev` is the
daemon's own controls and stays out of `pai --help`.

## How sessions work

`src/session.ts` wraps one Agent SDK `query()` in streaming-input mode: an inbox of
`SDKUserMessage`s is fed to the process, messages come back as SDK events and are turned
into bus events (`session.delta`, `session.text`, `session.tool`, `session.turn_end`,
`session.question`, …). `inject()` appends context with `shouldQuery: false`, which is how
a thread's results reach its parent without a model call.

`prewarm()` keeps one initialised `task` process ready via `startup()`; a new task adopts it and its session id, so first replies take ~1s instead of ~30s. A dead process is revived with `resume` (`sessions.ensureLive()`); the transcript lives in
`~/.claude/projects`. `settingSources: ["user", "project"]` with `disableAllHooks`: claude.ai
connectors only load with the user's settings (they are the account's, so anything connected on
claude.ai is in every new session, no sync step), while the user's hooks stay out. Sessions run
without `CLAUDE_CODE_OAUTH_TOKEN`: with it in the environment claude loads no connectors at all.

Long-term memory is `workspace/MEMORY.md`, imported by `workspace/CLAUDE.md` and edited by
the sessions themselves with the Edit tool; no memory tools. A change re-warms the task process
(`src/domain/sessions.ts` watches the file). What belongs to one project goes into that
project's `CLAUDE.md`.

Google OAuth: while the consent screen's publishing status is **Testing**, every refresh token Google
issues expires after 7 days, so the mailboxes die weekly whatever the code does — publishing the app
(unverified Production still works: a warning screen and a 100-user cap) is the only fix, and it is a
click in the Cloud console, not code. The gmail module asks every mailbox for its grant at start and
daily, and an expired or short grant becomes a `waiting_user` task with the reconnect link.

A connector's grant is fixed at the moment it was connected: an account connected before a module
widened its scopes cannot use the new one until it is reconnected (`/gmail/connect?label=<name>` for
a mailbox), and the failure shows up as a 403 mid-task. Widening scopes means asking the user to
reconnect every account, so say so in the same breath as shipping it.

`AskUserQuestion` reaches `canUseTool` even under `bypassPermissions`. It becomes a
`session.question` event; Telegram renders buttons, the CLI has `answer`.

## pai and its staff

- `src/domain/main.ts` — pai's session (agent `pai`): user messages, system turns (`system`, shown) and housekeeping (`silent`, never shown). Rotates at `PAI_ROTATE_HOUR` (04:00, `PAI_TIMEZONE`) or at 50% context: the old session writes `journal/<day>.md` + MEMORY.md, a fresh one starts from a briefing (open tasks, asks, staff, journal, last 20 messages).
- `src/domain/agents.ts` — rows + folders `workspace/agents/<slug>/` (CLAUDE.md imports STATE.md); sessions resumed if active within a day, else fresh; ≤ `PAI_MAX_AGENTS` working (coding ×2), the rest queue; per-agent daily turn and per-turn minute budgets; reports (turn text) go to the parent; sub-agents close after reporting; tools = capabilities matched against the MCP server names (`capabilities.ts`: aliases like `browser` → `playwright`, `calendar` → Balance; one matching no server is warned about at creation and carried as `unresolvedTools`); connectors denied by prefix.
- `messages.ts` (the log every client renders; `message.new` on the bus), `tasks.ts` (the one task list), `requests.ts` (needs routed by pai, routes learned), `asks.ts` (ask_user, notify priorities, quiet hours, pins, mutes), `staff-tools.ts` (role-based MCP tools), `automations.ts` (routines: event or cron, code check, notify|turn|wake|triage|task; slows ≥70% weekly), `triage.ts` (5-min batches, Haiku routes), `briefs.ts`, `recall.ts` (FTS5 archive: transcripts, log, mail), `journal.ts`. No agents at first: pai creates them.
- Telegram renders log rows with trailer kinds `event(s)`, `delegation`, `report`, `ask`, `notice` (`protocol/rich.ts`); Paigram draws them natively.

## Layout

- `src/core/` — `config.ts`, `log.ts`, `bus.ts`, `db.ts`. Configuration is read once, at import.
- `src/domain/session.ts` — one SDK session, the event mapping, questions.
- `src/domain/sessions.ts` — registry, spawning (`spawnTask`: chat in the workspace, code in a repo), revival, reaper, parent relay (a thread's reports land in the thread that started it).
- `src/domain/memory.ts` — long-term memory files, index, search.
- `src/domain/terminal.ts`, `terminals.ts`, `pty-host.mjs` — PTYs on the host. node-pty only loads under Node, so each terminal is a small Node process the daemon talks to in JSON lines.
- `src/domain/tools.ts` — the in-process `pai` MCP server, one instance per session (bound through a ref, since warm processes exist before their session).
- `src/domain/browser.ts` — one Playwright MCP server per daemon over HTTP (pinned version, `--browser chromium`, its build installed at start); sessions connect instead of spawning `npx`.
  The install check costs ~1.6s per start when the browser is there, and needs the network when it is not: a cold box with no network cannot start the browser.
- `src/domain/prompts.ts` — instructions appended to the Claude Code system prompt, per session kind: the general part, the role, then `# Instructions (from <module>)` per module that adds a paragraph.
- `src/domain/catalog.ts` — coding projects under `~/dev`; `projects.json` overrides.
- `src/api/` — `server.ts` (transport, the terminal websocket, the client), `routes.ts`, `events.ts` (SSE), `port.ts`, `app.ts` (serves the client at `/ui`), `auth.ts` (`PAI_TOKEN` for programs, a signed session cookie for browsers; loopback and the bundles are exempt — a route that answers `401` to curl is not broken for him: with a browser's `Accept: text/html` the same route redirects to Google sign-in and on to where he was going, so check a page with an HTML accept header before calling it unreachable), `google.ts` (Sign in with Google: `PAI_GOOGLE_CLIENT_ID/SECRET` in `.env`, `PAI_GOOGLE_ALLOWED` emails; `/auth/check` is Caddy's forward_auth for the editor).
- `src/domain/publish.ts` — `PAI_PUBLIC=1` runs Caddy as a child: https on 80/443 for `PAI_DOMAIN` or `<ip>.sslip.io`, `/` the client, `/editor` code-server; opens the Hetzner firewall itself. Only with a token or Google sign-in configured.
- `src/host/files.ts` — the same files on the Mac and the box: `~/dev` ↔ `~/dev`, `~/.claude` ↔ `~/.claude` (not the login, caches, transcripts' `.pai`), two-way over ssh with Mutagen (installed to `~/.local/bin` on first use; a daemon on the Mac, an agent it puts on the box). `two-way-resolved`: both sides changed = the Mac wins on its own; `pai files sync --remote` (rsync of listed paths, then a cycle) or `pai files diff tree` takes the box's side. `watch` and `diff tree` are Ink views (`src/clients/files-ui.tsx`); everything else prints. `.git` never travels — two machines running git on one `.git` corrupt it; `~/dev/.pai-remotes.json` (written by `pai files`) tells the box each repo's origin and `catalog.adoptClones` gives a synced tree a clone's `.git` of its own. A folder definition change bumps its `version`, which recreates the session. A machine's first sync is `two-way-safe` (differences wait as conflicts; `pai files pull` takes the box's), then `two-way-resolved`. Nothing runs on the box for this; each Mac's menu bar app reports its state (`POST /sync`), the client's nav draws it as a dot.
- `src/clients/telegram.ts` — grammY frontend: routing by topic / reply, draft streaming, live cards, question keyboards, attachments.
- `src/clients/tg-user.ts` — the user's own Telegram account (gramjs, `TELEGRAM_USER_SESSION`) as the `tg` MCP server.
- `src/clients/cli.ts` — the CLI over the HTTP API.
- `src/domain/transcript.ts` — a thread's conversation read from `~/.claude/projects` (`GET /transcript`).
- `src/domain/mirror.ts` — conversations a terminal holds (`claude` on the Mac, synced, or on the box; entrypoint `cli`): their transcripts followed as they grow (offsets in `transcript_offsets`) and told to the bus as session events with `terminal: true`, rows in `sessions` with the topic. A message for one goes into the terminal through its channel, else the daemon resumes it (`revive` copies the newest transcript first).
- `src/domain/channels.ts`, `src/clients/channel.ts` — `pai channel`: an MCP channel server (`claude/channel`) `claude` starts via `--mcp-config ~/.config/pai/channel.json --dangerously-load-development-channels server:pai` (the CLI's `claude()` and the zsh function from `pai channel install` add it); it finds its conversation in `~/.claude/sessions/<pid>.json` and holds `GET /channel?session=`.
- `src/domain/settings.ts` — the editable settings in `data/config.json`, merged over the environment at import (`GET`/`PATCH /settings`; a change needs a restart).
- `src/protocol/rich.ts` — metadata trailer: plain text for stock clients, structured for ours.
- `src/host/` — the box: `update.ts`, `release-check.ts` (a release that never arrived: the newest `v*` tag older than the 15 minutes CI needs with this checkout still behind it raises a task, from the auto-update tick, even while sessions are busy — `scripts/release.ts` cannot see this case, since the delivery's restart kills the verifier), `install-daemon-linux.ts` (systemd). A Mac is a client, not a host: `install-client.ts` (`pai` on PATH, no daemon), `menubar.ts` (the Swift menu bar app, `pai menubar`), `client.ts` (`pai update` here = pull + rebuild). `remote.ts`: the box as `PAI_REMOTE` (`user@host`, default `pai@$PAI_HOST_IP`), ssh with port 22 opened for this machine's public address on the Hetzner firewall, and `boxApi()` — the box's https address and token learned once over ssh into `~/.config/pai/box.json`, which every CLI command then uses. `pai claude` from a Mac is `pai claude` on the box over ssh; there it is `claude` in the workspace (a new conversation; `--resume` is claude's picker). `POST /attach {id, cwd}` hands a daemon session to a terminal (the builder uses it); `POST /adopt {id, cwd, title}` makes a conversation held on disk a live session without a turn (Paigram opens synced threads with it).
- `src/domain/editor.ts` — code-server on 8788, a supervised child of the daemon: builds `editor/vscode`, copies it into the extensions directory and registers it. `PAI_NO_EDITOR`, `PAI_EDITOR_PORT`, `PAI_EDITOR_BIND`, `PAI_EDITOR_PASSWORD`.
- `editor/vscode/` — the VS Code extension: threads, projects and terminals over the API. `bun run editor` serves it without the daemon.
- `desktop/` — the Tauri desktop app: `ui/` is the whole client, with an offline cache and an outbox; `src-tauri/` is an empty Rust shell. The root (`/ui/`) is `home.ts`, one warm canvas: the project tree on the left (`ptree.ts`: standing and service agents nested as their parents are, a spinner while one works, a hand with the decisions waiting in it — a sub-agent folds into its nearest shown ancestor, a child's count never bubbles up), the chat in a 600px column (`chat.ts`: one row per entry of the message log — the user's tinted bubble folded past three lines, a reply as a receipt with the tool summary and "Delegated to" lines over it, events and reports as one-liners with the time and a chevron, an ask as "Action needed" with pill buttons, `AskUserQuestion`s answerable in place; the live session adds the folded tool calls, the streaming reply and a "Working on it…" line; the title and the day pill float over a fade), the hand above the box (`needs.ts`: each press scrolls to the next of `GET /needs`; every need has its row: a task waiting on the user gets an ask with Done / Drop, `asks.wireTasks`), the box (`compose.ts`: attach, the model and the effort as pickers that `POST /reconfigure`, the quota rings as small discs, enter), or the board (`board.ts`, `/ui/board[/<slug>]`). Sizes are the mock × 1.25; colours are `--ink` at an opacity plus a few named ones, so a theme is one set of tokens (`themes.ts`; pai Light is the design). `nav.ts` is four icons in the corner: Chat, Board, Editor, Settings — and settings (`settings.ts`, a sheet) holds the pages about the daemon (`dashboard.ts`: modules, routines, projects, context, agents; `/ui/modules` etc. open the sheet on that page). `/ui/editor` is the work view: files, a viewer, a terminal dock, two thread panes (`thread.ts`, the terminal look). Row icons come from `rich.ts` through `kinds.ts`. `bun run dev` for the loop, `bun run desktop` for the window, `bun run desktop:build` for the bundle.
- `src/domain/usage.ts` — the Claude subscription's windows (`GET /usage`) with the Claude Code login on the machine, plus what the sessions cost. `POST /usage/credentials` takes a Mac's keychain login (`pai cost` sends it when the box's own token cannot read the limits).
- `src/modules/` — `sdk.ts` is the contract for modules from their own repositories (`pai.config.ts` names them, `pai.config.local.ts` overrides with a path while working on one; installed under `modules/<name>/`, gitignored). A module's `index.ts` default-exports `(pai: PaiSdk) => PaiModule`: tools (an MCP server per session), prompt paragraphs per session kind, skills (linked into `workspace/.claude/skills`), `cli` (`pai <name> …`, run on the box; a Mac forwards over ssh), `routes` (`/m/<name>/…`), `ui` (`/m/<name>/ui/`), start/stop/health. `external.ts` installs (git clone, or a link for a path), loads, starts them; `pai modules` lists, `pai modules update` pulls them all and restarts. The box's ssh key is on the GitHub account, so private module repos clone. `index.ts` is the registry of the built-in pieces: each = tools + a prompt paragraph + bus events + settings, described for the dashboard (`GET /modules`, one list with `external: true` on the loaded ones). Built-ins are described there; `linkedin.ts` is the first real one (Voyager API with `li_at`/`JSESSIONID` cookies, `linkedin.message` events, `linkedin_*` tools). `gmail.ts` reads any number of mailboxes, each connected once through `/gmail/connect?label=<name>` (consent comes back through `/auth/google/callback`, the one redirect URI the OAuth client has; the refresh token lives in `gmail_accounts`); the scopes Google granted are stored with the account and re-read on every token refresh, so a mailbox that cannot send is a task before a send is attempted, not a 403 inside one, and a consent that comes back as a different address is refused rather than silently rebinding the label; `gmail_list_accounts`, `gmail_search`, `gmail_read` (the HTML part wins over the plain one so anchors keep their urls — a link that only exists in the markup was invisible before; long bodies come in windows, `truncated` + `offset`) (sends as that mailbox; `gmail.send` is a sensitive scope on an unverified OAuth client, so the consent screen warns — expected, he is his own test user, and an account connected before the scope existed cannot send until reconnected).
- `src/domain/triage.ts` — 5-min batches, Haiku routes. A group message is the one thing it may not delegate on its own judgement (`delegatable`): a chat post reaches an agent only when he wrote it, Telegram says he was addressed in it, or the agent's brief names that chat by title — otherwise it stays an event in the log. A small model will tie anything to a brief that mentions chats at all, and his groups are personal, so a misroute has to cost nothing.
- `src/domain/automations.ts` — `on <event> → notify | turn | task`, rows in the `automations` table, run from the bus; tasks capped at 6/h. `GET/POST/PATCH/DELETE /automations`.
- `src/domain/diagnostics.ts` — `GET /diagnostics?path=` runs tsc on the project around a file (cached a minute per project); the client's editor shows them inline.
- `src/domain/inventory.ts` — what each session kind reported at its start (tools, MCP servers and their status), in memory and in `data/inventory.json`. Its own module because both `context.ts` and `capabilities.ts` read it and must not import each other: configuration is frozen at import, so a cycle in this layer is a startup-order bug waiting for a different entry point.
- `src/domain/capabilities.ts` — where an agent's tools list (capabilities) meets the MCP server names: the aliases (`browser` → `playwright`, `calendar` → Balance), `serverAllowed`, `narrowed` (a sub-agent against its parent), `unresolved` (declared, no server) and `unavailable` (offered but dead — denied or never signed in, each paired through the aliases with the live server that answers the same capability). `prompts.ts`'s `missingTools` turns both into one generated "# Tools you do not have" paragraph in every session; the context view says the same on the server's line. Generated, never a written list, so it cannot go stale.
- `src/domain/context.ts` — what each session kind is given (instructions, memories, skills, tools) with the surfaces that see it (`GET /context`, `pai tools|skills|instructions|memories`, the dashboard, Paigram's settings). Tools come from the newest session init per kind (`noteInit`: the SDK's tool list and MCP server states), memories from `workspace/MEMORY.md` plus Claude Code's own `~/.claude/projects/<cwd>/memory/`.
- Projects are repos under `devRoot` or **contexts**: `workspace/projects/<slug>/` with a `CLAUDE.md` (voice, rules, what to remember about it). `POST /projects {name, about}` creates one; a task in it runs with that directory as cwd.
- `infra/` — `provision.ts` (Hetzner), `cloud-init.yaml`, `bootstrap.ts`, borg backup, `gateway.ts` (Caddy for a domain of your own, needs root), `firewall.ts` (open ports on the Hetzner firewall).
- `menubar/main.swift` — menu bar status app: pai tasks plus the Claude quota rings (session and model-scoped weekly, token read from the Claude Code keychain item); compiled and loaded by `install` on macOS.
- `workspace/` — the assistant's cwd; `CLAUDE.md` there is the persona, `inbox/` gets attachments.

## Releasing

The release restarts the daemon, which kills the session that ran it: finish the report before
`bun run release`, never after, or it is lost mid-sentence.

`bun run release [patch|minor|major]` (`scripts/release.ts`): refuses a dirty tree or a branch other
than main, runs the checks, bumps the version as a commit and a `v*` tag, pushes, then waits for the
box to report it. The tag runs CI: checks, then on macOS the
universal desktop app and a daemon archive, a GitHub release with both (`pai-macos.dmg` is the
stable name the client links to), then `POST /update` on the host (`PAI_URL`, `PAI_TOKEN`
repository secrets) and a wait until `/health` reports the tag. When CI cannot start (GitHub billing,
quota), the release script falls back to `pai update`, which builds the daemon on the box from the tag;
the desktop app is then `bun run desktop:build` here.

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
