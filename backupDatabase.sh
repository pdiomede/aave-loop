#!/usr/bin/env bash
#
# Aave Loop: back up the live database.
#
# Safe against a server that is running while this fires: it uses SQLite's own
# online backup API rather than copying the file, so a write landing mid-copy
# cannot produce a torn snapshot the way `cp` of a WAL-mode database can.
# Meant to run unattended, from cron - see the --help text for that line.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""; fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

DB="${MYAAVE_DB:-data/myaave.db}"
DEST="${MYAAVE_BACKUP_DIR:-$HOME/aaveloop-backups}"
KEEP=12

usage() {
  cat <<'USAGE'
Usage: ./backupDatabase.sh [options]

Copies the live database to a timestamped file in the destination folder,
using SQLite's online backup API - safe to run while the server is up. Older
backups past --keep are then removed, oldest first.

  --dest DIR    Where backups go. Defaults to $MYAAVE_BACKUP_DIR, then to
                ~/aaveloop-backups.
  --keep N      How many backups to keep. Defaults to 12. 0 keeps them all.
  --db FILE     Database to back up. Defaults to $MYAAVE_DB, then to
                data/myaave.db.
  --help        Show this message.

Backups are matched on the database's own name, so several databases can
share one destination folder without pruning each other.

A weekly cron line. Run it as the user the service runs as, which is the one
that can read the database: on a default install `data/` is mode 700 and owned
by that account, so nobody else can even look inside it.

  0 3 * * 0 cd /var/www/aave && ./backupDatabase.sh >> "$HOME/aaveloop-backup.log" 2>&1

Add it with `crontab -e` while logged in as that user, or `sudo crontab -u
<user> -e` from an account with sudo. The log goes to that user's home folder
because a path under /var/log has to be created and chowned first, and a cron
job that cannot write its log is a cron job whose failures are silent.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) [ $# -ge 2 ] || die "--dest needs a path."; DEST="$2"; shift 2 ;;
    --dest=*) DEST="${1#*=}"; shift ;;
    --keep) [ $# -ge 2 ] || die "--keep needs a number."; KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${1#*=}"; shift ;;
    --db) [ $# -ge 2 ] || die "--db needs a path."; DB="$2"; shift 2 ;;
    --db=*) DB="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1. Try --help." ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "--keep must be a number, got '$KEEP'." ;;
esac

# A file that is not there and a file that cannot be looked at are the same
# `[ -f ]` and are not the same problem. `data/` is mode 700 owned by the
# account the service runs as, so running this as anyone else fails the test
# above with the database sitting right there - and "No database" sends you
# looking for a missing file instead of for the right user. config.js draws
# the same distinction for config.env, for the same reason.
DBDIR="$(dirname "$DB")"
if [ ! -d "$DBDIR" ]; then
  die "No folder at $DBDIR, so there is no database to back up."
elif [ ! -r "$DBDIR" ] || [ ! -x "$DBDIR" ]; then
  die "Cannot look inside $DBDIR - it belongs to $(ls -ld "$DBDIR" | awk '{print $3}'). Run this as that user."
elif [ ! -f "$DB" ]; then
  die "No database at $DB. Nothing to back up."
elif [ ! -r "$DB" ]; then
  die "$DB is there but this account cannot read it - it belongs to $(ls -l "$DB" | awk '{print $3}'). Run this as that user."
fi

# Named in the failure, because the default is a home folder and a service
# account often has none: the account the ledger runs as may be unable to
# create its own, which is a destination to choose rather than a fault to fix.
mkdir -p "$DEST" 2>/dev/null || die "Could not create $DEST. Pass --dest with somewhere this account can write."

# Every file this script writes, reads back or removes is matched on this
# prefix and never on a bare `*.db`. Two things went wrong without it, and
# both destroyed data rather than merely miscounting: a destination pointed
# at the database's own folder pruned the live `myaave.db`, because an idle
# fortnight left it older than the backups around it; and two ledgers backed
# up to one folder pruned each other, since the newest N of everything is
# not the newest N of either.
PREFIX="$(basename "${DB%.db}")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="$DEST/$PREFIX-$STAMP"
OUT="$BASE.db"
# Two runs inside the same second - a manual run right after cron fires, say -
# would otherwise share a filename, and the second would silently overwrite
# the first's backup rather than sit beside it.
SUFFIX=2
while [ -e "$OUT" ]; do
  OUT="$BASE-$SUFFIX.db"
  SUFFIX=$((SUFFIX + 1))
done

# The online backup API, not a file copy. A plain `cp` of a WAL-mode database
# mid-write can capture the main file without the WAL's newer pages and hand
# back a database that looks fine and is quietly short a few commits - the
# exact risk this exists to avoid on an unattended schedule with nobody
# there to notice. Opened read-only, so this takes no lock the server's own
# writes would ever wait behind.
node -e '
  const Database = require("better-sqlite3");
  const src = new Database(process.argv[1], { readonly: true });
  src.backup(process.argv[2])
    .then(() => {
      src.close();
      // Left as a plain file rather than in whatever journal mode the source
      // was in. A WAL-mode file spins up a -wal and -shm beside itself the
      // next time anything opens it, even a read-only inspection, and those
      // are companions a backup sitting untouched for months should not grow.
      // DELETE folds any journal back into the one file for good, since
      // nothing ever writes to a backup again.
      //
      // Best effort, and deliberately outside the chain that decides whether
      // this run succeeded: the pages are already copied and correct here, so
      // failing over the journal mode would throw away a good backup for a
      // tidiness step - and the failure path below now deletes what it finds.
      try {
        const out = new Database(process.argv[2]);
        out.pragma("journal_mode = DELETE");
        out.close();
      } catch (err) {
        console.error("Backed up, but could not switch it out of WAL mode: " + err.message);
      }
    })
    .catch((err) => { console.error(err.message); process.exit(1); });
' "$DB" "$OUT" || {
  # A rejected backup can still have created the destination and written part
  # of it - a disk filling up mid-copy is the ordinary way that happens. By
  # name and by the glob below that file is indistinguishable from a good
  # one, so leaving it means the next run counts it and prunes a real backup
  # to make room for a broken one.
  rm -f "$OUT"
  die "Backup failed. Nothing was kept."
}

SIZE="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
ok "Backed up to $OUT ($SIZE)"

if [ "$KEEP" -gt 0 ]; then
  # Oldest first, past the newest $KEEP. `ls -t` is newest first, so the ones
  # to remove are everything after that many lines.
  PRUNED=0
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old"
    PRUNED=$((PRUNED + 1))
  done < <(ls -1t "$DEST/$PREFIX"-*.db 2>/dev/null | tail -n "+$((KEEP + 1))")
  [ "$PRUNED" -gt 0 ] && warn "Removed $PRUNED backup$([ "$PRUNED" -eq 1 ] || echo s) beyond the last $KEEP."
fi

ok "$(ls -1 "$DEST/$PREFIX"-*.db 2>/dev/null | wc -l | tr -d ' ') backup(s) of $PREFIX now in $DEST"
