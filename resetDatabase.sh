#!/usr/bin/env bash
#
# Aave Loop Ledger: wipe the ledger and start over.
# Destructive, so it asks twice and keeps a backup unless told not to.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""; fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

DB="${MYAAVE_DB:-data/myaave.db}"
BACKUP=1
ASSUME_YES=0

usage() {
  cat <<'USAGE'
Usage: ./resetDatabase.sh [options]

Deletes every trade and leaves an empty ledger. You are asked to confirm twice.

  --no-backup   Do not copy the current database into data/backups first.
  --yes         Skip both prompts. For scripts only; there is no undo.
  --help        Show this message.

Environment:
  MYAAVE_DB     Database file to reset. Defaults to data/myaave.db
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-backup) BACKUP=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1. Try --help." ;;
  esac
done

printf '\n%sAave Loop Ledger%s %sdatabase reset%s\n\n' "$BOLD" "$OFF" "$DIM" "$OFF"

if [ ! -f "$DB" ]; then
  ok "No database at $DB. There is nothing to reset."
  exit 0
fi

# ------------------------------------------------------------- what is at stake

COUNT="unknown"
if [ -d node_modules/better-sqlite3 ]; then
  COUNT="$(MYAAVE_DB_PATH="$DB" node -e '
    try {
      const Database = require("better-sqlite3");
      const db = new Database(process.env.MYAAVE_DB_PATH, { readonly: true });
      const row = db.prepare("SELECT COUNT(*) AS n FROM trades").get();
      db.close();
      process.stdout.write(String(row.n));
    } catch (e) { process.stdout.write("unknown"); }
  ' 2>/dev/null || echo unknown)"
fi

SIZE="$(du -h "$DB" | cut -f1 | tr -d ' ')"
printf '  Database : %s (%s)\n' "$DB" "$SIZE"
printf '  Trades   : %s%s%s\n\n' "$BOLD" "$COUNT" "$OFF"

# A server holding the file open would keep writing to a database that no
# longer exists, so it has to stop before the file goes.
HOLDER=""
if command -v lsof >/dev/null 2>&1; then
  HOLDER="$(lsof -t "$DB" 2>/dev/null | head -n 1 || true)"
fi
if [ -n "$HOLDER" ]; then
  warn "The ledger is open in a running server (pid $HOLDER)."
  warn "Stop it first, then run this again."
  exit 1
fi

# ------------------------------------------------------------- confirm, twice

if [ "$ASSUME_YES" -eq 0 ]; then
  [ -t 0 ] || die "Nothing to read confirmation from. Use --yes if you really mean it."

  printf '  %sThis deletes every trade. There is no undo.%s\n' "$YELLOW" "$OFF"
  printf '  Continue? [y/N] '
  read -r first
  case "$first" in
    y|Y|yes|YES) ;;
    *) printf '\n'; ok "Cancelled. Nothing was changed."; exit 0 ;;
  esac

  printf '\n  Second check. Type %sRESET%s to confirm: ' "$BOLD" "$OFF"
  read -r second
  if [ "$second" != "RESET" ]; then
    printf '\n'
    ok "Cancelled. Nothing was changed."
    exit 0
  fi
  printf '\n'
fi

# -------------------------------------------------------------------- do it

if [ "$BACKUP" -eq 1 ]; then
  mkdir -p data/backups
  STAMP="$(date +%Y%m%d-%H%M%S)"
  DEST="data/backups/$(basename "${DB%.db}")-$STAMP.db"
  cp "$DB" "$DEST"
  # Fold in anything still sitting in the write ahead log.
  [ -f "$DB-wal" ] && cp "$DB-wal" "$DEST-wal"
  [ -f "$DB-shm" ] && cp "$DB-shm" "$DEST-shm"
  ok "Backed up to $DEST"
fi

rm -f "$DB" "$DB-wal" "$DB-shm"
ok "Ledger deleted"

# Recreate the schema so the next start finds a ready, empty database.
if [ -d node_modules/better-sqlite3 ]; then
  MYAAVE_DB="$DB" node -e 'import("./db.js").then(({ closeDb }) => closeDb());' >/dev/null 2>&1 \
    && ok "Empty ledger created at $DB" \
    || warn "Could not pre-create the schema. The next start will do it."
else
  warn "Dependencies are not installed, so the schema will be created on the next start."
fi

printf '\n  %sDone.%s Start again with ./run_myAave.sh\n\n' "$BOLD" "$OFF"
