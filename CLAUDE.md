# pai

Personal assistant over Telegram. A message in the root chat is a turn in the main Claude
Code session; a message in a topic is a turn in that topic's task session. Tasks are started
by the main session (`start_task` tool), by `/new <title>`, or by the user creating a topic.

## Feedback loop

Never test through Telegram. The CLI drives the identical code path.

```sh
bun run src/cli.ts daemon [-f]             # detached; -f/--foreground = attached, verbose, telegram off
bun run src/cli.ts chat "<text>"           # a main-conversation turn, waits for the reply
bun run src/cli.ts task "<title>" "<text>" [--project <slug>]
bun run src/cli.ts send <id> "<text>" [--wait]
bun run src/cli.ts answer <id|main> "<text>"   # answer a pending AskUserQuestion
bun run src/cli.ts tasks
bun run src/cli.ts stop <id|main> [--kill]
bun run src/cli.ts tail [id] [--raw]
bun run src/cli.ts events [id]
bun run src/cli.ts projects
bun run src/cli.ts update [--check] [--force]  # pull, reinstall, rebuild menubar, restart
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

`AskUserQuestion` reaches `canUseTool` even under `bypassPermissions`. It becomes a
`session.question` event; Telegram renders buttons, the CLI has `answer`.

## Layout

- `src/session.ts` — one SDK session, the event mapping, questions.
- `src/sessions.ts` — registry, main session (`kv.main_session`), tasks, revival, reaper, task→main relay.
- `src/tools.ts` — the in-process `pai` MCP server, one instance per session (bound through a ref, since warm processes exist before their session).
- `src/browser.ts` — one Playwright MCP server per daemon over HTTP; sessions connect instead of spawning `npx`.
- `src/prompts.ts` — instructions appended to the Claude Code system prompt, per session kind.
- `src/tg-user.ts` — the user's own Telegram account (gramjs, `TELEGRAM_USER_SESSION`) as the `tg` MCP server: list/read/search chats, send as the user.
- `menubar/main.swift` — menu bar status app; compiled and loaded by `install`.
- `src/telegram.ts` — grammY frontend: routing by topic / reply, draft streaming, live cards, question keyboards, attachments.
- `src/server.ts`, `src/cli.ts` — localhost API and the CLI over it.
- `src/catalog.ts` — coding projects under `~/dev`; `projects.json` overrides.
- `src/dashboard.ts`, `web/` — snapshot push and the Vercel status page.
- `workspace/` — the assistant's cwd; `CLAUDE.md` there is the persona, `inbox/` gets attachments.

## Not done yet

- Telegram topics need enabling in @BotFather once (Bot Settings → Threads Settings → Threaded Mode); until then tasks share the root chat.
- No per-task budget cap; `maxBudgetUsd` is one option away.
- Documents other than images are saved to `inbox/` and mentioned by path only.
- Concurrency is unbounded.
