# pai

A personal assistant you talk to from Telegram. It runs on a machine of its own, next to
your files and your Claude subscription, and it can do things: search the web, read and
send email, look at your calendar, drive a browser, work in your repositories, open a
terminal and install what it needs.

The chat is the interface. Short answers land in the topic you wrote in; anything bigger
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
  URL from `~/.config/pai/menubar`, so it works against a daemon on another machine. Next to
  it sit two rings for the Claude subscription, read with the Claude Code login on the Mac:
  the five-hour session window and the model-scoped weekly limit. The thin outer arc is the
  time left in the window, the coloured inner arc the share used, the percentage in the
  middle; the menu spells out the reset times.

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
cp .env.example .env               # TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
bun run install                    # builds everything, installs the service, `pai` on PATH, the Mac app
bun run daemon                     # or: the daemon in the foreground
bun run dev                        # the client in a browser, rebuilt on every save
```

`bun run install --no-app` skips the desktop build, which is the slow part. A release (a
`v*` tag) publishes the Mac app as `pai-macos.dmg` on GitHub — the client links to it — and
tells the host to update itself.

The desktop app is the fast client: a Tauri window — a native webview around a small bundle,
no Electron — laid out like an editor. The file tree of the selected project on the left with
the subscription's usage under it; a file viewer in the middle with a dock of terminals on
the box beneath it, each labelled by its directory and what is running in it; a thread and,
if you want one, a second thread beside it; on the right every project with its threads, a
link to its repository, a way to start a thread in it and a way to add a project by cloning
it. Dashboard and settings open in the middle. It opens offline: every read is cached, and a
message written with the box unreachable waits in an outbox and is sent when it answers.
Settings live on the daemon, so every client agrees on them.

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

## Modules, automations, context

The dashboard (⌘2 in the client) is where pai is put together. **Modules** are what it is made
of — the Telegram bot, your own Telegram account, the browser, memory, tasks, LinkedIn, the
editor, the public address, sync — each with the tools it gives sessions, the paragraph it adds
to the prompt, the events it emits and its switches. **Automations** are `on <event> →
<action>` rules: notify you on Telegram, open a conversation with the text, or start a task in a
project — the LinkedIn module's `linkedin.message` into a notification is the two-click case.
**Projects** are repositories, or *contexts*: a directory with a `CLAUDE.md` for its voice and
rules of its own, for work that has no code — travel, hiring. **Context**
lists everything a session is given (instructions, memory, skills, tools) with which surfaces
see it — pai's main, task and code sessions, or a `claude` started in a terminal — and edits it
in place.

## The same files on two machines

A Mac keeps `~/dev` and `~/.claude` in step with the box, two-way over ssh with Mutagen:
`claude` in a project on the box sees the same files, skills and settings as at home.

```sh
pai files                      # what is in sync and what is not
pai files watch                # the same, live; `watch off` / `watch on` pauses and resumes
pai files sync                 # one cycle now; a file changed on both sides is listed and left alone
pai files sync --local         # …or settled in favour of this machine (--remote: the box)
pai files diff                 # the conflicts, side by side
```

Build output (`node_modules`, `target`, `dist`, …), the Claude login and `.git` never travel:
each machine keeps its own clone of a repository (the box makes one from the Mac's origin),
only the working trees are shared.

## A conversation in a terminal

```sh
pai claude                     # a new conversation with the assistant, on the box; --resume picks an old one
pai ssh                        # a shell on the box; `pai ssh <command>` runs one thing there
pai status | sync | update     # this machine and the box
bun run infra                  # the box itself, from nothing: Hetzner server + bootstrap
```

`pai claude` from a laptop goes to the box (`PAI_REMOTE`, `user@host`; by default the Hetzner
host as `pai`) and starts `claude` in the assistant's workspace: its persona and memory, a fresh
conversation. There is no main conversation; a Telegram topic, a terminal and a thread in the
app are all equal. The box's firewall keeps
port 22 closed; each call opens it for this machine's current public address only, through the
Hetzner API (`HCLOUD_TOKEN`).

## Reaching it from anywhere

One setting and nothing installed on any other device:

```sh
pai dev settings PAI_PUBLIC=1 # or the dashboard's settings page
pai dev restart
```

The daemon then runs Caddy as a child of its own: TLS on 80 and 443 with a real certificate,
`/` the client and the API, `/editor` code-server. The hostname is `PAI_DOMAIN` when you have
a domain pointed at the host, and `https://<public ip with dashes>.sslip.io` when you do not —
sslip.io resolves any such name to the address inside it, so no DNS of yours is involved. On
Hetzner the daemon opens 80 and 443 on the project firewall itself (`HCLOUD_TOKEN` in
`.env`); elsewhere those two ports are yours to open. `pai status` prints the address.

The API is remote code execution, so the daemon refuses to publish unless it can say no to
strangers. Two ways in, and either alone is enough:

- **Sign in with Google**, for people in a browser. `PAI_GOOGLE_CLIENT_ID` and
  `PAI_GOOGLE_CLIENT_SECRET` in `.env` are an OAuth client of yours (Google Cloud console,
  type "Web application", with `<address>/auth/google/callback` among its redirect URIs);
  `PAI_GOOGLE_ALLOWED` is the emails that may get in. A page opened without a session is sent
  to Google and comes back with a cookie good for 30 days; the editor is behind the same
  sign-in, checked by Caddy on every request. `/auth/logout` ends it.
- **A token**, for programs. `PAI_TOKEN` is presented as `Authorization: Bearer`, as
  `?token=` in a link (kept in a cookie from then on), or in a client's settings. The CLI,
  the menu bar, the desktop app and the editor extension use it. Write the address on the
  first line of `~/.config/pai/menubar` and the token on the second, and the menu bar app
  and the desktop app on that machine are configured. Without Google sign-in the editor asks
  for the token as its password.

Requests from loopback are exempt, except those the proxy forwarded. There is no token and
no sign-in by default, and none is needed on a tailnet: the daemon binds its Tailscale
address when it has one, and loopback when it does not (`PAI_BIND` overrides it).

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
