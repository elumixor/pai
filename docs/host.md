# The host

pai runs on one Hetzner Cloud server, reachable only over Tailscale.

| | |
| --- | --- |
| Type | CX43 — 8 vCPU, 16 GB, 160 GB, ~€16/mo (Nuremberg) |
| Image | Ubuntu 24.04 |
| Inbound | nothing; a Hetzner firewall with no rules, `tailscale ssh` for access |
| Service | `pai.service`, a systemd user unit with lingering enabled |
| Updates | the host pulls the newest `v*` tag by itself (`PAI_UPDATE_CHANNEL=tag`) |
| Backups | borg → Hetzner Storage Box, nightly |

## Building it

Two secrets are needed once: a Hetzner project API token, and a **single-use,
pre-authorised** Tailscale auth key. The Tailscale key ends up in instance metadata, which
is readable from the machine itself, so it must be one that expires on use.

```sh
HCLOUD_TOKEN=... TAILSCALE_AUTHKEY=tskey-auth-... bun run infra/provision.ts
```

`infra/cloud-init.yaml` installs the packages, creates the `pai` user, joins the tailnet
with SSH enabled, and installs Bun and Node 22. Give it a few minutes after the server
reports `running`.

```sh
bun run infra/bootstrap.ts --host pai --from <old-host>
```

That adds a read-only deploy key to the repository, clones it, carries `.env`, `pai.db`
and `workspace/memory` across, installs dependencies and starts the service. With
`--from` the state comes straight off the machine being replaced.

## Backups

```sh
ssh pai 'mkdir -p ~/.config/pai && cat > ~/.config/pai/backup.env' <<'ENV'
BORG_REPO=ssh://uXXXXXX@uXXXXXX.your-storagebox.de:23/./pai
BORG_PASSPHRASE=...
ENV
ssh pai 'borg init --encryption=repokey-blake2'
ssh pai 'cp ~/pai/infra/pai-backup.* ~/.config/systemd/user/ && systemctl --user enable --now pai-backup.timer'
```

Restoring is `borg extract` into `~/pai`; the checkout itself comes from git.

## Taking it down

```sh
HCLOUD_TOKEN=... bun run infra/provision.ts --delete
```

## Notes

- The daemon binds `127.0.0.1`. Reach the API and the web app through the tailnet with
  `ssh -L 8787:127.0.0.1:8787 pai`, or bind it to the Tailscale interface when the web
  app is ready to be used from a phone.
- Whisper builds from source on first use; on this shape that is a few minutes once.
- If Tailscale ever fails to come up, the Hetzner console is the way back in.
