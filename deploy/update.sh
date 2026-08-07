#!/usr/bin/env bash
# Update a running osu! API scheduler: pull, rebuild what changed, restart.
#
#   npm run update            update to the latest commit on the current branch
#   npm run update -- --force rebuild and restart even if nothing changed
#   npm run update -- --check report what an update would do, change nothing
#   npm run update -- --docker force the deployment kind if detection is wrong
#   npm run update -- --bare
#
# Docker and bare metal are detected, not configured.
#
# Note on downtime. Two instances must never run at once: each holds its own
# token bucket and would spend the same per-IP budget twice, which is the
# lockout this service exists to prevent. So there is no overlapping swap. What
# there is instead: the build happens while the old process is still serving, so
# only the restart itself is a gap, and SIGTERM drains the queue rather than
# failing it, so requests already accepted are answered on the way out.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${CONF:-/etc/osu-api-scheduler}"
UNIT="${UNIT:-osu-api-scheduler}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

FORCE=0
CHECK=0
MODE_OVERRIDE=""


# `npm run update --force` hands the flag to npm rather than to this script, and
# npm exports it as npm_config_force instead. Without this the flag is silently
# swallowed and the run looks like it decided there was nothing to do, which is
# indistinguishable from the flag working. Accept both spellings.
[[ ${npm_config_force:-} == true ]] && FORCE=1
[[ ${npm_config_check:-} == true ]] && CHECK=1

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    # For when detection is wrong, so a deploy is never blocked by it.
    --docker) MODE_OVERRIDE=docker ;;
    --bare) MODE_OVERRIDE=bare ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# `set -e` otherwise ends the run with no output at all, which is indisting-
# uishable from having finished successfully. Say where it stopped.
trap 'rc=$?; (( rc )) && printf "error: update stopped at line %d (exit %d)\n" "$LINENO" "$rc" >&2' ERR

cd "$SRC"

# ---- where is it running? --------------------------------------------------

DOCKER_WHY=""

