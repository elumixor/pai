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
bun run src/cli.ts projects                # catalog exactly as the router sees it
bun run src/cli.ts route "<text>"          # routing decision only — never spawns
bun run src/cli.ts message "<text>"        # full path: route, then spawn or continue
bun run src/cli.ts spawn <project> "<text>"
bun run src/cli.ts send <shortId> "<text>"
bun run src/cli.ts ps                      # builder sessions + every other claude session
bun run src/cli.ts tail [shortId] [--raw]  # follow events; --raw for the unparsed stream
bun run src/cli.ts events [shortId]
bun run src/cli.ts kill <shortId>
bun run src/cli.ts routings                # recorded routing decisions, for accuracy work
```

`--json` on any command for machine-readable output. Session ids are accepted in full or as
the 6-char short form.

Iterate on the router with `route`, which is side-effect free apart from the `routings` row.

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

## Routing

Three stages, cheapest first, in `src/router.ts`:

1. Reply to a message builder sent → that message's session (`tg_messages` table).
2. `slug:` or `@slug` prefix → that project.
3. Haiku over the project catalog and the live-session list, with structured output. Low
   confidence produces an inline keyboard instead of a guess.

The router runs `claude -p --model haiku` with `--system-prompt` overriding the default
prompt and `--tools ""`; without that override every call pays for ~7k tokens of unused
Claude Code system prompt.

Repos with no README route badly. Fix them in `projects.json` (slug → summary + aliases),
which is merged over what the scanner infers.

## Layout

- `src/catalog.ts` — scans `~/dev` two levels deep for git repos, describes each.
- `src/session.ts` — one Claude Code process, the stream-json protocol, event emission.
- `src/sessions.ts` — registry, revival, and the union with `claude agents --json`.
- `src/router.ts` — the three-stage routing cascade.
- `src/handler.ts` — message → session work. Frontend-agnostic; both CLI and Telegram use it.
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
