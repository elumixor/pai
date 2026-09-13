# pai

A personal assistant you talk to from Telegram. It runs on a machine of its own, next to
your files and your Claude subscription, and it can do things: search the web, read and
send email, look at your calendar, drive a browser, work in your repositories, open a
terminal and install what it needs.

The chat is the interface. Short answers land in the main conversation; anything bigger
becomes a task with its own topic, its own context, and a live status card at the top.
Several tasks run at once. Reply in a topic to steer that task; reply in the root to talk
to the assistant.

## How it is built

One API, many thin clients. The daemon exposes projects, sessions, events and terminals
over HTTP; Telegram, the web app, the CLI and the menu bar are all clients of it.

- One Claude Code session per conversation, driven through the Agent SDK. The main chat is
  one session; every task is another. Sessions survive restarts: the process is disposable,
  the transcript on disk is not.
- Telegram is a grammY bot that polls, so nothing is exposed to the internet. Text streams
  into the chat as a draft while it is generated; questions arrive as buttons. Messages
  read correctly in any client and carry structured metadata in a trailing link for one
  that knows how to render it.
- Tools come from Claude Code itself: shell, files, web search, the claude.ai connectors
  you have set up (Gmail, Calendar, Drive, Notion, …), Playwright for a browser, and a
  small in-process set for starting and steering tasks.
- With `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_USER_SESSION` set, the assistant
  also has your own Telegram account: it can read your chats, search them, and (after
  asking) write to people as you.
- The web app at `/app`, over the tailnet, is the one place everything is visible:
  **Overview** (version, uptime, host, settings, projects, restart and update),
  **Threads** (every session, its live event stream, a compose box and an interrupt),
  **Terminals**, **Files** (projects, workspace and the repo, read-only), and
  **Library** (the instruction documents and long-term memory).
- A menu bar item on macOS shows what is running and opens the dashboard. It reads its base
  URL from `~/.config/pai/menubar`, so it works against a daemon on another machine.

## Layout

| | |
| --- | --- |
| `src/core` | configuration, logging, the event bus, SQLite |
| `src/domain` | projects, sessions, memory, terminals, tools |
| `src/api` | HTTP routes, the event stream, the terminal socket, the app |
| `src/clients` | Telegram, the CLI |
| `src/protocol` | the rich-message codec, shared with every client |
| `src/host` | service installation and self-update |
| `app/` | the web app the daemon serves |
| `infra/` | provisioning, bootstrap and backup for the host |

`docs/architecture.md` is the decision record; `docs/host.md` is the runbook for the box.

## Setup

```sh
bun install
cp .env.example .env               # TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
bun run build:app
bun run daemon                     # foreground
bun run src/clients/cli.ts install # service + `pai` command on PATH
```

The desktop app (`bun run desktop:install` puts it in `/Applications`, `bun run desktop` runs
it from the checkout) is the fast client: a Tauri window — a native webview
around a small bundle, no Electron — with six things in it and nothing else. Threads grouped
by project in the sidebar, the conversation of a thread as `claude --resume` shows it, a file
tree and a viewer for the selected project, a terminal on the box, and the daemon's settings.
It opens offline: every read is cached, and a message written with the box unreachable waits
in an outbox and is sent when it answers. Settings live on the daemon, so every client agrees
on them.

The daemon also serves an editor: code-server — VS Code in a browser, not a fork — with the
pai extension in it, on port 8788 of the same address as the API. It is a child of the
daemon, so it comes up with it, comes back if it dies, and is rebuilt from the checkout on
every start; a new version needs nothing installed by hand. `http://pai:8788` over the
tailnet is threads, projects and terminals next to the files they are about. `PAI_NO_EDITOR=1`
turns it off, `PAI_EDITOR_PASSWORD` puts a password on it, and `bun run editor` serves it
alone for working on the extension. It is the fallback for a machine with nothing installed;
the desktop app is the one to reach for.

The same client is a web page: the daemon serves it at `/ui`, so `http://pai:8787/ui/` is the
whole thing in a browser with nothing installed.

The API, the dashboard and the editor bind to this machine's Tailscale address when it has
one, and to loopback when it does not — so a box on the tailnet is reachable from other
devices without a tunnel and without being on the internet. `PAI_BIND` overrides it.

## Reaching it from anywhere

The API is remote code execution, so nothing leaves the tailnet without a token. Set
`PAI_TOKEN` to a long random string, then pick one of:

- `PAI_PUBLIC=1` — the daemon runs Tailscale Funnel for itself and logs the address:
  `https://pai.<tailnet>.ts.net/ui/?token=…`, a real certificate, no firewall rule, no port
  forwarding. Without a token it refuses to publish.
- `PAI_BIND=0.0.0.0` and open the port on the host firewall — plain
  `http://<public ip>:8787/ui/?token=…`, no certificate.

The token travels in the link once, is kept in a cookie and in the client's own settings, and
is required on every request that is not the client bundle itself. Requests from loopback (the
CLI, the daemon's own children) are exempt.

The dashboard is the daemon's own web app at `<baseUrl>/app` — `http://pai:8787/app` over
the tailnet, or through `ssh -L 8787:127.0.0.1:8787 pai`.

Then message the bot. `/new <title>` starts a task by hand; anything else is plain
language. Enable topics for the bot in @BotFather (Bot Settings → Threads Settings →
Threaded Mode) so every task gets its own thread; without that, tasks share the root chat
and you reply to a task's message to talk to it.

Everything the bot does is also a CLI command — see `CLAUDE.md`.

## Tests

```sh
bun run test        # unit suites and the end-to-end API suite
bunx tsc --noEmit
```

Each test file runs in its own process, because the daemon reads its configuration once at
import and the suites point it at different scratch directories.

## Updating

`pai update` pulls, reinstalls dependencies, rebuilds the web app and restarts the daemon;
`--force` rebuilds without new commits, `--check` only reports. An installed daemon also
does this on its own every 30 minutes when the working tree is clean and nothing is
running — set `PAI_AUTO_UPDATE=0` to keep updates manual.

What counts as a new version depends on `PAI_UPDATE_CHANNEL`. The default, `branch`,
follows the checked-out branch's upstream, so every push deploys. `tag` follows the newest
`v*` tag instead, which makes a release an explicit `git tag v1.2.3 && git push --tags`
and leaves ordinary commits alone. Either way the host pulls; nothing reaches into it, so
there is no deploy key or SSH access to hand to a CI runner.

## Requirements

Bun, Node 20 or newer (the terminal host and Playwright need it), and the Claude Code CLI
logged into a subscription.
