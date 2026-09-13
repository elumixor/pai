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

## Run

The daemon does this by itself (`src/domain/editor.ts`): on every start it builds the
extension, copies it into code-server's extensions directory, registers it and serves the
editor on port 8788. Nothing is installed by hand and an update of the daemon is an update of
the extension.

`bun run editor` from the repo root does the same without the rest of the daemon, which is
how to work on the extension; reload the editor window after a rebuild.

For a desktop VS Code, point it at the box instead:

```sh
bunx @vscode/vsce package --no-dependencies -o pai.vsix
code --install-extension pai.vsix
```