docker_running() {
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_WHY="docker is not on PATH"
    return 1
  fi
  if [[ ! -f docker-compose.yml ]]; then
    DOCKER_WHY="no docker-compose.yml in $SRC"
    return 1
  fi
  # -q rather than --quiet, and stderr kept: an unreadable compose file or a
  # daemon we cannot talk to is worth saying out loud rather than reporting as
  # "nothing is running".
  local out
  if ! out="$(docker compose ps -q 2>&1)"; then
    DOCKER_WHY="docker compose ps failed: ${out//$'\n'/ }"
    return 1
  fi
  if [[ -z ${out//[[:space:]]/} ]]; then
    DOCKER_WHY="docker compose ps listed no containers for this project"
    return 1
  fi
  return 0
}

MODE="${MODE_OVERRIDE:-}"
if [[ -z $MODE ]]; then
  if docker_running; then
    MODE=docker
  elif systemctl list-unit-files "$UNIT.service" >/dev/null 2>&1 \
       && systemctl cat "$UNIT" >/dev/null 2>&1; then
    MODE=bare
  else
    die "could not tell how this is deployed, so nothing was changed.
       docker: $DOCKER_WHY
       systemd: no $UNIT service found
       Run from the checkout you deployed from, or force it with --docker / --bare."
  fi
fi

# Where the service actually runs from, asked rather than assumed: install.sh
# copies the tree to /opt, but running the unit straight out of a checkout is
# just as common, and then there is nothing to copy.
if [[ $MODE == bare ]]; then
  PREFIX="${PREFIX:-$(systemctl show -p WorkingDirectory --value "$UNIT" 2>/dev/null)}"
  PREFIX="${PREFIX:-/opt/osu-api-scheduler}"
  [[ -d $PREFIX ]] || die "the $UNIT service runs from $PREFIX, which does not exist"
fi
say "deployment: $MODE${PREFIX:+ ($PREFIX)}"

# The port to health-check. Whatever configured it wins; 7654 is the default.
#
# Returns 0 with no output when the file is absent, which is the normal case
# under Docker. Letting the missing-file test be the function's exit status made
# `set -e` kill the script inside the assignment below, with nothing printed.
port_from() {
  [[ -f $1 ]] || return 0
  sed -n 's/^[[:space:]]*SCHEDULER_PORT=\(.*\)$/\1/p' "$1" | tail -1
}
PORT="${SCHEDULER_PORT:-$(port_from "$CONF/scheduler.env")}"
[[ -n ${PORT:-} ]] || PORT="$(port_from "$SRC/.env")"
PORT="${PORT:-7654}"
HEALTH="http://127.0.0.1:${PORT}/healthz"

# ---- pull ------------------------------------------------------------------

git rev-parse --git-dir >/dev/null 2>&1 || die "$SRC is not a git checkout, nothing to pull"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "you have uncommitted changes here; commit or stash them so an update can be rolled back"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ $BRANCH != HEAD ]] || die "this checkout is on a detached HEAD, so there is no branch to pull.
       Check out a branch first: git checkout master"

BEFORE="$(git rev-parse HEAD)"
say "fetching $BRANCH from origin"
git fetch --quiet origin "$BRANCH" \
  || die "git fetch failed; the pull cannot proceed"
AFTER="$(git rev-parse "origin/$BRANCH" 2>/dev/null)" \
  || die "no origin/$BRANCH after fetching; is the branch pushed?"

if [[ "$BEFORE" == "$AFTER" && $FORCE -eq 0 ]]; then
  say "already up to date at ${BEFORE:0:8}; nothing to do (use --force to rebuild anyway)"
  exit 0
fi

# What changed decides what gets rebuilt. On --force with no new commits there
# is no diff to consult, so rebuild everything.
if [[ "$BEFORE" == "$AFTER" ]]; then
  CHANGED="$(git ls-files)"
else
  CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"
fi
changed() { grep -qE "$1" <<<"$CHANGED"; }

NEED_DEPS=0;  changed '^(package\.json|package-lock\.json|server/package\.json|web/package\.json)$' && NEED_DEPS=1
NEED_WEB=0;   changed '^web/' && NEED_WEB=1
NEED_IMAGE=0; changed '^(Dockerfile|\.dockerignore)$' && NEED_IMAGE=1

if [[ $CHECK -eq 1 ]]; then
  say "would update ${BEFORE:0:8} -> ${AFTER:0:8}"
  printf '    %s\n' "$(wc -l <<<"$CHANGED") file(s) changed" \
      "dependencies: $NEED_DEPS  dashboard: $NEED_WEB  image: $NEED_IMAGE"
  exit 0
fi

say "updating ${BEFORE:0:8} -> ${AFTER:0:8}"
git merge --ff-only --quiet "origin/$BRANCH" \
  || die "cannot fast-forward $BRANCH; the local branch has diverged from origin"

rollback() {
  warn "rolling back to ${BEFORE:0:8}"
  git reset --hard --quiet "$BEFORE"
  deploy || warn "rollback deploy failed; the service may need manual attention"
  restart || warn "rollback restart failed; check: journalctl -u $UNIT -n 50"
}

# ---- build, with the old process still serving -----------------------------

deploy() {
  case "$MODE" in
    docker)
      # Compose only rebuilds when the build context changed, and building here
      # rather than during `up` keeps the old container serving meanwhile.
      docker compose build
      ;;
    bare)
      if [[ "$PREFIX" != "$SRC" ]]; then
        [[ $EUID -eq 0 ]] || die "updating $PREFIX needs root (sudo npm run update)"
        say "syncing source to $PREFIX"
        tar -C "$SRC" \
            --exclude=node_modules --exclude=.git --exclude=web/dist \
            --exclude=data --exclude=state --exclude=.env \
            -cf - . | tar -C "$PREFIX" -xf -
      fi
      cd "$PREFIX"
      if (( NEED_DEPS )) || [[ ! -d node_modules ]]; then
        say "installing dependencies"
        npm ci --silent
      fi
      if (( NEED_WEB )) || [[ ! -d web/dist ]]; then
        say "building the dashboard"
        npm run build --silent
      fi
      # tsx is a runtime dependency, so pruning dev leaves it in place.
      npm prune --omit=dev --silent >/dev/null 2>&1 || true
      chown -R "$(stat -c %U "$PREFIX")" "$PREFIX" 2>/dev/null || true
      cd "$SRC"
      ;;
  esac
}

restart() {
  case "$MODE" in
    docker) docker compose up -d ;;
    bare)   systemctl restart "$UNIT" ;;
  esac
}

healthy() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

say "building"
deploy || { rollback; die "build failed"; }

# The gap starts here and ends when healthz answers. SIGTERM drains the queue
# first, so this waits for the old process to finish what it accepted.
say "restarting (draining in-flight requests first)"
restart || { rollback; die "restart failed"; }

say "waiting for $HEALTH"
if ! healthy; then
  rollback
  die "did not become healthy within ${HEALTH_TIMEOUT}s; rolled back. Check: $(
     [[ $MODE == docker ]] && echo 'docker compose logs --tail=50' || echo "journalctl -u $UNIT -n 50")"
fi

say "updated to $(git rev-parse --short HEAD) and healthy"
