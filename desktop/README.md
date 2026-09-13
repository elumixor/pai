# pai desktop

The client the work happens in: a Tauri window around a small TypeScript bundle. It talks to
the pai daemon over the same HTTP API as Telegram, the CLI and the web app.

Six surfaces, on purpose:

- **Threads by project** — every session grouped under the project it runs in; a long group
  scrolls rather than pushing the rest off the screen.
- **The conversation** — a thread's messages as `claude --resume` shows them, read from the
  transcript on disk, with live turns appended as they arrive. Sending a message is the same
  turn a Telegram message or `pai send` would be.
- **File tree** for the selected project, and a **viewer** for a file in it.
- **Terminal** — a PTY on the box, in xterm.
- **Settings** — the daemon's own, so every client agrees; the one local setting is which
  daemon to talk to.

It opens offline: reads fall back to the last answer the daemon gave, and a message written
while the box is unreachable waits in an outbox and goes out when it answers.

```sh
bun run desktop           # build the UI, run the window
bun run desktop:build     # a .app and a .dmg in desktop/src-tauri/target/release/bundle
bun run desktop:install   # the same app, in /Applications
```

The daemon serves this same bundle at `/ui`, so the client is also a web page: open
`http://pai:8787/ui/` — or the public address, with the token in the link.

`ui/` is the whole client; `src-tauri/` is an empty Rust shell that opens a window.
