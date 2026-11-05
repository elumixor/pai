# pai

Personal assistant that runs on a box (Hetzner) and is used from a browser (the web client at `/`),
a Mac (`pai …`, the menu bar app) and from Telegram. The core here is the daemon: sessions (one Claude Code
session each, over the Agent SDK), the HTTP API, the clients (web, CLI, the Telegram bot). The outside channels are **connectors**, all in one
repository, `elumixor/desk-connectors` (see Connectors below): `telegram` (the user's own account), `email` (Gmail
mailboxes), `linkedin` (requires browser), `whatsapp` (his own number over the WhatsApp Web protocol, linked
by QR — unofficial, so the risk is a ban on his number and it never sends in bulk; a send is read back out of the
chat and answers `verified`/`unverified`/`not_sent`), and `browser` (a capability: a signed-in headless browser on
the box, one session per site, logins captured from the Mac's Arc). pai is one chat (the
orchestrator, `main.ts`): Telegram's pai topic, Paigram's bot chat, `pai dev say`. Its only staff are workers
(`agents.ts`, kind `sub`: one job, writes to Keep, reports once, closes); an area of his life is a project in Keep, not an agent. Other topics and `pai claude` are plain threads (`chat`);
a builder thread in a repo is `code`.

## Where things live (the Desk split)

pai core is the assistant only: sessions over the Agent SDK, `main.ts` and the agents, tasks, asks, drafts,
requests, automations, triage, recall, memory, journal, spend/usage/models, the HTTP API + SSE, auth, the connector
host and loader, the CLI, the Telegram bot, and the self-update. Everything about the host machine or writing code is **dev**, a
separate system (`elumixor/desk-dev`, `~/dev/@desk/dev`, service `dev` on the box at `~/desk/dev`, https://dev.desk.atmagaming.com):
the catalog of repos, the web editor, terminals, Claude Code sessions and the terminals' channel (`dev channel`),
Mutagen files sync, the menu bar app, `infra/`, and Caddy for every host on the box. pai is dev's client: its
projects come from dev's API (`src/domain/dev.ts`, `PAI_DEV_URL`/`PAI_DEV_TOKEN`), a message for a terminal's
conversation goes through dev (`POST /sessions/:id/deliver`), and sessions use dev's MCP server (`dev`, `devMcp()` in `session.ts`): list_projects, get_project, get_diff, read/write_file, run_command,
list/read/start_session, send_to_session. pai never imports dev and dev never imports pai. pai keeps the terminal
mirror (`mirror.ts`: terminal conversations shown as threads), the release check, install/release/update. Projects,
tasks and docs live in Keep (`elumixor/keep`, `keep:page/<id>` URNs, an MCP); pai knows Keep, Keep never knows pai.

pai is the AI part of the desk suite: every repo under `~/dev/@desk/` (package `@desk/<name>`, never published — the npm
scope is not ours), every app under `*.desk.atmagaming.com` — hub `desk.` (`@desk/desk`), keep `keep.`, people `people.` (people,
and the one sign-in: `/sign-in?next=`), pai `pai.` (the old `pai.atmagaming.com` still served as `PAI_DOMAIN_ALIASES`
for Paigram builds), dev `dev.`. Clerk's production app "Desk" sits on desk.atmagaming.com, so one session covers them
all; `@desk/core` (`github:elumixor/desk-core`) holds the browser side every app shares (Clerk with its components,
the central sign-in, URNs).

## Connectors

A connector is a directory `connectors/<name>/` of `elumixor/desk-connectors` (`~/dev/@desk/connectors`): its `index.ts`
default-exports an instance of a class extending `BaseConnector` from `@desk/connector` (`github:elumixor/desk-connector`,
`~/dev/@desk/connector`, pinned by tag), and it imports nothing of pai. pai is its host. `pai.config.ts` is `{ repo, connectors: [names] }`;
`pai.config.local.ts` (not committed) overrides keys, a path as `repo` while working on them. `src/connectors/source.ts` makes `modules/`
(gitignored) that repository: one clone with its dependencies at the root, or a link to a checkout. A clone is built in `modules.next` and swapped in, so a failure leaves
what was there, and every self-update pulls it. `src/connectors/loader.ts` imports the named ones, checks each with `problemsOf`, calls `attach(host)`, starts
them after what each `requires`; `restart(name)` applies a settings change without a daemon restart, what `requires` it restarting too. `src/connectors/host.ts` is the `Host` each is handed:
settings (`setting()`), its store (kv `module:<name>:…`), pai's db, the bus (`emit`), `use(name)` for another
connector's `api`, `http` (`/m/<name>/` and the public url), Google OAuth (`oauth`, the one `/auth/google/callback`),
`problems` (one task per title), `record` (a `sent` row in the log), `archive` (recall) and `startThread` (a conversation an action hands work to). Its `log` also feeds a 200-line ring per connector
(`src/connectors/logs.ts`). Its data dir stays `data/modules/<name>/`. Data and kv are keyed by name, so nothing about the repository's layout touches them.

A connector's `tools` become one in-process MCP server each (`server`, default its name; the
calling agent passed as `call.agent`) for chat and code sessions, its `instructions` a prompt paragraph, its `routes`
`/m/<name>/…`, `mounts` other prefixes (`/gmail/`), `ui` `/m/<name>/ui/`, its `cli` `pai <name> …` (run on the box;
a Mac forwards over ssh unless `cliHere`; a command line has no host attached). Every connector says `check()` (signed in / signed out / broken
with the link that fixes it; `status()` answers it unless turned off), and may `send` (`verified | unverified | not_sent`) and offer `actions()`.

