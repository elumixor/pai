# pai

Personal assistant that runs on a box (Hetzner) and is used from a browser (the web client at `/`),
a Mac (`pai …`, the menu bar app) and from Telegram. The core here is the daemon: sessions (one Claude Code
session each, over the Agent SDK), the HTTP API, the client. Everything else is
a module from its own repository (`pai.config.ts`): `pai-browser` (a signed-in headless browser on the
box, one session per site, logins captured from the Mac's Arc), `pai-dev` (the machine and writing code),
`pai-telegram` (the chat and the user's account), `pai-email` (Gmail mailboxes), `pai-linkedin` (requires browser),
`pai-whatsapp` (his own number over the WhatsApp Web protocol, linked by QR — unofficial, so the
risk is a ban on his number and the module never sends in bulk; a send is read back out of the chat
and answers `verified`/`unverified`/`not_sent`). A module's
`requires` orders loading; `ctx.use(name)` hands it another module's `api`. pai is one chat (the
orchestrator, `main.ts`): Telegram's pai topic, Paigram's bot chat, `pai dev say`. Its staff are agents
(`agents.ts`): standing (own an area, own topic), sub (one job, reports once, closes), service (answers
requests, e.g. Voice); depth pai › standing › sub. Other topics and `pai claude` are plain threads (`chat`);
a builder thread in a repo is `code`.

## Where things live (the Dsk split)

pai core is the assistant only: sessions over the Agent SDK, `main.ts` and the agents, tasks, asks, drafts,
requests, automations, triage, recall, memory, journal, spend/usage/models, the HTTP API + SSE, auth, the module
SDK and loader, the CLI, and the self-update. Everything about the host machine or writing code is the `pai-dev`
module (`elumixor/pai-dev`, `modules/dev`): Mutagen files sync, code-server + its `vscode/` extension, the catalog of
repos, the terminal mirror and channel, the menu bar app, the release check, install, release, `infra/`, Caddy, and
the coding threads (pai-builder, archived). Core runs without it: no repos, loopback + token. Projects, tasks and docs live in Kip
(`elumixor/kip`, `kip:page/<id>` URNs, an MCP); pai knows Kip, Kip never knows pai.

Modules come in two kinds (`sdk.ts`): a **connector** (`kind: "connector"`, a signed-in outside channel —
`pai-telegram`, `pai-email`, `pai-linkedin`, `pai-whatsapp`) exposes `connector.status(ctx)` (signed in / signed out /
broken, with the link that fixes it), its `events`, its `tools`, and `connector.send` answering
`verified | unverified | not_sent`; `GET /connectors` lists them in that one shape for the clients. A
**capability** (`kind: "capability"`: `pai-browser`, `pai-dev`) is something the box can do. Each
module repo has the same layout: `index.ts` default export, a one-paragraph `CLAUDE.md`, `README.md`, tests next to
the code, `bun.lock`, `biome.json` extending `pai/biome.json` (resolved through the module's `node_modules/pai`).
The order of `pai.config.ts` is the order clients list modules; loading follows `requires`.
pai's `biome.json` is lint only (formatter off): `bun run lint`.
Self-update stays in core (`src/domain/update.ts`: `POST /update` + the auto-update tick, then every module clone pulled), so a module that fails to load never leaves the box unable to update.

## Feedback loop

Never test through Telegram. The CLI drives the identical code path.

```sh
pai claude [--resume [id]] # a new conversation with the assistant on the box; --resume <id> continues a thread
pai status | cost
pai threads [project]      # every conversation by project; in a terminal a list to pick from: the choice runs
                           # `pai claude --resume <id>` (that thread's directory and model). `projects` = same
pai tools | skills | instructions | memories [name]   # what sessions are given (`GET /context`); a name prints one
pai completion                      # installs zsh completion (src/clients/help.ts is the one table: help + completion)
# pai-dev's verbs: ssh|connect, files|fs, sync, update, menubar, channel; `pai dev install|release|infra|code|editor`

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
bun run dev                # the web client (Vite, port 5180) against the box
bun run test:web           # Playwright: the web client against a scratch daemon
bun run setup              # = `pai dev install`: the web client, the service, `pai` on PATH, the menu bar app on macOS
```

`--json` on any command. Session ids in full or as the 6-char short form. `pai` is
`bun run src/clients/cli.ts`; the user-facing commands are the first block, `pai dev` is the
daemon's own controls and stays out of `pai --help`. A module's `verbs` are top-level words (`pai files`) and a
`pai dev <sub>` core does not know goes to the module named `dev`.

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
click in the Cloud console, not code. The email module (`pai-email`) asks every mailbox for its grant at start and
daily, and an expired or short grant becomes a `waiting_user` task with the reconnect link.

A connector's grant is fixed at the moment it was connected: an account connected before a module
widened its scopes cannot use the new one until it is reconnected (`/gmail/connect?label=<name>` for
a mailbox), and the failure shows up as a 403 mid-task. Widening scopes means asking the user to
reconnect every account, so say so in the same breath as shipping it.

`AskUserQuestion` reaches `canUseTool` even under `bypassPermissions`. It becomes a
`session.question` event; Telegram renders buttons, the CLI has `answer`.

## pai and its staff

- `src/domain/main.ts` — pai's session (agent `pai`): user messages, system turns (`system`, shown) and housekeeping (`silent`, never shown). Rotates at `PAI_ROTATE_HOUR` (04:00, `PAI_TIMEZONE`) or at 50% context: the old session writes `journal/<day>.md` + MEMORY.md, a fresh one starts from a briefing (open tasks, asks, staff, journal, last 20 messages).
- `src/domain/agents.ts` — rows + folders `workspace/agents/<slug>/` (CLAUDE.md imports STATE.md); sessions resumed if active within a day, else fresh; ≤ `PAI_MAX_AGENTS` working (coding ×2), the rest queue; per-agent daily turn and per-turn minute budgets; a report (turn text) reaches the agent above, and goes on up while each agent in the chain has `bubble` on (`configure_agent`, the info pane's toggle; pai is the top); sub-agents close after reporting; tools = capabilities matched against the MCP server names (`capabilities.ts`: aliases like `browser` → `playwright`, `calendar` → Balance; one matching no server is warned about at creation and carried as `unresolvedTools`); connectors denied by prefix.
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
- `src/domain/prompts.ts` — instructions appended to the Claude Code system prompt, per session kind: the general part, the role, then `# Instructions (from <module>)` per module that adds a paragraph.
- `src/domain/projects.ts` — the projects sessions run in: the workspace's contexts plus each module's `ProjectSource` (pai-dev: repos under `~/dev`); none without one. `src/domain/held.ts` — threads held outside the daemon (a terminal's) that a message still reaches, from a module's `HeldThreads`.
- `src/api/app.ts` serves `apps/web/build` at `/`: `index.html` `no-cache`, `/_app/immutable/*` (content-hashed) `immutable`, so a release can only arrive whole. `/ui` and `/app` redirect to `/`.
- `src/api/` — `server.ts` (transport, the terminal websocket, the client), `routes.ts`, `events.ts` (SSE), `port.ts`, `app.ts` (serves the client at `/`), `auth.ts` (`PAI_TOKEN` for programs, a Clerk session (`clerk.ts`) or the Google session cookie for browsers; loopback and the bundles are exempt — a route that answers `401` to curl is not broken for him: with a browser's `Accept: text/html` the same route redirects to Google sign-in and on to where he was going, so check a page with an HTML accept header before calling it unreachable), `handoff.ts` (the editor subdomain signs in with a one-minute ticket from the main host, since Clerk's cookie is per host), `google.ts` (Sign in with Google: `PAI_GOOGLE_CLIENT_ID/SECRET` in `.env`, `PAI_GOOGLE_ALLOWED` emails; `/auth/check` is Caddy's forward_auth for the editor).
- Caddy (public https, `/editor`, the editor subdomain) is pai-dev's `start`; core only binds its API port and answers `/auth/check`.
- Files sync (`pai files`, Mutagen), `/sync`, the menu bar app: pai-dev (`files.ts`, `sync.ts`, `menubar/`); its README holds the rules.
- `src/clients/telegram.ts` — grammY frontend: routing by topic / reply, draft streaming, live cards, question keyboards, attachments.
- `src/clients/tg-user.ts` — the user's own Telegram account (gramjs, `TELEGRAM_USER_SESSION`) as the `tg` MCP server.
- `src/clients/cli.ts` — the CLI over the HTTP API.
- `src/domain/transcript.ts` — a thread's conversation read from `~/.claude/projects` (`GET /transcript`).
- The terminal mirror and `pai channel` (`/channel?session=`) are pai-dev's (`mirror.ts`, `channels.ts`, `channel-server.ts`); core keeps `POST /attach`, `/adopt` and the `code` kind.
- `src/domain/settings.ts` — the editable settings in `data/config.json`, merged over the environment at import (`GET`/`PATCH /settings`; a change needs a restart).
- `src/protocol/rich.ts` — metadata trailer: plain text for stock clients, structured for ours.
- `src/host/remote.ts` — the box as `PAI_REMOTE` (`user@host`, default `pai@$PAI_HOST_IP`), ssh with port 22 opened for this machine's public address on the Hetzner firewall, and `boxApi()` — the box's https address and token learned once over ssh into `~/.config/pai/box.json`, which every CLI command then uses. `pai claude` from a Mac is `pai claude` on the box over ssh; there it is `claude` in the workspace (a new conversation; `--resume` is claude's picker; modules' `claudeArgs` are added). `POST /attach {id, cwd}` hands a daemon session to a terminal; `POST /adopt {id, cwd, title}` makes a conversation held on disk a live session without a turn (Paigram opens synced threads with it). Host install, update of a laptop, the release check and the menu bar are pai-dev's.
- The browser editor (code-server on `PAI_EDITOR_PORT` 8788 with pai-dev's `vscode/` extension; `PAI_NO_EDITOR`, `PAI_EDITOR_BIND`, `PAI_EDITOR_DOMAIN`) is pai-dev's.
- `apps/web/` — the web client (SvelteKit SPA, Svelte 5, Tailwind 4), served by the daemon at `/` with its routes in the hash (`/#/tasks`), so no client route can shadow an API path. Only the chat with pai, in the spirit of Paigram: the chat (`ChatView`: the log for an agent, the turn streaming in with its tool calls folded, asks with their buttons, drafts as editable cards with Send and Discard, `AskUserQuestion` answered in place, pictures attached or pasted), the threads tree (agents under pai, sub-agents under them, each a chat), tasks (waiting on me / working / scheduled / done, with the need's buttons), connectors (`GET /connectors`) and skills (`GET /context`). A `kip:page/<id>` in a message becomes `<kip-pill>` from Kip's own `elements.js` (`PAI_KIP_URL`). Sign-in: Clerk (the account shared with Kip; `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY`, `PAI_ALLOWED` emails) or a `?token=` link. `bun run dev` = Vite on 5180 against the box (`~/.config/pai/box.json`); `bun run test:web` = Playwright against the daemon on a scratch database (`test/web/server.ts`, a control port puts replies, asks and drafts on the bus; no session ever starts).
- `src/domain/claude-login.ts` — the box's own Claude login. An `authentication_failed` turn is no reply: it raises one `waiting_user` task linking `/claude/login` (runs `claude auth login`, the user pastes the code back), closed by the next turn that gets through; pai then answers what went unanswered.
- `src/domain/usage.ts` — the Claude subscription's windows (`GET /usage`) with the Claude Code login on the machine, plus what the sessions cost. Never copy a Mac's login to the box: refresh tokens are single-use, so two machines on one login sign each other out.
- `src/domain/spend.ts` — the ledger of every model call: Claude Code responses read from all transcripts (daemon, terminals, sub-agents; `msg:<id>` dedupes the per-block repeats), triage results, gateway calls. Priced at API list rates; `GET /spend?days=`, `pai cost [days] [--by …]`, settings › Spend show it beside the real price (`PAI_CLAUDE_PLAN_USD` for the period, shared by API price, + metered).
- `src/domain/models.ts` — Claude models from the Models API (daily, `data/models.json`); a family name (`opus`, `sonnet`, `haiku`, `fable`) resolves to its newest id for every session, triage and the picker (`GET /models`). Claude Code's own aliases lag the SDK.
- `src/domain/credits.ts` — small jobs (summaries, headlines) on the Max plan's monthly API credits via `PAI_ANTHROPIC_API_KEY` (Console org ATMA), falling back to the gateway when they run out. Never name it `ANTHROPIC_API_KEY`: Claude Code would bill every session to it.
- Sessions compact at `PAI_COMPACT_WINDOW` tokens (200k, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`): a 1M context re-read on every tool step made long-lived agents cost ~$300/day at API prices. pai rotates at 75% of it.
- `src/modules/` — `sdk.ts` is the contract for modules from their own repositories (`pai.config.ts` names them, `pai.config.local.ts` overrides with a path while working on one; installed under `modules/<name>/`, gitignored). A module's `index.ts` default-exports `(pai: PaiSdk) => PaiModule`: tools (an MCP server per session), prompt paragraphs per session kind, skills (linked into `workspace/.claude/skills`), `cli` (`pai <name> …`, run on the box; a Mac forwards over ssh unless `cliHere`), `verbs` (top-level `pai <verb>`), `claudeArgs`, `projects` (a `ProjectSource`), `held` (`HeldThreads`), `routes` (`/m/<name>/…`), `mounts` (paths outside `/m/`, behind auth, e.g. `/gmail/`), `accounts` (the dashboard's connect/forget list), `ui` (`/m/<name>/ui/`), start/stop/health; `tools.server` names its MCP server (default the module name). The context hands it `setting`, `projects`, `messages.event`, `tasks`, `recall.put`, `cursors`, `watch.keep`, `update.status`, `auth.sign/origin` and `auth.onGoogleCallback(claim, finish)` (`/auth/google/callback` passes a verified state carrying that claim to the module). pai's own code reads a module's `api` with `external.api(name)`. `external.ts` installs (git clone, or a link for a path), loads, starts them (`PAI_MODULES_CONFIG`/`PAI_MODULES_DIR` point a scratch daemon at modules of its own); `pai modules` lists, `pai modules update` pulls them all and restarts. The box's ssh key is on the GitHub account, so private module repos clone. `index.ts` is the registry of the built-in pieces: each = tools + a prompt paragraph + bus events + settings, described for the dashboard (`GET /modules`, one list with `external: true` on the loaded ones). Mailboxes are the `email` module (`pai-email`): MCP server `gmail`, `gmail_*` tools, table `gmail_accounts`, `/gmail/connect?label=<name>`; its README holds the OAuth and scope rules.
- `src/domain/triage.ts` — 5-min batches, Jev (decision model) routes. A group message is the one thing it may not delegate on its own judgement (`delegatable`): a chat post reaches an agent only when he wrote it, Telegram says he was addressed in it, or the agent's brief names that chat by title — otherwise it stays an event in the log. A small model will tie anything to a brief that mentions chats at all, and his groups are personal, so a misroute has to cost nothing.
- An agent's status is **derived, not written**: `settle()` runs every minute and both clears `working` when no live session of its own exists and marks `working` when one is busy, because a turn that never ends (the daemon restarted by the release that turn cut) and a turn the daemon never sent (one resumed after a restart) are the same lie in opposite directions. Thinking and tool calls on the bus say the same thing for a turn nothing woke.
- `src/domain/limits.ts` — the account's own limit as it actually arrives: the turn's own reply text ("You've hit your session limit · resets 5:10pm (UTC)"). Shown as a message it reads as something pai said, and the work the turn was doing is lost — two agents had to be re-sent their briefs by hand on 19 October. So a turn ending this way is not a report: it becomes one quiet `rate_limited` event row, and the same turn is held (on disk, so a restart keeps it) and sent again a minute past the reset. pai's own turn holds his message instead and asks it again.
- `src/domain/watch.ts` — what an observer does with what it found: one task per fault, its reason kept current, closed when the thing answers, and **reopened** when a flapping fault comes back, with the return counted in its notes. LinkedIn's fault came and went eleven times between 12 and 15 October and each episode opened its own row — nothing duplicated at any instant, eleven identical tasks all the same, and a watcher that floods is one he learns to scroll past. A task he dropped himself is never reopened.
- `src/domain/browser-check.ts` — does the browser still work? Every module reading a signed-in site and every session's browser tools go through the one Playwright MCP server, and nothing watched it. Both questions are ones that cannot be answered from inside it: does it answer a read made **now** (a dead server makes callers hang, not fail — `/inbox` returning nothing in 280s was this), and has it been dying under the sessions holding it (`mcpState()` counts the restarts). Its own timer, one task through `watch.ts`.
- `src/domain/linkedin-check.ts` — does pai still see LinkedIn? Both edges are faults: a session that cannot read (not started, signed out, a failed or stopped poll) and one that reads but has heard nothing for longer than his own traffic ever goes quiet — from the inside those look the same, which is what the phantom sends were. One task, its reason current, closed when LinkedIn answers again; its own timer, outside the module, because an observer sharing a loop with what it watches dies with it. A read it could not make says nothing at all.
- `src/domain/snapshot.ts` — the state of things as one markdown document (MEMORY.md, each agent with its brief and STATE.md, open tasks, open asks, routines, project contexts): `GET /snapshot`, `pai snapshot [export [file]]`, settings › Snapshot › Export. `POST /snapshot {text}` / `pai snapshot import <file>` / Import hands it to pai as a turn with instructions to rebuild what is missing and change nothing else.
- `src/domain/audit.ts` — the trail of outward tool calls (sends, writes, clicks in signed-in sites; a verb in the tool name, pai's own servers excluded) with full input and result; `GET /audit`, `pai audit`, the `audit` tool.
- `src/domain/automations.ts` — `on <event> → notify | turn | task`, rows in the `automations` table, run from the bus; tasks capped at 6/h. `GET/POST/PATCH/DELETE /automations`.
- `src/domain/drafts.ts` — an outbound message as a **card**, which is the approval. A draft used to be markdown in a chat row approved by typing "send", so changing a word meant copying the text out. Now an agent offers one (`offer_draft`: email with from/to/cc/subject/body, a Telegram or WhatsApp message, a LinkedIn reply, a post) and it becomes a row he edits in place, with Send and Discard on it. Two rules shape it: **what goes out is what the card holds when he presses Send** (the fields live in `drafts`, his last keystrokes ride along with the Send, and the wake reads them at that moment — never what the agent first wrote), and **the agent that offered it sends it**, through its own channel tool, so the read-back verification stays where it is and comes back onto the card as `verified` / `unverified` / `not_sent` (`draft_result`). A pending draft is a need, so the hand counts it; the chat row is updated in place (`messages.update`), so a client that only has the log is never shown the old words. **Two pending drafts of the same message cannot exist**: on 21 October pai and Job search each offered the identical Amin follow-up, and a Send on both would have put the same mail in a founder's inbox twice — so `offer_draft` refuses a clash (same channel and recipient, and either the same subject or a body ≥0.7 alike by word overlap) and **hands back the pending card's id**, which is what lets the caller report the collision instead of guessing. Its answer always lists what is already pending for that channel, because nothing else in an agent's tool set could tell it; and `withdraw_draft` lets an agent take back its own pending draft — a rule that can only be obeyed with a database write is not a rule but a trap.
- `src/domain/attachments.ts` — attached images kept by hash next to the db (`GET /attachments/<name>`); a terminal gets them through its channel as `[image: <local path>]` lines, which the transcript turns back into images.
- `src/domain/inventory.ts` — what each session kind reported at its start (tools, MCP servers and their status), in memory and in `data/inventory.json`. Its own module because both `context.ts` and `capabilities.ts` read it and must not import each other: configuration is frozen at import, so a cycle in this layer is a startup-order bug waiting for a different entry point.
- `src/domain/capabilities.ts` — where an agent's tools list (capabilities) meets the MCP server names: the aliases (`browser` → `playwright`, `calendar` → Balance), `serverAllowed`, `narrowed` (a sub-agent against its parent), `unresolved` (declared, no server) and `unavailable` (offered but dead — denied or never signed in, each paired through the aliases with the live server that answers the same capability). `prompts.ts`'s `missingTools` turns both into one generated "# Tools you do not have" paragraph in every session; the context view says the same on the server's line. Generated, never a written list, so it cannot go stale.
- `src/domain/context.ts` — what each session kind is given (instructions, memories, skills, tools) with the surfaces that see it (`GET /context`, `pai tools|skills|instructions|memories`, the dashboard, Paigram's settings). Tools come from the newest session init per kind (`noteInit`: the SDK's tool list and MCP server states), memories from `workspace/MEMORY.md` plus Claude Code's own `~/.claude/projects/<cwd>/memory/`.
- Projects are repos under `devRoot` or **contexts**: `workspace/projects/<slug>/` with a `CLAUDE.md` (voice, rules, what to remember about it). `POST /projects {name, about}` creates one; a task in it runs with that directory as cwd.
- `infra/` (Hetzner provision, cloud-init, bootstrap, firewall, borg) and `menubar/` are pai-dev's: `pai dev infra`, `pai menubar`.
- `workspace/` — the assistant's cwd; `CLAUDE.md` there is the persona, `inbox/` gets attachments.

## Releasing

A release must run inside a tool call the turn is waiting on: a detached child (`nohup`, `setsid`,
`systemd-run`) still belongs to the turn's process group and is killed the moment the turn ends, so
`nohup bun run release &` dies mid-checks and nothing is tagged — it looks exactly like a refused
release. The same holds for anything gathering evidence in the background.

The release restarts the daemon, which kills the session that ran it: finish the report before
`bun run release`, never after, or it is lost mid-sentence.

`bun run release [patch|minor|major]` (= `pai dev release`, pai-dev's `release.ts`): refuses a dirty tree or a branch other
than main, runs the checks, bumps the version as a commit and a `v*` tag, pushes, then waits for the
box to report it. The tag runs CI: checks, a GitHub release with the daemon archive (the checkout with
the web client built), then `POST /update` on the host (`PAI_URL`, `PAI_TOKEN` repository secrets) and a
wait until `/health` reports the tag. When CI cannot start (GitHub billing, quota), the release script
falls back to `pai update`, which builds the daemon and the web client on the box from the tag.

## Tests

`bun run test` runs every `*.test.ts` in its own process (`scripts/test.ts`), because
configuration is frozen at import. Unit suites cover the protocol, memory and terminals (a module's suites run
too, under `modules/`); `test/api.e2e.test.ts` boots the real server on a scratch database and drives it
over HTTP, including a websocket terminal. No test spends model tokens.

## Not done yet

- Permission prompts: sessions run under `bypassPermissions`, so `canUseTool` only carries `AskUserQuestion`.
- Concurrency is unbounded and there is no usage readout.
- Project routing is explicit only — no `@project` prefix, no inference.
- The Telegram fork is designed but not built; the VS Code extension is unpublished and untested inside a real editor host.
- Documents other than images are saved to `inbox/` and mentioned by path only.
