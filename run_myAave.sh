#!/usr/bin/env bash
#
# myAave local launcher.
# Checks Node, installs dependencies when needed, finds a free port, starts up.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""; fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

PORT="${PORT:-3000}"
KILL_HOLDER=0
PORT_SCAN_LIMIT=10

usage() {
  cat <<'USAGE'
Usage: ./run_myAave.sh [options]

  --port N     Start on port N instead of 3000.
  --kill       If the port is taken, stop whatever holds it and reuse the port.
               Without this flag the script moves to the next free port.
  --help       Show this message.

Environment:
  PORT         Same as --port.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die "--port needs a number."; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --kill) KILL_HOLDER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1. Try --help." ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) die "Port must be a number, got '$PORT'." ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Port must be between 1 and 65535."

printf '\n%smyAave%s %slauncher%s\n\n' "$BOLD" "$OFF" "$DIM" "$OFF"

# --------------------------------------------------------------------- node

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get it from https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18 or newer is required, found $(node -v)."
ok "Node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is not installed alongside Node."

# ------------------------------------------------------------- dependencies

needs_install=0
reason=""

if [ ! -d node_modules ]; then
  needs_install=1; reason="node_modules is missing"
elif [ -f package-lock.json ] && [ package-lock.json -nt node_modules ]; then
  needs_install=1; reason="package-lock.json changed"
elif ! node -e 'import("better-sqlite3").then(()=>{},()=>process.exit(1))' 2>/dev/null; then
  needs_install=1; reason="the better-sqlite3 native binding did not load"
fi

if [ "$needs_install" -eq 1 ]; then
  warn "Installing dependencies ($reason)"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund || die "npm ci failed."
  else
    npm install --no-audit --no-fund || die "npm install failed."
  fi
  ok "Dependencies installed"
else
  ok "Dependencies present"
fi

# ------------------------------------------------------------------ data dir

mkdir -p data
ok "Database directory ready (./data)"

# ---------------------------------------------------------------------- port

port_holder_pid() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

port_is_free() {
  [ -z "$(port_holder_pid "$1")" ]
}

stop_pid() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
}

if ! port_is_free "$PORT"; then
  HOLDER_PID="$(port_holder_pid "$PORT")"
  HOLDER_CMD="$(ps -o command= -p "$HOLDER_PID" 2>/dev/null | head -n 1)"
  warn "Port $PORT is busy (pid $HOLDER_PID: ${HOLDER_CMD:-unknown})"

  # A previous myAave instance is always safe to reclaim. `ps` prints the
  # command as it was typed, so match on the process working directory too.
  holder_is_myaave() {
    printf '%s' "$HOLDER_CMD" | grep -q 'server\.js' || return 1
    local cwd
    cwd="$(lsof -a -p "$HOLDER_PID" -d cwd -Fn 2>/dev/null | grep '^n' | tail -n 1)"
    [ "${cwd#n}" = "$(pwd)" ]
  }

  if holder_is_myaave; then
    warn "That is an older myAave instance, stopping it"
    stop_pid "$HOLDER_PID"
    port_is_free "$PORT" || die "Could not free port $PORT."
    ok "Port $PORT reclaimed"
  elif [ "$KILL_HOLDER" -eq 1 ]; then
    warn "Stopping pid $HOLDER_PID as requested by --kill"
    stop_pid "$HOLDER_PID"
    port_is_free "$PORT" || die "Could not free port $PORT."
    ok "Port $PORT reclaimed"
  else
    START="$PORT"
    FOUND=""
    for offset in $(seq 1 "$PORT_SCAN_LIMIT"); do
      CANDIDATE=$((START + offset))
      [ "$CANDIDATE" -le 65535 ] || break
      if port_is_free "$CANDIDATE"; then FOUND="$CANDIDATE"; break; fi
    done
    [ -n "$FOUND" ] || die "No free port between $((START + 1)) and $((START + PORT_SCAN_LIMIT)). Use --kill or --port N."
    PORT="$FOUND"
    warn "Using port $PORT instead. Pass --kill to take $START back."
  fi
fi
ok "Port $PORT is free"

# --------------------------------------------------------------------- start

printf '\n  %sStarting on http://localhost:%s%s\n  %sPress Ctrl+C to stop.%s\n\n' \
  "$BOLD" "$PORT" "$OFF" "$DIM" "$OFF"

export PORT
exec node server.js