`GET /connectors` lists them (title, icon as a data URI, `needsAction`, status), `GET /connectors/:name` adds tools with descriptions, events with when each last fired,
actions, accounts, settings with secrets masked, open problems, logs; `PATCH /connectors/:name/settings`, `POST /connectors/:name/actions/:id`, `POST /connectors/update`.
`pai connectors [update|restart]` is the same from a terminal. pai's own code reads a
connector's `api` with `connectors.api(name)` (email's `addresses`, telegram's `transcribe`). The Telegram bot pai is
talked to through is pai's own client (`src/clients/telegram.ts`), not a connector; `/m/telegram/info` is its public
face for Paigram. pai's `biome.json` is lint only (formatter off): `bun run lint`.
Self-update stays in core (`src/domain/update.ts`: `POST /update` + the auto-update tick, then the connectors pulled), so a connector that fails to load never leaves the box unable to update.

## Feedback loop

Never test through Telegram. The CLI drives the identical code path.

```sh
pai claude [--resume [id]] # a new conversation with the assistant on the box; --resume <id> continues a thread
pai status | cost
pai threads [project]      # every conversation by project; in a terminal a list to pick from: the choice runs
                           # `pai claude --resume <id>` (that thread's directory and model). `projects` = same
pai tools | skills | instructions | memories [name]   # what sessions are given (`GET /context`); a name prints one
pai completion                      # installs zsh completion (src/clients/help.ts is the one table: help + completion)
pai update [--check] [--force]      # the box updates itself; a laptop pulls its checkout too
# files sync, ssh, menu bar, channel, infra are dev's: `dev files|ssh|menubar|channel|infra` (dev's README)

pai dev daemon [-f]        # detached; -f/--foreground = attached, verbose, telegram off
pai agents | log [agent] | tasks [add|done|drop] | asks | answer <id> <text> | routines | recall <words> | audit [agent]
pai dev say "<text>"       # a turn in pai's one chat, waits for the reply; `pai dev rotate` rebuilds its session
pai dev chat "<text>"      # a turn in a new plain thread, waits for the reply
pai dev task "<title>" "<text>" [--project <slug>]
pai dev send <id> "<text>" [--wait]
pai dev answer <id|main> "<text>"   # answer a pending AskUserQuestion
pai dev tasks | stop <id|main> [--kill] | tail [id] [--raw] | events [id] | memory [query]
pai dev settings [KEY=value …]      # read or change data/config.json; a change needs restart
pai dev restart
bun run dev                # the web client (Vite, port 5180) against the box's data
bun run setup              # = `pai dev install`: the web client, the service, `pai` on PATH (menu bar: `dev menubar install`)
```

