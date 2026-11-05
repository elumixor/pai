#!/bin/sh
# Runs when the daemon's service has given up restarting. Outside the checkout and plain shell, so a broken release
# cannot break its own rescue. PAI_REPO and PAI_SERVICE come from the unit.
set -u
repo=${PAI_REPO:?}
service=${PAI_SERVICE:-pai}
data="$repo/data"
ctl() { systemctl --user "$@"; }
say() { echo "$(date -u +%FT%TZ) rollback: $*" >>"$data/daemon.log"; }

# OnFailure can also fire on a single failed start on some systemd versions: only a spent restart limit counts.
[ "$(ctl show "$service" -p Result --value)" = "start-limit-hit" ] || exit 0

head=$(git -C "$repo" rev-parse HEAD)
tag=$(git -C "$repo" describe --tags --exact-match HEAD 2>/dev/null || echo "$head")
good=$(sed -n 1p "$data/last-good" 2>/dev/null || true)
good_modules=$(sed -n 2p "$data/last-good" 2>/dev/null || true)

restart() {
  ctl reset-failed "$service"
  ctl start "$service"
}

# Nothing older is known to work, or this version already ran fine: the code is not what changed.
if [ -z "$good" ] || [ "$good" = "$head" ]; then
  say "$service crash-looping on $tag, nothing to roll back to"
  echo "$tag" >"$data/crash-loop"
  sleep 60
  restart
  exit 0
fi

say "$tag crash-looped, going back to $good"
echo "$tag" >>"$data/bad-versions"
git -C "$repo" checkout --quiet -- bun.lock apps/web/bun.lock
git -C "$repo" checkout --quiet "$good" || {
  say "checkout of $good failed"
  echo "$tag" >"$data/crash-loop"
  exit 1
}
if [ -n "$good_modules" ] && [ -d "$repo/modules/.git" ]; then
  # reset, not checkout: a detached HEAD would make every later pull --ff-only fail.
  git -C "$repo/modules" reset --quiet --hard "$good_modules"
  (cd "$repo/modules" && bun install --silent)
fi
(cd "$repo" && bun install --silent)
restart
echo "$tag" >"$data/rolled-back"
# Last: the API and the bots are back without it, and the old assets still load.
(cd "$repo" && bun run build:web >/dev/null 2>&1) || say "web client did not build on $good"
say "back on $good"
