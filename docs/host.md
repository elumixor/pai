# The host

pai runs on one Hetzner Cloud server. It publishes itself on https; Tailscale is there for ssh.

| | |
| --- | --- |
| Type | CX43 — 8 vCPU, 16 GB, 160 GB, €15.99/mo (Nuremberg) |
| Address | `5.75.134.57`, published as `https://5-75-134-57.sslip.io` (client, API, `/editor`); `pai` / `100.70.170.72` on the tailnet for ssh |
| Image | Ubuntu 24.04 |
| Inbound | 80 and 443, opened by the daemon; `tailscale ssh` for a shell |
| Service | `pai.service`, a systemd user unit with lingering enabled |
| Browser editor | code-server with the pai extension, started by the daemon, at `/editor` on the public address |
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

## What it costs

`pai cost` prices the account against Hetzner's own `/pricing`: the server, its primary
IPv4, volumes, floating IPs, backups. The `HCLOUD_TOKEN` it reads lives in `.env` on the
host — already set, so nothing needs asking for. Claude usage is billed by Anthropic and is
not in that number.

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

## Getting back in

The firewall lets in only 80 and 443, so Tailscale is the only way to a shell. Install it
on whatever you are holding and the host answers to `pai`. If Tailscale itself is what
broke, open port 22 to your own address for as long as the repair takes:

```sh
FW=$(curl -s -H "authorization: Bearer $HCLOUD_TOKEN" \
  "https://api.hetzner.cloud/v1/firewalls?name=pai-no-inbound" | jq -r .firewalls[0].id)
curl -s -XPOST -H "authorization: Bearer $HCLOUD_TOKEN" -H "content-type: application/json" \
  "https://api.hetzner.cloud/v1/firewalls/$FW/actions/set_rules" \
  -d "{\"rules\":[{\"direction\":\"in\",\"protocol\":\"tcp\",\"port\":\"22\",\"source_ips\":[\"$(curl -s https://api.ipify.org)/32\"]}]}"
```

Set the rules back to `[]` afterwards. The Hetzner console is the way in if even that fails.

## What a migration carries

`bootstrap.ts --state <dir>` moves `data/pai.db` and `workspace/memory`. Two things live
outside it and have to come across by hand, or old conversations are lost:

- `~/.claude/projects/<path-slug>/*.jsonl` — the transcripts. The directory name is derived
  from the working directory, so it has to be renamed for the new home (`-home-elumixor-pai-workspace`
  became `-home-pai-pai-workspace`).
- Sessions record the directory they ran in. A recorded path that does not exist on the new
  host falls back to the project or the workspace rather than failing to spawn.

## Notes

- Whisper builds from source on first use; on this shape that is a few minutes once.
- If Tailscale ever fails to come up, the Hetzner console is the way back in.