`--json` on any command. Session ids in full or as the 6-char short form. `pai` is
`bun run src/clients/cli.ts`; the user-facing commands are the first block, `pai dev` is the
daemon's own controls (with `install`, `release`, `update`) and stays out of `pai --help`. A connector's command
line is `pai <name> …`.

## How sessions work

`src/session.ts` wraps one Agent SDK `query()` in streaming-input mode: an inbox of
`SDKUserMessage`s is fed to the process, messages come back as SDK events and are turned
into bus events (`session.delta`, `session.text`, `session.tool`, `session.turn_end`,
`session.question`, …). `inject()` appends context with `shouldQuery: false`, which is how
a thread's results reach its parent without a model call.

`prewarm()` keeps one initialised `task` process ready via `startup()`; a new task adopts it and its session id, so first replies take ~1s instead of ~30s. A dead process is revived with `resume` (`sessions.ensureLive()`); the transcript lives in
`~/.claude/projects`. `settingSources: ["project"]`, `strictMcpConfig` and `disableAllHooks`: a session gets only the servers `build()` lists, so no plugins, no `~/.claude.json` servers, no hooks, no `~/.claude/skills` or `~/.claude/CLAUDE.md`. Those two moved once into `workspace/.claude/skills` and `workspace/instructions/global.md` (`moveUserContext`). claude.ai connectors are passed explicitly as `claudeai-proxy` entries; `claude-connectors.ts` finds them with a promptless probe that loads the user's settings. Sessions run without `CLAUDE_CODE_OAUTH_TOKEN`: with it in the environment claude loads no connectors at all.

Long-term memory is `workspace/MEMORY.md`, imported by `workspace/CLAUDE.md` and changed with one tool, `edit_memory` (`memory.ts`), which workers do not get. Claude Code's own auto-memory is off. A change re-warms the task process
(`src/domain/sessions.ts` watches the file). What belongs to one project goes into that
project's `CLAUDE.md`.

Google OAuth: while the consent screen's publishing status is **Testing**, every refresh token Google
issues expires after 7 days, so the mailboxes die weekly whatever the code does — publishing the app
(unverified Production still works: a warning screen and a 100-user cap) is the only fix, and it is a
click in the Cloud console, not code. The email connector asks every mailbox for its grant at start and
daily, and an expired or short grant becomes a `waiting_user` task with the reconnect link.

A connector's grant is fixed at the moment it was connected: an account connected before a connector
widened its scopes cannot use the new one until it is reconnected (`/gmail/connect?label=<name>` for
a mailbox), and the failure shows up as a 403 mid-task. Widening scopes means asking the user to
reconnect every account, so say so in the same breath as shipping it.

`AskUserQuestion` reaches `canUseTool` even under `bypassPermissions`. It becomes a
`session.question` event; Telegram renders buttons, the CLI has `answer`.

## pai and its staff

