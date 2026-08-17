# builder

Telegram-driven meta-harness over every Claude Code session on this machine. A free-form
message ("the invoice PDF export is broken") is routed to a project under `~/dev` and turned
into a real Claude Code session running in that project's directory — or into a follow-up
turn on a session that is already working on it.

builder can be asked to change itself: requests about builder route to `~/dev/builder` like
any other project.

## Feedback loop

Never test through Telegram. The CLI drives the identical code path.

```sh
bun run src/cli.ts daemon                  # foreground, verbose, telegram off
bun run src/cli.ts chat "<text>"           # a chat turn — identical path to Telegram
bun run src/cli.ts history [--clear]       # the conversation the agent remembers
bun run src/cli.ts projects                # catalog exactly as the agent sees it
bun run src/cli.ts spawn <project> "<text>"  # skip the agent, drive a session directly
bun run src/cli.ts send <shortId> "<text>"
bun run src/cli.ts ps                      # builder sessions + every other claude session
bun run src/cli.ts tail [shortId] [--raw]  # follow events; --raw for the unparsed stream
bun run src/cli.ts events [shortId]
bun run src/cli.ts kill <shortId>
```

`--json` on any command for machine-readable output. Session ids are accepted in full or as
the 6-char short form.

`chat` shares the daemon's conversation history with Telegram — same memory, same tools. It
is the only loop you need for iterating on the agent.

## How sessions work

One `claude -p --input-format stream-json --output-format stream-json` child process per
session, spawned with `--session-id <uuid>` in the project directory. A user turn is one
NDJSON line on stdin; the reply arrives as `assistant` / `result` frames on stdout.

Two facts that shape the code:

- The CLI emits `system/init` only after it receives its first turn, so a session must be
  writable while still in the `starting` state.
- The process is disposable, the session is not. Everything needed to continue lives in
  `~/.claude/projects/<slug>/<sessionId>.jsonl`, so a dead process is respawned with
  `--resume <sessionId>` and keeps full context. `sessions.ensureLive()` does this.

Sessions run with `--permission-mode bypassPermissions` and edit repos directly — no
worktrees, matching how the projects are already worked on.

## The agent

`src/agent.ts` is a `ToolLoopAgent` (AI SDK v7) over the Vercel AI Gateway — a real chat
agent, not a classifier. It answers questions directly and reaches for tools only when it
needs them: `list_projects`, `describe_project`, `list_sessions`, `session_output`,
`spawn_session`, `send_to_session`, `kill_session`, `rescan_projects`.

Two different model budgets are in play, deliberately:

- The **agent** runs on the AI Gateway (`AI_GATEWAY_API_KEY`, billed per token). It is small
  and frequent, so it stays on a chat-sized model.
- The **sessions** it spawns run on the Claude Code CLI and the subscription. That is where
  the expensive work happens, and it costs nothing extra.

Conversation history lives in the `chat` table, last 40 messages fed to every turn. Session
results are written into that same history by `recordSessionActivity()`, so "did it finish?"
works without a tool call — and works whether the message came from Telegram or the CLI.

Repos with no README describe badly, which is how the agent picks the wrong project. Fix
them in `projects.json` (slug → summary + aliases), merged over what the scanner infers.

## Layout

- `src/catalog.ts` — scans `~/dev` two levels deep for git repos, describes each.
- `src/session.ts` — one Claude Code process, the stream-json protocol, event emission.
- `src/sessions.ts` — registry, revival, and the union with `claude agents --json`.
- `src/agent.ts` — the chat agent and its tools.
- `src/chat.ts` — conversation history.
- `src/server.ts` — localhost HTTP API and the SSE event stream.
- `src/telegram.ts` — grammY long-polling frontend, single private chat.
- `src/bus.ts` — the event log every frontend reads from.
- `src/dashboard.ts` — debounced snapshot push to the hosted dashboard.
- `web/` — SvelteKit status page on Vercel. Deploy with `cd web && bun run build && vercel
  deploy --prod --scope elumixors-projects`. State lives in a private Vercel Blob so any
  function instance can serve it; `BUILDER_DASHBOARD_SECRET` gates both writes and reads.

## Not done yet

- Concurrency is unbounded by design. `rate_limit` events are recorded but nothing throttles
  on them yet.
- `~/dev/gen` and nested repos under a repo that already has `.git` are skipped by the
  scanner, so a few real projects (`atma/services`, `gen/loop-dashboard`) are missing.
- Session output is only relayed to Telegram at turn end. Nothing streams mid-turn.
- History is a flat last-40 window with no summarisation, so a long day of chat eventually
  pushes the morning out of context.
