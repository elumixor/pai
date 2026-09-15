# pai desktop

The client the work happens in: a Tauri window around a small TypeScript bundle. It talks to
the pai daemon over the same HTTP API as Telegram, the CLI and the web app.

Laid out like an editor, four columns:

- **Files** — the tree of the selected project, and under it the status line: what the
  sessions have cost, how much of the five-hour Claude window is used, how long until it
  resets.
- **Editor** — a read-only viewer for a file, or the dashboard, or the settings. Under it the
  **terminal dock**: every shell open on the box, labelled by its directory and what is
  running in it, one of them shown.
- **Threads** — a thread's messages as `claude --resume` shows them, read from the transcript
  on disk, with the reply streaming in as it is written, tool calls as chips and a question as
  buttons. A second thread opens below it with shift-click.
- **Projects** — every project with its threads under it, a link to its repository, a button
  for a new thread in it, and at the bottom a way to add a project by cloning it.

Panels resize by dragging the gaps between them, and the layout is remembered.

It opens offline: reads fall back to the last answer the daemon gave, and a message written
while the box is unreachable waits in an outbox and goes out when it answers.

```sh
bun run dev               # the client in a browser tab, rebuilt and reloaded on every save
bun run desktop           # build the UI, run the window
bun run desktop:build     # a .app and a .dmg in desktop/src-tauri/target/release/bundle
bun run desktop:install   # the same app, in /Applications
```

A release tag builds a universal `.dmg` on CI and attaches it to the GitHub release as
`pai-macos.dmg`; the web client links to it. It is ad-hoc signed, so after installing run
`xattr -cr /Applications/pai.app` once.

The daemon serves this same bundle at `/ui`, so the client is also a web page: open
`http://pai:8787/ui/` — or the public address, with the token in the link.

`ui/` is the whole client; `src-tauri/` is an empty Rust shell that opens a window.
