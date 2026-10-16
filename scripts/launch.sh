#!/usr/bin/env bash
# Launch the dsh-shell-linux shell.
#
# The shell needs no arguments; this wrapper exists so the desktop entry has one
# stable command to call, and so the two environment quirks of this machine are
# handled in one place rather than in the .desktop file:
#
#   1. chrome-sandbox has no SUID bit here, so Electron needs --no-sandbox.
#      `npm start` already passes it; this script invokes Electron directly to
#      avoid a build on every launch.
#   2. A proxy variable pointing at a port that is not listening makes the host's
#      account API fail (platform.deepseek.com becomes unreachable through it).
#      We only drop the proxy variables when their port is actually dead, so a
#      working proxy is still used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -x node_modules/electron/dist/electron ]]; then
  echo "dsh-shell-linux: dependencies are missing; run 'npm install' in $ROOT" >&2
  exit 1
fi

if [[ ! -f dist/node/main/main.js || ! -f dist/preload/app.cjs ]]; then
  echo "dsh-shell-linux: build output is missing; running 'npm run build' first" >&2
  npm run build
fi

# Drop a proxy setting only when the port it names is not listening.
proxy_is_dead() {
  local url="$1" hostport
  hostport="${url#*://}"          # strip scheme
  hostport="${hostport%%/*}"      # strip path
  hostport="${hostport##*@}"      # strip credentials
  case "$hostport" in
    127.0.0.1:*|localhost:*) ;;
    *) return 1 ;;                # remote proxy: assume the user knows
  esac
  local port="${hostport##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  ! ss -ltn 2>/dev/null | grep -q "127.0.0.1:$port "
}

for var in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY; do
  value="${!var:-}"
  [[ -n "$value" ]] || continue
  if proxy_is_dead "$value"; then
    echo "dsh-shell-linux: $var=$value is not listening; ignoring it for this launch" >&2
    unset "$var"
  fi
done
# Keep the two in sync: undici honours this flag for the inherited variables.
if [[ -z "${https_proxy:-}${HTTPS_PROXY:-}" ]]; then unset NODE_USE_ENV_PROXY || true; fi

exec node_modules/electron/dist/electron . --no-sandbox "$@"
