#!/usr/bin/env bash
#
# ETH Roundtrip: wipe the ledger and start over.
# Destructive, so it asks twice and keeps a backup unless told not to.
#
set -euo pipefail

# Private, as backupDatabase.sh makes its copies: under the usual umask of 022
# the backup came out -rw-r--r-- in a data/backups made 755, so any account on
# the host could read the whole ledger from it. The empty ledger made at the
# end gets the same.
umask 077

cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""; fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

# The old MYAAVE_DB still read, after ETHROUNDTRIP_DB, as the app reads it.
DB="${ETHROUNDTRIP_DB:-${MYAAVE_DB:-data/myaave.db}}"
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
  ETHROUNDTRIP_DB  Database file to reset (MYAAVE_DB, the old name, works
                   too). Defaults to data/myaave.db
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

printf '\n%sETH Roundtrip%s %sdatabase reset%s\n\n' "$BOLD" "$OFF" "$DIM" "$OFF"

if [ ! -f "$DB" ]; then
  ok "No database at $DB. There is nothing to reset."
  exit 0
fi

# ------------------------------------------------------------- what is at stake

COUNT="unknown"
if [ -d node_modules/better-sqlite3 ]; then
  COUNT="$(ETHROUNDTRIP_DB_PATH="$DB" node -e '
    try {
      const Database = require("better-sqlite3");
      const db = new Database(process.env.ETHROUNDTRIP_DB_PATH, { readonly: true });
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
#
# Without a tool to ask, the check used to be skipped in silence: on a system
# with no lsof the ledger was deleted under a running server, which went on
# writing to the deleted file and lost it all at its next restart. So fuser is
# asked instead, and with neither there is no reset.
HOLDER=""
if command -v lsof >/dev/null 2>&1; then
  HOLDER="$(lsof -t "$DB" 2>/dev/null | head -n 1 || true)"
elif command -v fuser >/dev/null 2>&1; then
  HOLDER="$(fuser "$DB" 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)"
else
  die "Neither lsof nor fuser is installed, so nothing can check that no server has the ledger open. Install lsof, or stop the server and run this again once it is installed."
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
  ETHROUNDTRIP_DB="$DB" node -e 'import("./db.js").then(({ closeDb }) => closeDb());' >/dev/null 2>&1 \
    && ok "Empty ledger created at $DB" \
    || warn "Could not pre-create the schema. The next start will do it."
else
  warn "Dependencies are not installed, so the schema will be created on the next start."
fi

printf '\n  %sDone.%s Start again with ./runETHRoundTrip.sh\n\n' "$BOLD" "$OFF"
