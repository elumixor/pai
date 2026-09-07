# pai

A personal assistant you talk to from Telegram. It runs on your Mac, next to your files,
your browser, and your Claude subscription, and it can do things: search the web, read and
send email, look at your calendar, drive a browser, work in your repositories.

The chat is the interface. Short answers land in the main conversation; anything bigger
becomes a task with its own topic, its own context, and a live status card at the top.
Several tasks run at once. Reply in a topic to steer that task; reply in the root to talk to
the assistant.

## How it is built

- One Claude Code session per conversation, driven through the Agent SDK. The main chat is
  one session; every task is another. Sessions survive restarts: the process is disposable,
  the transcript on disk is not.
- Telegram is a grammY bot polling from behind your router. Nothing is exposed to the
  internet. Text streams into the chat as a draft while it is generated; questions arrive as
  buttons.
- Tools come from Claude Code itself: shell, files, web search, the claude.ai connectors
  you have set up (Gmail, Calendar, Drive, Notion, …), Playwright for a browser, and a small
  in-process set for starting and steering tasks.
- With `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_USER_SESSION` set, the assistant also
  has your own Telegram account: it can read your chats, search them, and (after asking)
  write to people as you.
- A menu bar item shows what is running; `install` builds and loads it.
- A SvelteKit page on Vercel shows every session and event for the moments the chat is not
  enough. The daemon pushes a snapshot to it; it never reaches back.

## Setup

```sh
bun install
cp .env.example .env      # TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
bun run daemon            # foreground
bun run src/cli.ts install   # launchd user agent + `pai` command on PATH
```

## Updating

`pai update` pulls the repo, reinstalls dependencies, rebuilds the menu bar app and
restarts the daemon; `--force` rebuilds without new commits, `--check` only reports.
An installed daemon also does this on its own every 30 minutes when new commits are on
the upstream branch, the working tree is clean and nothing is running — set
`PAI_AUTO_UPDATE=0` to keep updates manual.

Then message the bot. `/new <title>` starts a task by hand; anything else is plain
language. Enable topics for the bot in @BotFather (Bot Settings → Threads Settings → Threaded Mode) so every task
gets its own thread; without that, tasks share the root chat and you reply to a task's
message to talk to it.

Everything the bot does is also a CLI command — see `CLAUDE.md`.

## Dashboard

`web/` is the status page. Set `PAI_DASHBOARD_URL` and `PAI_DASHBOARD_SECRET` to turn on
the push; open the page once as `https://<url>/#k=<secret>` and it is remembered. Deploy
with `cd web && vercel deploy --prod`.

## Requirements

Bun, and the Claude Code CLI logged into a subscription.
