#!/usr/bin/env bash
# Bare-metal installer for the osu! API scheduler.
# Run from a checkout:  sudo ./deploy/install.sh
set -euo pipefail

PREFIX="${PREFIX:-/opt/osu-api-scheduler}"
STATE="${STATE:-/var/lib/osu-api-scheduler}"
CONF="${CONF:-/etc/osu-api-scheduler}"
USER_NAME="${USER_NAME:-osu-api-scheduler}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
command -v node >/dev/null || die "node is not installed (need 22 or newer)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 22 )) || die "node $NODE_MAJOR is too old, need 22 or newer"
command -v npm >/dev/null || die "npm is not installed"

echo "==> installing to $PREFIX"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$STATE" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$PREFIX" "$STATE" "$CONF"

# Copy the tree without build output or local state.
tar -C "$SRC" \
    --exclude=node_modules --exclude=.git --exclude=web/dist \
    --exclude=data --exclude=state --exclude=.env \
    -cf - . | tar -C "$PREFIX" -xf -

echo "==> installing dependencies and building the dashboard"
cd "$PREFIX"
npm ci --silent
npm run build --silent
# Dev dependencies are only needed for the build. tsx is a runtime dependency,
# so pruning leaves it in place.
npm prune --omit=dev --silent >/dev/null 2>&1 || true

if [[ ! -f "$CONF/token" ]]; then
  echo "==> generating a scheduler token"
  openssl rand -base64 32 | tr -d '=+/' > "$CONF/token"
  chmod 640 "$CONF/token"
fi

if [[ ! -f "$CONF/scheduler.env" ]]; then
  cat > "$CONF/scheduler.env" <<ENV
# osu! API scheduler. See .env.example in the source tree for everything else.
SCHEDULER_STATE_DIR=$STATE
SCHEDULER_TOKEN_FILE=$CONF/token
SCHEDULER_WEB_ROOT=$PREFIX/web/dist
SCHEDULER_HOST=127.0.0.1
SCHEDULER_PORT=7654

# Dashboard: password, oauth, or none if a reverse proxy already asks.
DASHBOARD_AUTH=none
ENV
  chmod 640 "$CONF/scheduler.env"
fi

chown -R "$USER_NAME:$USER_NAME" "$PREFIX" "$STATE"
chown root:"$USER_NAME" "$CONF"/*
chmod 750 "$CONF"

echo "==> installing the service"
sed -e "s|/opt/osu-api-scheduler|$PREFIX|g" \
    -e "s|/var/lib/osu-api-scheduler|$STATE|g" \
    -e "s|/etc/osu-api-scheduler|$CONF|g" \
    -e "s|User=osu-api-scheduler|User=$USER_NAME|" \
    -e "s|Group=osu-api-scheduler|Group=$USER_NAME|" \
    "$PREFIX/deploy/osu-api-scheduler.service" > /etc/systemd/system/osu-api-scheduler.service

# The socket is what keeps restarts from being felt: systemd holds the port open
# while the service is down, so callers queue instead of getting refused.
PORT="$(grep -oP 'SCHEDULER_PORT=\K\d+' "$CONF/scheduler.env" 2>/dev/null || echo 7654)"
HOST="$(grep -oP 'SCHEDULER_HOST=\K\S+' "$CONF/scheduler.env" 2>/dev/null || echo 127.0.0.1)"
sed -e "s|ListenStream=.*|ListenStream=$HOST:$PORT|" \
    "$PREFIX/deploy/osu-api-scheduler.socket" > /etc/systemd/system/osu-api-scheduler.socket

systemctl daemon-reload
systemctl enable --now osu-api-scheduler.socket
systemctl enable --now osu-api-scheduler

sleep 2
if systemctl is-active --quiet osu-api-scheduler; then
  echo
  echo "Running on http://127.0.0.1:$(grep -oP 'SCHEDULER_PORT=\K\d+' "$CONF/scheduler.env" || echo 7654)"
  echo "Token:  $(cat "$CONF/token")"
  echo
  echo "Your projects send this as the X-Scheduler-Token header."
  echo "Dashboard auth is off by default. Set DASHBOARD_AUTH in $CONF/scheduler.env"
  echo "before exposing it, or keep it behind your reverse proxy."
else
  echo "the service did not start. journalctl -u osu-api-scheduler -n 50" >&2
  exit 1
fi