- `src/domain/main.ts` — pai's session (agent `pai`): user messages, system turns (`system`, shown) and housekeeping (`silent`, never shown). Rotates at `PAI_ROTATE_HOUR` (04:00, `PAI_TIMEZONE`) or at 50% context: the old session writes `journal/<day>.md` + MEMORY.md, a fresh one starts from a briefing (open tasks, asks, staff, journal, last 20 messages).
- `src/domain/agents.ts` — rows + folders `workspace/agents/<slug>/` (CLAUDE.md imports STATE.md); sessions resumed if active within a day, else fresh; `create_agent` only starts workers (the `standing` and `service` kinds are history); ≤ `PAI_MAX_AGENTS` working (coding ×2), the rest queue; per-agent daily turn and per-turn minute budgets; a report (turn text) reaches the agent above, and goes on up while each agent in the chain has `bubble` on (`configure_agent`, the info pane's toggle; pai is the top); sub-agents close after reporting; tools = capabilities matched against the MCP server names (`capabilities.ts`: aliases like `browser` → `playwright`, `calendar` → Balance; one matching no server is warned about at creation and carried as `unresolvedTools`); connectors denied by prefix.
- `messages.ts` (the log every client renders; `message.new` on the bus), `tasks.ts` (the one task list), `requests.ts` (needs routed by pai, routes learned), `asks.ts` (ask_user, notify priorities, quiet hours, pins, mutes), `staff-tools.ts` (role-based MCP tools), `automations.ts` (routines: event or cron, code check, notify|turn|wake|triage|task; slows ≥70% weekly), `triage.ts` (5-min batches, Jev (decision model) routes), `briefs.ts`, `recall.ts` (FTS5 archive: transcripts, log, mail), `journal.ts`. No agents at first: pai creates them.
- Telegram renders log rows with trailer kinds `event(s)`, `delegation`, `report`, `ask`, `notice` (`protocol/rich.ts`); Paigram draws them natively.

## Layout

- `src/core/` — `config.ts`, `log.ts`, `bus.ts`, `db.ts`. Configuration is read once, at import.
- `src/domain/session.ts` — one SDK session, the event mapping, questions.
- `src/domain/sessions.ts` — registry, spawning (`spawnTask`: chat in the workspace, code in a project's repo, or a given `cwd`), revival, reaper, parent relay (a thread's reports land in the thread that started it).
- `src/domain/memory.ts` — long-term memory files, index, search.
- `src/domain/terminal.ts`, `terminals.ts`, `pty-host.mjs` — PTYs on the host. node-pty only loads under Node, so each terminal is a small Node process the daemon talks to in JSON lines.
- `src/domain/tools.ts` — the in-process `pai` MCP server, one instance per session (bound through a ref, since warm processes exist before their session).
- `src/domain/browser.ts` — one Playwright MCP server per daemon over HTTP (pinned version, `--browser chromium`, its build installed at start); sessions connect instead of spawning `npx`.
  The install check costs ~1.6s per start when the browser is there, and needs the network when it is not: a cold box with no network cannot start the browser.
- `src/domain/prompts.ts` — instructions appended to the Claude Code system prompt, per session kind: the general part, the role, then `# Instructions (from <connector>)` per connector that adds a paragraph.
- `src/domain/projects.ts` — the projects sessions run in: `ProjectSource`s (dev's repos under `~/dev`, `dev.ts`, refreshed every 5 min). Kinds are `repo | folder`. `src/domain/held.ts` — threads held outside the daemon (a terminal's) that a message still reaches (`mirror.ts`).
- `src/domain/dev-tasks.ts` — Keep → dev: a `keep.page.created|changed` for a task whose effective properties have a dev `project` and no `session` gets one dev session (`start_session` over dev's MCP), its `dev:session/<id>` written back with Keep's `edit_page` (a page without a session property gets an own `dev-session` one via `define`; a page holding the project as its own value is the project, not a task) (`callKeep` in `keep.ts`, one key `PAI_KEEP_KEY`, calls tagged `x-keep-client`), one event row; claimed by URN in `dev_tasks`, so never twice. Every minute the status select follows the session (In progress / In review, when the database has them). Off with `PAI_DEV_TASKS=0`.
- `src/domain/people-notify.ts` — People → pai: `POST /people/notify` (HMAC `PAI_PEOPLE_WEBHOOK_SECRET`) routes each notification by client tag, then linked page (`keep-links.ts`), then Jev: existing thread, new child thread, or general.
- `src/domain/mirror.ts` — terminal conversations (Mac, box, dev-run `claude -p`) followed through their transcripts and told to the bus as threads; a message for one goes to dev's channel, else the daemon resumes it. `src/domain/release-check.ts` — a `v*` tag older than 15 min with the box behind it becomes one task.
- `src/api/app.ts` serves `apps/web/build` at `/`: `index.html` `no-cache`, `/_app/immutable/*` (content-hashed) `immutable`, so a release can only arrive whole. `/ui` and `/app` redirect to `/`.
- `src/api/` — `server.ts` (transport, the terminal websocket, the client), `routes.ts`, `events.ts` (SSE), `port.ts`, `app.ts` (serves the client at `/`), `auth.ts` (`PAI_TOKEN` for programs, a phone's own device token (`devices.ts`: minted on the web client's `#/link` page for a signed-in person, `/auth/devices` lists/revokes), a Clerk session (`clerk.ts`) or the Google session cookie for browsers; loopback and the bundles are exempt, and under `/m/` only `PUBLIC_PATHS` are open — a route that answers `401` to curl is not broken for him: with a browser's `Accept: text/html` the same route redirects to Google sign-in and on to where he was going, so check a page with an HTML accept header before calling it unreachable), `google.ts` (Sign in with Google: `PAI_GOOGLE_CLIENT_ID/SECRET` in `.env`, `PAI_GOOGLE_ALLOWED` emails).
- Caddy (public https for pai's and dev's hosts) is run by dev (`DEV_ROUTES` in dev's `.env`); pai only binds its API port.
- `src/clients/telegram.ts` — the bot (grammY, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, off with `PAI_NO_TELEGRAM=1`): routing by topic / reply, draft streaming, live cards, question keyboards, attachments; voice through the telegram connector's `transcribe`, its state under kv `module:telegram:`. `src/domain/location.ts` — places both ways: `send_location` (a pin in his chat, in the `pai` server) and a location he sends the bot.
- `src/clients/cli.ts` — the CLI over the HTTP API.
- `src/domain/transcript.ts` — a thread's conversation read from `~/.claude/projects` (`GET /transcript`).
- The terminals' channel (`/channel?session=`, the `dev channel` MCP server, plugin `pai@pai`) is dev's; `pai claude` adds `dev channel args`. Core keeps the mirror, `POST /attach`, `/adopt` and the `code` kind.
- `src/domain/settings.ts` — the editable settings in `data/config.json`, merged over the environment at import (`GET`/`PATCH /settings`; a change needs a restart).
- `src/protocol/rich.ts` — metadata trailer: plain text for stock clients, structured for ours.
- `src/host/remote.ts` — the box as `PAI_REMOTE` (`user@host`, default `pai@$PAI_HOST_IP`), ssh with port 22 opened for this machine's public address on the Hetzner firewall, and `boxApi()` — the box's https address and token learned once over ssh into `~/.config/pai/box.json`, which every CLI command then uses. `pai claude` from a Mac is `pai claude` on the box over ssh; there it is `claude` in the workspace (a new conversation; `--resume` is claude's picker; dev's channel is added). `POST /attach {id, cwd}` hands a daemon session to a terminal; `POST /adopt {id, cwd, title}` makes a conversation held on disk a live session without a turn (Paigram opens synced threads with it). Host install, update and release are `pai dev install|update|release` (`src/clients/`).
- `apps/web/` — the web client (SvelteKit SPA, Svelte 5, Tailwind 4 without preflight), served by the daemon at `/` with its routes in the hash (`#/thread/<id>`, `#/chat/<agent>`, `#/new[/<parent>]`, `#/settings/<section>`), so no client route can shadow an API path. Keep's frame on the suite's tokens: `sidebar/` is Keep's sidebar — General on top, then every thread as a tree by the session that started it (`tree.ts`: agents are threads under the agent they report to, an agent session's threads hang under that agent; built from `/agents` and `/sessions?limit=`), `+` on a row starts a sub-thread (`POST /task {parent}`, its reports land in the parent); the centre (`home/Home.svelte`) is the crumbs and the chat (`chat/ChatView.svelte`: rows by kind, tool calls folded per turn, asks and `AskUserQuestion` with buttons, drafts as cards, unread line and read marks via `/reads`, reply by right click or swipe, ⌘F find, the hand cycling what waits). ⌘K and settings are `@desk/core`'s `CommandPalette` and `SettingsDialog`. Tasks, projects and code have no pages here: they live in Keep and Dev. `lib/pai.css` (the chat's own look) sits in a CSS layer under Tailwind's utilities. A `keep:page/<id>` in a message becomes `<keep-pill>` from Keep's own `elements.js` (`PAI_KEEP_URL`). Sign-in: Clerk (the account shared with Keep; `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY`, `PAI_ALLOWED` emails) or a `?token=` link.
- `src/domain/claude-login.ts` — the box's own Claude login. An `authentication_failed` turn is no reply: it raises one `waiting_user` task linking `/claude/login` (runs `claude auth login`, the user pastes the code back), closed by the next turn that gets through; pai then answers what went unanswered.
- `src/domain/usage.ts` — the Claude subscription's windows (`GET /usage`) with the Claude Code login on the machine, plus what the sessions cost. Never copy a Mac's login to the box: refresh tokens are single-use, so two machines on one login sign each other out.
- `src/domain/spend.ts` — the ledger of every model call: Claude Code responses read from all transcripts (daemon, terminals, sub-agents; `msg:<id>` dedupes the per-block repeats), triage results, gateway calls. Priced at API list rates; `GET /spend?days=`, `pai cost [days] [--by …]`, settings › Spend show it beside the real price (`PAI_CLAUDE_PLAN_USD` for the period, shared by API price, + metered).
- `src/domain/models.ts` — Claude models from the Models API (daily, `data/models.json`); a family name (`opus`, `sonnet`, `haiku`, `fable`) resolves to its newest id for every session, triage and the picker (`GET /models`). Claude Code's own aliases lag the SDK.
- `src/domain/credits.ts` — small jobs (summaries, headlines) on the Max plan's monthly API credits via `PAI_ANTHROPIC_API_KEY` (Console org ATMA), falling back to the gateway when they run out. Never name it `ANTHROPIC_API_KEY`: Claude Code would bill every session to it.
- Sessions compact at `PAI_COMPACT_WINDOW` tokens (200k, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`): a 1M context re-read on every tool step made long-lived agents cost ~$300/day at API prices. pai rotates at 75% of it.
- `src/domain/event-catalog.ts` — what a routine can be triggered by, as people name it (`GET /routines/events`): connector events plus a curated core list. Not `session.turn_end` or `session.error`: a routine answering those with a turn would feed itself, and `automations.ts` caps a routine's event-fired turns at 20 an hour for the same reason. `src/connectors/` — the connector host and loader (above). `PAI_MODULES_CONFIG`/`PAI_MODULES_DIR` point a scratch daemon at connectors of its own. The box's ssh key is on the GitHub account, so the private repository clones. Mailboxes are the `email` connector: MCP server `gmail`, `gmail_*` tools, table `gmail_accounts`, `/gmail/connect?label=<name>`; its README holds the OAuth and scope rules.
- `src/domain/triage.ts` — 5-min batches, Jev (decision model) routes. A group message is the one thing it may not delegate on its own judgement (`delegatable`): a chat post reaches an agent only when he wrote it, Telegram says he was addressed in it, or the agent's brief names that chat by title — otherwise it stays an event in the log. A small model will tie anything to a brief that mentions chats at all, and his groups are personal, so a misroute has to cost nothing.
- An agent's status is **derived, not written**: `settle()` runs every minute and both clears `working` when no live session of its own exists and marks `working` when one is busy, because a turn that never ends (the daemon restarted by the release that turn cut) and a turn the daemon never sent (one resumed after a restart) are the same lie in opposite directions. Thinking and tool calls on the bus say the same thing for a turn nothing woke.
- `src/domain/limits.ts` — the account's own limit as it actually arrives: the turn's own reply text ("You've hit your session limit · resets 5:10pm (UTC)"). Shown as a message it reads as something pai said, and the work the turn was doing is lost — two agents had to be re-sent their briefs by hand on 19 October. So a turn ending this way is not a report: it becomes one quiet `rate_limited` event row, and the same turn is held (on disk, so a restart keeps it) and sent again a minute past the reset. pai's own turn holds his message instead and asks it again.
- `src/domain/watch.ts` — what an observer does with what it found: one task per fault, its reason kept current, closed when the thing answers, and **reopened** when a flapping fault comes back, with the return counted in its notes. LinkedIn's fault came and went eleven times between 12 and 15 October and each episode opened its own row — nothing duplicated at any instant, eleven identical tasks all the same, and a watcher that floods is one he learns to scroll past. A task he dropped himself is never reopened.
- `src/domain/browser-check.ts` — does the browser still work? Every connector reading a signed-in site and every session's browser tools go through the one Playwright MCP server, and nothing watched it. Both questions are ones that cannot be answered from inside it: does it answer a read made **now** (a dead server makes callers hang, not fail — `/inbox` returning nothing in 280s was this), and has it been dying under the sessions holding it (`mcpState()` counts the restarts). Its own timer, one task through `watch.ts`.
- `src/domain/linkedin-check.ts` — does pai still see LinkedIn? Both edges are faults: a session that cannot read (not started, signed out, a failed or stopped poll) and one that reads but has heard nothing for longer than his own traffic ever goes quiet — from the inside those look the same, which is what the phantom sends were. One task, its reason current, closed when LinkedIn answers again; its own timer, outside the connector, because an observer sharing a loop with what it watches dies with it. A read it could not make says nothing at all.
- `src/domain/new-chat.ts` — Jev's suggestion for a blank chat (`POST /new/suggest`: kind, project, model, effort); the client (`home/new-chat.svelte.ts`) keeps what the user chose himself. Kinds: detached, Dev task (`POST /dev-task`), long-term goal (`/task` with `parent: "general"`).
- `src/domain/reset.ts` — clears General for good (`POST /pai/reset`, `pai dev reset`, General's trash icon): conversation, memory, journal, tasks, workers, recall of them, its Telegram topic. Plain threads, Keep, people's notes, routines stay. pai then starts over on a hidden exploration turn.
- `src/domain/snapshot.ts` — the state of things as one markdown document (MEMORY.md, any agent with its brief and STATE.md, open tasks, open asks, pending drafts, routines, journal, General's conversation): `GET /snapshot`, `pai snapshot [export [file]]`, General's download icon. Attached to General with "import this" (the file holds the steps), or `POST /snapshot {text}` / `pai snapshot import <file>` (a turn, history left out): fact-check it against the latest evidence, rewrite memory, file what holds in Keep, hand big jobs to workers, send nothing as the user.
- Private chats (`POST /task {private}`, `sessions.closePrivate`, `POST /private/close`): `bus.hidden` keeps their events out of the log, Telegram, routines, audit and recall, no `edit_memory`, no warm process. Leaving the chat erases the transcript and db rows; a closed tab goes after an idle hour; none outlives the daemon.
- `src/domain/audit.ts` — the trail of outward tool calls (sends, writes, clicks in signed-in sites; a verb in the tool name, pai's own servers excluded) with full input and result; `GET /audit`, `pai audit`, the `audit` tool.
- `src/domain/automations.ts` — `on <event> → notify | turn | task`, rows in the `automations` table, run from the bus; tasks capped at 6/h. `GET/POST/PATCH/DELETE /automations`.
- `src/domain/drafts.ts` — an outbound message as a **card**, which is the approval. A draft used to be markdown in a chat row approved by typing "send", so changing a word meant copying the text out. Now an agent offers one (`offer_draft`: email with from/to/cc/subject/body, a Telegram or WhatsApp message, a LinkedIn reply, a post) and it becomes a row he edits in place, with Send and Discard on it. Two rules shape it: **what goes out is what the card holds when he presses Send** (the fields live in `drafts`, his last keystrokes ride along with the Send, and the wake reads them at that moment — never what the agent first wrote), and **the agent that offered it sends it**, through its own channel tool, so the read-back verification stays where it is and comes back onto the card as `verified` / `unverified` / `not_sent` (`draft_result`). A pending draft is a need, so the hand counts it; the chat row is updated in place (`messages.update`), so a client that only has the log is never shown the old words. **Two pending drafts of the same message cannot exist**: on 21 October pai and Job search each offered the identical Amin follow-up, and a Send on both would have put the same mail in a founder's inbox twice — so `offer_draft` refuses a clash (same channel and recipient, and either the same subject or a body ≥0.7 alike by word overlap) and **hands back the pending card's id**, which is what lets the caller report the collision instead of guessing. Its answer always lists what is already pending for that channel, because nothing else in an agent's tool set could tell it; and `withdraw_draft` lets an agent take back its own pending draft — a rule that can only be obeyed with a database write is not a rule but a trap.
- `src/domain/attachments.ts` — attached images kept by hash next to the db (`GET /attachments/<name>`); a terminal gets them through its channel as `[image: <local path>]` lines, which the transcript turns back into images.
- `apps/web/src/lib/theme/` + `settings/themes/` — themes made in the editor: a base palette plus a compiled `<style id="pai-theme">` (tokens on `:root:root:root`, element rules inside `@layer pai`, one class above the rule they override, so states survive; `catalog.ts` lists what can change). Held by `src/domain/themes.ts` (`/themes`), cached for `app.html`'s boot script, which also declares the layers' order.
- `src/domain/inventory.ts` — what each session kind reported at its start (tools, MCP servers and their status), in memory and in `data/inventory.json`. Its own module because both `context.ts` and `capabilities.ts` read it and must not import each other: configuration is frozen at import, so a cycle in this layer is a startup-order bug waiting for a different entry point.
- `src/domain/capabilities.ts` — where an agent's tools list (capabilities) meets the MCP server names: the aliases (`browser` → `playwright`, `calendar` → Balance), `serverAllowed`, `narrowed` (a sub-agent against its parent), `unresolved` (declared, no server) and `unavailable` (offered but dead — switched off, never signed in or failed to start, each paired through the aliases with the live server that answers the same capability). `prompts.ts`'s `missingTools` turns both into one generated "# Tools you do not have" paragraph in every session; the context view says the same on the server's line. Generated, never a written list, so it cannot go stale.
- `src/domain/tool-registry.ts` — the one authority on what sessions may have (kv `tool-registry`, read inside `build()`): the claude.ai sync switch, servers, tools and skills switched off, direct servers, the discovered connectors. `sessions.applyTools()` makes a change take effect: idle sessions go now, busy ones after their turn. `src/domain/direct-mcp.ts` — servers pai reaches itself ("Move to pai"): checked with `tools/list` before they replace a synced one; OAuth goes through the daemon (`/direct-mcp/<name>`, `/auth/mcp/callback`) because a session's headers are fixed at its start.
- `src/domain/context.ts` — what sessions are given: instructions, memory, skills (`GET /context`, `pai tools|skills|instructions|memories`, Paigram's settings; Paigram decodes `surfaces`, always `["chat"]`) and every tool provider, switched off ones included (`GET|PATCH /tools`). The web client's popups are `apps/web/src/lib/context/` (Tools, Skills, Instructions; ⌘K or settings › Context), editing with `@desk/editor` (`github:elumixor/desk-editor`, shared with Keep; a file that would not round-trip opens as source). Built-in prompt sections are a table in `prompts.ts` (`what`, `goesTo`, default), a user's rewrite lives in `workspace/instructions/<id>.md`, and `GET /context/prompt?who=` is the whole prompt as sent. `connector` marks what the connector sheet shows instead.
- Projects are repos dev knows, under `devRoot`; pai has none of its own.
- `infra/` (Hetzner provision, cloud-init, bootstrap, firewall, borg) and `menubar/` are dev's: `dev infra`, `dev menubar`.
- `workspace/` — the assistant's cwd; `CLAUDE.md` there is the persona, `inbox/` gets attachments.

## Releasing

A release must run inside a tool call the turn is waiting on: a detached child (`nohup`, `setsid`,
`systemd-run`) still belongs to the turn's process group and is killed the moment the turn ends, so
`nohup bun run release &` dies mid-checks and nothing is tagged — it looks exactly like a refused
release. The same holds for anything gathering evidence in the background.

The release restarts the daemon, which kills the session that ran it: finish the report before
`bun run release`, never after, or it is lost mid-sentence.

`bun run release [patch|minor|major]` (= `pai dev release`, `src/clients/release.ts`): refuses a dirty tree or a branch other
than main, runs the checks, bumps the version as a commit and a `v*` tag, pushes, then waits for the
box to report it. The tag runs CI: checks, a GitHub release with the daemon archive (the checkout with
the web client built), then `POST /update` on the host (`PAI_URL`, `PAI_TOKEN` repository secrets) and a
wait until `/health` reports the tag. When CI cannot start (GitHub billing, quota), the release script
falls back to `pai update`, which builds the daemon and the web client on the box from the tag.

## Tests

`bun run test` runs every `*.test.ts` in its own process (`scripts/test.ts`), because
configuration is frozen at import. Unit suites cover the protocol, memory and terminals; `test/api.e2e.test.ts` boots the real server on a scratch database and drives it
over HTTP, including a websocket terminal. No test spends model tokens.

## Not done yet

- Permission prompts: sessions run under `bypassPermissions`, so `canUseTool` only carries `AskUserQuestion`.
- Concurrency is unbounded and there is no usage readout.
- Project routing is explicit only — no `@project` prefix, no inference.
- The Telegram fork is designed but not built.
- Cloning a repository is dev's (`POST /projects` there).
- Documents other than images are saved to `inbox/` and mentioned by path only.
