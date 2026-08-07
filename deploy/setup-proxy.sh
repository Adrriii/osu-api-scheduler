#!/usr/bin/env bash
# Puts the osu! API scheduler behind Apache or nginx, with TLS if certbot is
# available. Works the same whether the scheduler runs in Docker or on the host,
# because both listen on 127.0.0.1:7654.
#
#   sudo ./deploy/setup-proxy.sh osu-api.example.com
#   sudo ./deploy/setup-proxy.sh osu-api.example.com --nginx --no-tls
set -euo pipefail

DOMAIN="${1:-}"
SERVER=""
TLS=1
PORT="${SCHEDULER_PORT:-7654}"
EMAIL="${CERTBOT_EMAIL:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<USAGE
usage: sudo $0 <domain> [--apache|--nginx] [--no-tls] [--email you@example.com]

  <domain>       hostname that already points at this machine
  --apache       force Apache (default: whichever is installed)
  --nginx        force nginx
  --no-tls       skip certbot
  --email        contact address for Let's Encrypt
USAGE
  exit 1
}

[[ -n "$DOMAIN" ]] || usage
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apache) SERVER=apache ;;
    --nginx)  SERVER=nginx ;;
    --no-tls) TLS=0 ;;
    --email)  EMAIL="${2:-}"; shift ;;
    *) usage ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"

# Pick a web server if not told which.
if [[ -z "$SERVER" ]]; then
  have_apache=0
  have_nginx=0
  if command -v apache2ctl >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then have_apache=1; fi
  if command -v nginx >/dev/null 2>&1; then have_nginx=1; fi

  if   (( have_apache && have_nginx )); then die "both Apache and nginx are installed; pass --apache or --nginx"
  elif (( have_apache )); then SERVER=apache
  elif (( have_nginx  )); then SERVER=nginx
  else die "neither Apache nor nginx found"
  fi
fi

# Warn early rather than after writing config: a certificate cannot be issued
# for a name that does not resolve here.
if command -v getent >/dev/null 2>&1; then
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  [[ -n "$resolved" ]] || echo "warning: $DOMAIN does not resolve yet; TLS will fail until it does" >&2
fi

echo "==> configuring $SERVER for $DOMAIN -> 127.0.0.1:$PORT"

if [[ "$SERVER" == apache ]]; then
  for m in proxy proxy_http headers rewrite; do
    a2enmod -q "$m" 2>/dev/null || true
  done

  if [[ -d /etc/apache2/sites-available ]]; then
    CONF=/etc/apache2/sites-available/osu-api-scheduler.conf
  else
    CONF=/etc/httpd/conf.d/osu-api-scheduler.conf   # RHEL layout, no a2ensite
  fi

  sed -e "s/osu-api\.example\.com/$DOMAIN/g" -e "s/7654/$PORT/g" \
      "$HERE/apache.conf.example" > "$CONF"
  if [[ -d /etc/apache2/sites-available ]]; then a2ensite -q osu-api-scheduler.conf; fi

  if command -v apache2ctl >/dev/null 2>&1; then
    apache2ctl configtest || die "Apache rejected the config; left it at $CONF"
    systemctl reload apache2
  else
    httpd -t || die "Apache rejected the config; left it at $CONF"
    systemctl reload httpd
  fi
else
  if [[ -d /etc/nginx/sites-available ]]; then
    CONF=/etc/nginx/sites-available/osu-api-scheduler.conf
    LINK=/etc/nginx/sites-enabled/osu-api-scheduler.conf
  else
    CONF=/etc/nginx/conf.d/osu-api-scheduler.conf
    LINK=""
  fi

  sed -e "s/osu-api\.example\.com/$DOMAIN/g" -e "s/7654/$PORT/g" \
      "$HERE/nginx.conf.example" > "$CONF"
  if [[ -n "$LINK" ]]; then ln -sf "$CONF" "$LINK"; fi

  nginx -t || die "nginx rejected the config; left it at $CONF"
  systemctl reload nginx
fi

echo "==> $SERVER is serving http://$DOMAIN"

if (( TLS )); then
  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot is not installed; skipping TLS. Install it and run:" >&2
    echo "  certbot --$SERVER -d $DOMAIN" >&2
  else
    echo "==> requesting a certificate"
    args=(--"$SERVER" -n --agree-tos -d "$DOMAIN")
    if [[ -n "$EMAIL" ]]; then args+=(-m "$EMAIL"); else args+=(--register-unsafely-without-email); fi
    if certbot "${args[@]}"; then
      echo "==> https://$DOMAIN is live"
    else
      echo "certbot failed. The plain HTTP site is still configured." >&2
      exit 1
    fi
  fi
fi

cat <<DONE

Done. The dashboard is at http$( ((TLS)) && echo s )://$DOMAIN

Before exposing it, set DASHBOARD_AUTH (password, oauth, or none if this proxy
already asks for credentials). For oauth, DASHBOARD_ORIGIN must match the URL
above and the osu! application's callback must be <origin>/auth/callback.
DONE
