# builder

Tell a Telegram bot what's broken. It figures out which of your projects you mean, and puts
a Claude Code session on it.

builder runs on your machine, next to your repos, using your existing Claude subscription.
There is no server to pay for and nothing to deploy — Telegram reaches it by long polling
from behind the router.

## What it does

- Watches `~/dev` and keeps a catalog of every repo it finds.
- Takes a free-form message and picks the project it's about, using Haiku over that catalog.
- Starts a real Claude Code session in that project's directory, or continues one that is
  already working on the same thing.
- Streams what each session does back into the chat. Reply to a session's message to send it
  a follow-up.
- Knows about sessions it didn't start — anything you launched in a terminal shows up in
  `/ps` too.
- Routes requests about builder itself to builder's own repo, so you can ask it to change
  the thing you're talking to.

## Setup

```sh
bun install
cp .env.example .env      # TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
bun run daemon
```

Then message the bot. `/ps` for what's running, `/projects` for the catalog, `/kill <id>` to
stop a session.

Everything the bot does is also a CLI command — see `CLAUDE.md`.

To keep it running across reboots:

```sh
bun scripts/install-daemon.ts            # launchd user agent, --uninstall to remove
```

## Dashboard

`web/` is a small SvelteKit status page on Vercel, for checking on things from a phone. The
daemon pushes a state snapshot to it every couple of seconds; the page never reaches back
into the machine, so nothing has to be exposed to the internet.

Set `BUILDER_DASHBOARD_URL` and `BUILDER_DASHBOARD_SECRET` to turn it on. The same secret
gates reads — open the page once as `https://<url>/#k=<secret>` and it's remembered.

## Requirements

Bun, and the Claude Code CLI logged into a subscription.
