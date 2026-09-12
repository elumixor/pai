# pai for VS Code

The editor client for the pai daemon. It talks to the same HTTP API as Telegram, the web app
and the CLI: nothing here reimplements the daemon.

- **Threads** — every session with its state, opened as a panel with the live event stream, a
  compose box, the interrupt and the question buttons.
- **Projects** — the catalog under `~/dev` on the box. Opening one uses Remote-SSH when
  `pai.sshHost` is set, so the files stay where the sessions run.
- **Terminals** — a PTY on the box rendered as an ordinary editor terminal over the WebSocket.

Works in VS Code, Cursor, VSCodium and `code-server` in the browser.

## Settings

| | |
| --- | --- |
| `pai.baseUrl` | the daemon, e.g. `http://pai:8787` over the tailnet |
| `pai.sshHost` | the SSH host for remote projects; empty opens them locally |

## Build

```sh
bun install
bun run build          # out/extension.js
bun run package        # pai.vsix
code --install-extension pai.vsix
```
