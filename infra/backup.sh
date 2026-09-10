#!/usr/bin/env bash
# Nightly borg archive of the things that cannot be recreated from git: the database,
# long-term memory, and the environment file. Credentials come from
# ~/.config/pai/backup.env (BORG_REPO, BORG_PASSPHRASE), which is not in the repository.
set -euo pipefail

source "$HOME/.config/pai/backup.env"
export BORG_REPO BORG_PASSPHRASE

borg create --compression zstd --stats \
  "::pai-{now:%Y-%m-%dT%H:%M}" \
  "$HOME/pai/data" \
  "$HOME/pai/workspace/memory" \
  "$HOME/pai/.env"

borg prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6
borg compact
