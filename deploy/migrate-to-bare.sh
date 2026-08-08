#!/usr/bin/env bash
# Move a Docker install onto the host, keeping its token and its history.
#
#   sudo ./deploy/migrate-to-bare.sh              do it
#   sudo ./deploy/migrate-to-bare.sh --dry-run    say what it would do
#   PREFIX=$PWD sudo ./deploy/migrate-to-bare.sh  run from the checkout itself
#
# Why bother: on the host systemd holds the listening socket, so a restart is
# queued rather than refused. Under Docker the socket belongs to the container
# and an update destroys it, which is what the front container exists to paper
# over. Bare metal does not need the front at all.
#
# Nothing is deleted. The compose project is stopped, not removed, and its
# volume is left alone, so going back is `docker compose up -d` after stopping
# the service.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-/opt/osu-api-scheduler}"
STATE="${STATE:-/var/lib/osu-api-scheduler}"
CONF="${CONF:-/etc/osu-api-scheduler}"
UNIT="${UNIT:-osu-api-scheduler}"
DRY=0
[[ ${1:-} == --dry-run ]] && DRY=1

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then printf '    would: %s\n' "$*"; else "$@"; fi; }

cd "$SRC"

(( DRY )) || [[ $EUID -eq 0 ]] || die "run with sudo"
[[ -f docker-compose.yml ]] || die "no docker-compose.yml here; run this from the checkout you deployed from"
command -v docker >/dev/null || die "docker is not on PATH, so there is nothing to migrate from"

command -v node >/dev/null || die "node is not installed on the host (need 22 or newer)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || die "node $NODE_MAJOR is too old, need 22 or newer"

RUNNING="$(docker compose ps -q 2>/dev/null || true)"
[[ -n ${RUNNING//[[:space:]]/} ]] || warn "no compose containers are running; carrying over whatever is on disk"

# ---- 1. the token -----------------------------------------------------------
#
# Before anything else, because every consumer on the host presents it. Losing
# it here means reconfiguring all of them, so an existing one is never replaced.
say "carrying the scheduler token over"
run mkdir -p "$CONF"
if [[ -s "$CONF/token" ]]; then
  say "  $CONF/token already exists, keeping it"
elif [[ -f .env ]] && grep -q '^SCHEDULER_TOKEN=' .env; then
  if (( DRY )); then
    printf '    would: write the token from .env to %s\n' "$CONF/token"
  else
    grep -oP '^SCHEDULER_TOKEN=\K.*' .env | head -1 > "$CONF/token"
    chmod 640 "$CONF/token"
  fi
else
  die "no token in .env and none at $CONF/token; nothing would be able to talk to it"
fi

# ---- 2. the history ---------------------------------------------------------
#
# Taken while the container still exists, because the volume is reachable
# through it. Metrics, the buckets and the dashboard's session secret all live
# here; without this the month view starts empty and everyone is signed out.
say "copying state out of the container"
run mkdir -p "$STATE"
if [[ -n ${RUNNING//[[:space:]]/} ]]; then
  if (( DRY )); then
    printf '    would: docker compose cp scheduler:/data/. %s/\n' "$STATE"
  else
    docker compose cp scheduler:/data/. "$STATE"/ \
      || warn "could not copy from the container; the history may not carry over"
  fi
else
  warn "  nothing running to copy from; skipping"
fi

# ---- 3. the settings --------------------------------------------------------
#
# .env is the container's environment; scheduler.env is the service's. Most of
# it transfers unchanged. The exceptions are the ones that only meant something
# inside a container: the token now lives in a file, the address goes back to
# loopback because there is no front to reach it from, and FRONT_* is the front
# that no longer exists.
say "translating .env into $CONF/scheduler.env"
if [[ -s "$CONF/scheduler.env" ]]; then
  say "  already exists, keeping it"
elif (( DRY )); then
  printf '    would: write %s from .env\n' "$CONF/scheduler.env"
else
  {
    echo "# Migrated from docker-compose on $(date -u '+%Y-%m-%d %H:%M:%SZ')."
    echo "SCHEDULER_STATE_DIR=$STATE"
    echo "SCHEDULER_TOKEN_FILE=$CONF/token"
    echo "SCHEDULER_WEB_ROOT=$PREFIX/web/dist"
    echo "# Loopback again: under Docker this had to be 0.0.0.0 so the front"
    echo "# could reach it. systemd hands us the socket instead."
    echo "SCHEDULER_HOST=127.0.0.1"
    echo "SCHEDULER_PORT=7654"
    [[ -f .env ]] && grep -vE '^\s*#|^\s*$|^(SCHEDULER_TOKEN|SCHEDULER_HOST|SCHEDULER_PORT|SCHEDULER_STATE_DIR|SCHEDULER_TOKEN_FILE|SCHEDULER_WEB_ROOT|FRONT_)' .env
  } > "$CONF/scheduler.env"
  chmod 640 "$CONF/scheduler.env"
fi

# ---- 4. free the port -------------------------------------------------------
say "stopping the compose project (not removing it)"
run docker compose down

# ---- 5. install -------------------------------------------------------------
say "installing the service"
if (( DRY )); then
  printf '    would: PREFIX=%s STATE=%s CONF=%s ./deploy/install.sh\n' "$PREFIX" "$STATE" "$CONF"
else
  PREFIX="$PREFIX" STATE="$STATE" CONF="$CONF" ./deploy/install.sh
fi

(( DRY )) && { say "dry run, nothing changed"; exit 0; }

# ---- 6. did it work ---------------------------------------------------------
PORT="$(grep -oP '^SCHEDULER_PORT=\K\d+' "$CONF/scheduler.env" 2>/dev/null || echo 7654)"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    say "healthy on 127.0.0.1:$PORT, served by systemd's socket"
    echo
    echo "  Your reverse proxy needs no change; it is the same address."
    echo "  Updates from here: sudo npm run update, run from this checkout."
    echo "  The docker volume is untouched. Once the dashboard shows your"
    echo "  history, remove it with: docker volume rm \$(docker volume ls -q | grep scheduler-data)"
    exit 0
  fi
  sleep 1
done

warn "it did not come up. The compose project is only stopped, so to go back:"
warn "  systemctl disable --now $UNIT $UNIT.socket && docker compose up -d"
die "migration finished but the service is not answering; check: journalctl -u $UNIT -n 50"
