# Where this is going

pai is one piece of a personal system that also includes a Telegram client fork
(`~/dev/telegram`, deployed as "Air") and an editor fork (`~/dev/zed`). This document
records what exists today, what is broken, and the order in which the rest gets built.

## Today

| Piece | Repo | Runs where | State |
| --- | --- | --- | --- |
| pai daemon | `elumixor/pai` | GCP `pai-vps`, systemd user service | live, Telegram only |
| pai dashboard | `elumixor/pai` (`web/`) | Vercel `pai-elumixors-projects` | read-only status page, secret in the URL |
| Air web client | `elumixor/telegram-air` | Vercel `telegram-air` | fork of Telegram Web A, AI summaries + transcription |
| Air AI backend | same repo, `server/` | Vercel `air-ai-server` | Hono, calls Vercel AI Gateway |
| Air desktop / iOS | same repo, `tauri/` | local build / TestFlight | webview onto the deployed web build |
| Zed fork | `elumixor/zed` | local build | Claude Code status bar, hooks, sidebar projects |

The VPS is an e2-micro in `us-central1-a` inside the GCP project
`gen-lang-client-0616773049` — the project Google auto-creates for AI Studio, reused
because a fresh project hit a billing quota wall. Billing is a real account, but the
instance shape is inside the Always Free tier, so the bill is egress only.

## The interface problem

A threaded Telegram bot is a workable remote control and a poor product surface. Topics
are the only structure available, there is no way to show anything that is not a message,
and the client is someone else's. A Mini App does not fix this: it is still a webview
inside a chat, with Telegram's navigation around it.

The way out has three steps, in this order:

1. **Web first.** Turn the read-only dashboard into a real client: send a turn, watch it
   stream, answer an `AskUserQuestion`, browse tasks, read memory. This is the only step
   that needs no other codebase and no app review.
2. **The Air fork as the chat surface.** Air is already a full Telegram client that
   builds for web, macOS and iOS out of one repository. Adding pai's panels there gives a
   real client with custom functionality without maintaining a native fork.
3. **Native only if the webview actually blocks something.** Background execution, push
   notifications and MTProto performance are the plausible reasons; none of them is
   proven yet. `~/dev/telegram-macos` (TelegramSwift) is the reference if it comes to
   that.

## Monorepo: no

Keep the four repositories separate.

Both large repos are forks that survive by merging upstream: `telegram` tracks
`Ajaxy/telegram-tt`, `zed` tracks `zed-industries/zed`. A monorepo turns every upstream
merge into a subtree merge, which is where fork maintenance goes to die. The sizes make
it worse — 104 GB of build output and a 1.6 GB pack against pai's 120 KB — and Web A is
GPL-3, which is not a licence to mix into everything else by accident.

What is worth unifying is smaller: the HTTP contract between pai and its clients, the
design tokens, and the infrastructure definitions. Those become a published package and a
Terraform workspace, not a merged history.

## Plan

### 1. Make the VPS trustworthy (mostly done)

- [x] `install-daemon*.ts` wrote `ExecStart=/tmp/bun-node-*/bun` — bun's temporary node
      shim directory, which does not survive a reboot. Now `process.execPath`.
- [x] A second poller on the bot token made `getUpdates` fail with 409, which rejected out
      of Telegram startup and killed the daemon; systemd restarted it 872 times. Polling
      now retries instead of exiting.
- [x] Ubuntu's Node 18 is below Playwright's minimum, so the browser MCP server crash
      looped every five seconds. Node 22 installed.
- [ ] Rotate `CLAUDE_CODE_OAUTH_TOKEN`: it was pasted into a shell command whose text is
      visible in the Telegram card and in the session transcript.
- [ ] Memory: 1 GB with ~640 MB resident and swap already in use. Headless Chromium plus
      several Claude sessions will not fit. Either cap concurrency and keep the browser
      off by default, or move to a shape with 2-4 GB (leaves the free tier, ~$7-15/mo).
- [x] Reboot test: hard reset of the instance, service back up and polling on its own.

### 2. Reach the daemon from the internet

The daemon binds `127.0.0.1:8787` and nothing is open inbound but SSH. The web client
needs a path in that does not mean opening ports and running certificate renewal.

- Cloudflare Tunnel from the VPS, fronted by Cloudflare Access with an email allowlist.
  No inbound ports, no certificates to renew, free at this size.
- The alternative — Caddy on 443 with Let's Encrypt — is more moving parts for the same
  result and puts the box directly on the internet.

### 3. The web client

- Replace the `?k=<secret>` gate with real sign-in. Access in front of the tunnel already
  authenticates; the app reads the identity header rather than implementing login.
- Server-sent events for `session.delta` / `session.text` / `session.tool`, so the page
  streams the way Telegram already does.
- Compose box, task list, `AskUserQuestion` buttons, memory browser, attachment upload.
- Installable PWA — this is what replaces reaching for Telegram on a phone.

### 4. Air as the chat surface

- Point Air's AI backend at pai instead of the standalone `air-ai-server`, so one brain
  serves both.
- A pai panel inside Air: the same session views as the web client, rendered as a client
  screen rather than a chat.
- Keep shipping through Tauri to TestFlight; the release path already exists.

### 5. Shared pieces

- `@elumixor/pai-client`: the request/response and event types, generated from one
  definition and consumed by the web client and Air.
- Terraform for the Vercel projects, the GCP instance and the DNS, so the infrastructure
  is reproducible instead of remembered.
