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

# Kept before the cd, so a relative --dest or --log means what the person
# typing it meant. Without this they resolved against the checkout instead:
# `--dest backups` from a home folder quietly filled /var/www/aave/backups,
# and the success line printed the bare relative path, so it did not even
# say where the file had gone.
INVOKED_FROM="$PWD"

# The cd itself is for `require("better-sqlite3")` below, which resolves from
# the working directory.
cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""; fi

ok()   { printf '  %s+%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

DB="${MYAAVE_DB:-data/myaave.db}"
# HOME is not guaranteed. cron sets it from the passwd entry, but a systemd
# timer does not, and under `set -u` a bare $HOME took the script down with
# "HOME: unbound variable" rather than saying what to pass instead.
if [ -n "${MYAAVE_BACKUP_DIR:-}" ]; then
  DEST="$MYAAVE_BACKUP_DIR"
elif [ -n "${HOME:-}" ]; then
  DEST="$HOME/aaveloop-backups"
else
  DEST=""
fi
LOG=""
KEEP=12
# Whether --db was given, as opposed to defaulted. The default and MYAAVE_DB
# are relative to the checkout - `data/myaave.db` only means anything there,
# and resetDatabase.sh reads them the same way. A path typed on the command
# line is not that: it means what it means from where it was typed.
DB_GIVEN=0

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
  --log FILE    Append this run's output here instead of the console. A log
                that cannot be opened is a warning, not a failure - the
                backup still runs.
  --help        Show this message.

Relative paths are resolved from wherever you run this, not from the folder
the script lives in.

Backups are matched on the database's own name, so several databases can
share one destination folder without pruning each other.

A weekly cron line. Run it as the user the service runs as, which is the one
that can read the database: on a default install `data/` is mode 700 and owned
by that account, so nobody else can even look inside it.

  0 3 * * 0 cd /var/www/aave && ./backupDatabase.sh --log "$HOME/aaveloop-backup.log"

Add it with `crontab -e` while logged in as that user, or `sudo crontab -u
<user> -e` from an account with sudo. Prefer --log over a `>>` redirect: a
redirect the shell cannot open fails before this script starts, so the backup
never runs, and with no mail configured nothing says so.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) [ $# -ge 2 ] || die "--dest needs a path."; DEST="$2"; shift 2 ;;
    --dest=*) DEST="${1#*=}"; shift ;;
    --keep) [ $# -ge 2 ] || die "--keep needs a number."; KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${1#*=}"; shift ;;
    --db) [ $# -ge 2 ] || die "--db needs a path."; DB="$2"; DB_GIVEN=1; shift 2 ;;
    --db=*) DB="${1#*=}"; DB_GIVEN=1; shift ;;
    --log) [ $# -ge 2 ] || die "--log needs a path."; LOG="$2"; shift 2 ;;
    --log=*) LOG="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1. Try --help." ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "--keep must be a number, got '$KEEP'." ;;
esac
# Digits alone are not enough: a value past what bash can compare made `[` fail
# with "integer expression expected" and skipped the prune entirely, loudly
# enough to be confusing and quietly enough to leave every backup in place.
[ "${#KEEP}" -le 9 ] || die "--keep is absurdly large, got '$KEEP'. Use 0 to keep everything."

[ -n "$DEST" ] || die "No destination. HOME is not set here, so pass --dest."

# Named now rather than reaching the copy and reporting a bare failure. cron
# runs with a short PATH - often just /usr/bin:/bin - so a node installed by
# nvm or under /usr/local is on the PATH of the person who tested this by hand
# and absent from the one the schedule uses.
command -v node >/dev/null 2>&1 || die "node is not on PATH. Under cron, set PATH in the crontab to include it."

# Relative to where this was run from, not to the checkout it lives in.
# Without this for --db, standing in a folder with its own data/myaave.db and
# passing `--db data/myaave.db` backed up the checkout's database instead, and
# said it had succeeded: the wrong ledger, copied and reported as the right one.
case "$DEST" in /*) ;; *) DEST="$INVOKED_FROM/$DEST" ;; esac
case "$LOG" in ''|/*) ;; *) LOG="$INVOKED_FROM/$LOG" ;; esac
if [ "$DB_GIVEN" -eq 1 ]; then
  case "$DB" in /*) ;; *) DB="$INVOKED_FROM/$DB" ;; esac
fi

# The script owns its log rather than leaving it to a `>>` in the crontab.
# A redirect the shell cannot open fails before the script starts, so the
# backup never runs at all - and with no mail configured, that is a weekly
# job silently doing nothing. Opened here it is one warning, and the backup
# still happens, which is the part that matters.
if [ -n "$LOG" ]; then
  # In a subshell: a redirect bash cannot open reports itself before the
  # command's own stderr redirection applies, so the raw error leaks out.
  if ( : >> "$LOG" ) 2>/dev/null; then
    exec >> "$LOG" 2>&1
    # A log file is never a terminal.
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""
  else
    warn "Could not open the log at $LOG. Carrying on, writing to the console."
  fi
fi

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

# Creatable and writable are different, and `mkdir -p` on a directory that is
# already there succeeds whoever owns it. Without this the run got as far as
# the copy and failed with SQLite's own "unable to open database file", which
# names neither the directory nor the reason.
if [ ! -w "$DEST" ] || [ ! -x "$DEST" ]; then
  die "Cannot write into $DEST - it belongs to $(ls -ld "$DEST" | awk '{print $3}'). Pass --dest with somewhere this account can write."
fi

# Every file this script writes, reads back or removes is matched on this
# prefix and never on a bare `*.db`. Two things went wrong without it, and
# both destroyed data rather than merely miscounting: a destination pointed
# at the database's own folder pruned the live `myaave.db`, because an idle
# fortnight left it older than the backups around it; and two ledgers backed
# up to one folder pruned each other, since the newest N of everything is
# not the newest N of either.
PREFIX="$(basename "${DB%.db}")"

# Absolute, with symlinks and `..` resolved, so the guard in the prune loop
# compares the same thing however the path was written.
canonical() {
  local dir base
  dir="$(dirname "$1")"
  base="$(basename "$1")"
  ( cd "$dir" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$base" )
}
LIVE_DB="$(canonical "$DB")"
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
    # The one file this must never remove, whatever the glob above matched.
    # Scoping the pattern to the backup prefix already means the live file
    # cannot match it - `myaave.db` is not `myaave-*.db` - but that is an
    # argument about a pattern, and this is a backup tool: the source going
    # missing is the one outcome with no recovery. So it is also checked
    # outright, against the resolved path rather than the spelling.
    if [ "$(canonical "$old")" = "$LIVE_DB" ]; then
      warn "Refusing to remove $old: that is the live database."
      continue
    fi
    rm -f "$old"
    PRUNED=$((PRUNED + 1))
  done < <(ls -1t "$DEST/$PREFIX"-*.db 2>/dev/null | tail -n "+$((KEEP + 1))")
  [ "$PRUNED" -gt 0 ] && warn "Removed $PRUNED backup$([ "$PRUNED" -eq 1 ] || echo s) beyond the last $KEEP."
fi

ok "$(ls -1 "$DEST/$PREFIX"-*.db 2>/dev/null | wc -l | tr -d ' ') backup(s) of $PREFIX now in $DEST"
