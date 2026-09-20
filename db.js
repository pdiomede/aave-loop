import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { PEGGED_CURRENCIES } from './lib/calc.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.MYAAVE_DB || path.join(root, 'data', 'myaave.db');

// The directory of whichever file was chosen, not `data/`. MYAAVE_DB can point
// anywhere, and creating `data/` while writing somewhere else left an empty
// directory behind on every install that used it.
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// The launcher will happily start a second instance on the next free port,
// and both point at this same file. Without a busy timeout the loser of a
// write race fails instantly with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/*
 * A rate is USD per one unit of the borrowed coin, so `usd = native * fx`.
 * A dollar pegged coin is exactly 1. Nothing anywhere inverts a rate.
 *
 * Each stage carries its own rate because each stage happened on its own day.
 * A loan taken in euros and repaid two months later is not one conversion, it
 * is four, and the difference between them is a real part of what the trade
 * made or lost in dollars.
 *
 * `*_fx_date` is the date the rate was actually published on, which is not
 * always the date of the transaction: the ECB publishes on business days, so a
 * Sunday purchase is converted at Friday's rate. Storing it means the figure
 * can be checked against the ECB's own tables rather than taken on trust.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    borrow_date     TEXT    NOT NULL,
    borrow_amount   REAL    NOT NULL,
    borrow_currency TEXT    NOT NULL,
    borrow_apr      REAL    NOT NULL,
    buy_date        TEXT,
    buy_amount      REAL,
    buy_eth         REAL,
    sell_date       TEXT,
    sell_amount     REAL,
    sell_eth        REAL,
    repay_date      TEXT,
    repay_amount    REAL,
    notes           TEXT,
    borrow_fx       REAL,
    borrow_fx_date  TEXT,
    buy_fx          REAL,
    buy_fx_date     TEXT,
    sell_fx         REAL,
    sell_fx_date    TEXT,
    repay_fx        REAL,
    repay_fx_date   TEXT,
    fx_source       TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trades_borrow_date ON trades (borrow_date);

  CREATE TABLE IF NOT EXISTS fx_rates (
    base       TEXT NOT NULL,
    quote      TEXT NOT NULL,
    date       TEXT NOT NULL,
    rate       REAL NOT NULL,
    rate_date  TEXT NOT NULL,
    source     TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (base, quote, date)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    goal_price  REAL    NOT NULL,
    direction   TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    basis_price REAL,
    fired_at    TEXT,
    fired_price REAL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eth_price (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    price      REAL    NOT NULL,
    fetched_at TEXT    NOT NULL,
    change_24h REAL,
    change_7d  REAL,
    change_30d REAL
  );

  CREATE TABLE IF NOT EXISTS bot_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    holder        TEXT,
    lease_until   TEXT,
    next_offset   INTEGER NOT NULL DEFAULT 0,
    watch         INTEGER NOT NULL DEFAULT 0,
    watch_next_at TEXT,
    updated_at    TEXT    NOT NULL
  );
`);

/**
 * Everything the Telegram bot has to remember between one poll and the next,
 * in one row.
 *
 * Telegram hands an update to exactly one caller of `getUpdates`, and a second
 * caller gets an error rather than a copy. This app can legitimately be running
 * twice against this same file, so one of the two has to be the one that polls:
 * `holder` and `lease_until` are that lease, taken and renewed by the same kind
 * of conditional UPDATE the alerts use to claim a firing.
 *
 * `next_offset` is how far Telegram has been told we have read. It lives here
 * rather than in a variable because that is precisely what makes a handover
 * safe: whoever picks the lease up carries on from where the last holder got
 * to, instead of from whatever its own memory happened to say. It shares the
 * row with the lease because advancing it and renewing the lease have to be one
 * statement - only the holder may move it.
 *
 * `watch` and `watch_next_at` are the price report every twenty minutes. The
 * deadline is stored, not just the switch: keeping only the switch would reset
 * the phase on every restart, and a process that crashes and comes back would
 * send a report each time it did.
 *
 * Every time written here comes from JavaScript, never from SQLite's own
 * `datetime('now')`. The lease is compared as text, which is exact for ISO
 * strings ending in Z and quietly wrong for anything shaped differently. That
 * is also why the row is seeded from bot.js rather than in the DDL above.
 */

/**
 * A price alert, and the last ETH price anyone looked up.
 *
 * An alert has an id of its own, and a trade can have many. That is what lets a
 * fired one be kept: the bell on the card reads only the armed alert, so it
 * goes back to unselected once the message has gone and a new goal can be set,
 * while the one that fired stays in the Alerts view with the time it was sent.
 *
 * The rule that a trade has at most one *armed* alert is the partial unique
 * index below rather than the key. It is not decoration: the sweep and the
 * holding report both join alerts to trades by trade id with no limit, so a
 * second armed row would send one message twice and count one position twice.
 *
 * Deleting the trade takes every alert on it, for real, because `foreign_keys`
 * is ON above.
 *
 * What is *not* here is as deliberate. The alert window shows the amount, the
 * date and the price the ETH was bought at, and none of the three are stored:
 * they live on the trade, an edit can move any of them, and a copy taken when
 * the alert was set would quietly start disagreeing with the card beside it.
 * The two prices that are stored, `basis_price` and `fired_price`, are the
 * exception for the same reason the `*_fx` columns are: a price observed at a
 * moment cannot be recomputed later, so not keeping it loses it.
 *
 * `eth_price` holds exactly one row. It is on disk rather than in a module
 * variable so a restart starts warm and a second copy of the app sees the same
 * figure, which matters because both poll.
 */

/**
 * The rate cache is keyed on the peg rather than on the coin, so EUR is looked
 * up once however many euro coins ever get added. `date` is the day that was
 * asked about and `rate_date` the day the rate was published on. On a weekend
 * those differ, which is the whole reason both are kept.
 */

/**
 * The one migration here that ALTER TABLE cannot do.
 *
 * `trade_id` used to be the primary key, which was the whole of the rule that a
 * trade had one alert - and so the reason a fired one had to be overwritten to
 * set another goal. Keeping it as history needs a key of its own, and SQLite
 * has no way to add one to a table that already exists. So the table is rebuilt
 * once: create, copy, drop, rename.
 *
 * Detected by shape rather than by a version number. A column named `id` is
 * exactly what the new table has and the old one cannot, which answers for a
 * fresh database (the CREATE TABLE above already made the new shape), an old
 * one (CREATE TABLE IF NOT EXISTS left it alone) and one already migrated, with
 * one predicate and nothing to keep in step.
 *
 * Foreign keys stay ON throughout. The usual advice to switch them off is for
 * renaming a *parent* table, where other tables' REFERENCES clauses have to be
 * rewritten; nothing in this schema references alerts, so there is nothing to
 * protect - and SQLite ignores a change to that pragma inside a transaction
 * anyway. Leaving them on is what checks each copied row against its trade.
 */
const ALERT_COLUMNS =
  'trade_id, goal_price, direction, status, basis_price, fired_at, ' +
  'fired_price, attempts, last_error, created_at, updated_at';

function alertsNeedRebuild() {
  const cols = db.pragma('table_info(alerts)');
  return cols.length > 0 && !cols.some((c) => c.name === 'id');
}

function rebuildAlerts() {
  // Read the shape again, now that the write lock is held. Two copies of this
  // app can boot against the same file at the same moment, and both would have
  // seen the old shape outside it; the loser must not rebuild what the winner
  // has just finished.
  if (!alertsNeedRebuild()) return false;

  db.exec(`
    CREATE TABLE alerts_rebuild (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
      goal_price  REAL    NOT NULL,
      direction   TEXT    NOT NULL,
      status      TEXT    NOT NULL,
      basis_price REAL,
      fired_at    TEXT,
      fired_price REAL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
    )
  `);

  // Oldest first, so the new ids run in the order the alerts were set.
  //
  // The old rowid is deliberately not carried across: `trade_id` *was* the
  // rowid, so copying it would make every alert id equal to a trade id, which
  // is the one confusion the routes are now shaped to avoid.
  //
  // The WHERE drops a row whose trade is gone. ON DELETE CASCADE should mean
  // there are none, but a file edited with foreign keys off would otherwise
  // abort the migration, and a boot that fails on an orphan is worse than one
  // that leaves it behind.
  db.exec(`
    INSERT INTO alerts_rebuild (${ALERT_COLUMNS})
    SELECT ${ALERT_COLUMNS} FROM alerts
     WHERE trade_id IN (SELECT id FROM trades)
     ORDER BY created_at, trade_id
  `);

  db.exec('DROP TABLE alerts');
  db.exec('ALTER TABLE alerts_rebuild RENAME TO alerts');
  return true;
}

// `.immediate()` takes the write lock on the first statement rather than on the
// first write, which is what puts the re-check above inside it.
if (db.transaction(rebuildAlerts).immediate()) {
  console.log('Alerts rebuilt: each one now has its own id, so a fired alert is kept.');
}

/**
 * After the rebuild, so a fresh database and a migrated one arrive here by the
 * same path.
 */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);
  CREATE INDEX IF NOT EXISTS idx_alerts_trade  ON alerts (trade_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_armed
    ON alerts (trade_id) WHERE status = 'armed';
`);

/**
 * SQLite has no 'ADD COLUMN IF NOT EXISTS', and CREATE TABLE IF NOT EXISTS
 * leaves an existing table exactly as it found it. So read the shape back and
 * add only what is missing. Every ledger written before exchange rates existed
 * has to keep opening, unchanged, without anyone running a migration by hand.
 *
 * The same is true of the price cache, which gained the three change windows
 * when the bot learned to report them: an install from before that has a table
 * three columns short, and CREATE TABLE above will not touch it.
 */
const FX_COLUMN_TYPES = [
  ['borrow_fx', 'REAL'],
  ['borrow_fx_date', 'TEXT'],
  ['buy_fx', 'REAL'],
  ['buy_fx_date', 'TEXT'],
  ['sell_fx', 'REAL'],
  ['sell_fx_date', 'TEXT'],
  ['repay_fx', 'REAL'],
  ['repay_fx_date', 'TEXT'],
  ['fx_source', 'TEXT'],
];

const ETH_MARKET_COLUMNS = [
  ['change_24h', 'REAL'],
  ['change_7d', 'REAL'],
  ['change_30d', 'REAL'],
];

function addMissingColumns(table, columns) {
  const present = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
  const missing = columns.filter(([name]) => !present.has(name));
  for (const [name, type] of missing) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  return missing.length;
}

db.transaction(() => {
  addMissingColumns('trades', FX_COLUMN_TYPES);
  addMissingColumns('eth_price', ETH_MARKET_COLUMNS);
})();

export const FIELDS = [
  'borrow_date',
  'borrow_amount',
  'borrow_currency',
  'borrow_apr',
  'buy_date',
  'buy_amount',
  'buy_eth',
  'sell_date',
  'sell_amount',
  'sell_eth',
  'repay_date',
  'repay_amount',
  'notes',
];

/**
 * Exchange rate columns are kept apart from FIELDS on purpose. FIELDS means
 * "things somebody types into a form"; these are resolved by the server from a
 * published rate and are never accepted from a request body, so a client cannot
 * post its own rate and move the dollar figures.
 */
export const FX_COLUMNS = [
  'borrow_fx',
  'borrow_fx_date',
  'buy_fx',
  'buy_fx_date',
  'sell_fx',
  'sell_fx_date',
  'repay_fx',
  'repay_fx_date',
  'fx_source',
];

/** The dollar pegged coins, quoted for SQL. Kept in step with lib/calc.js. */
const PEGGED_SQL = PEGGED_CURRENCIES.map((c) => `'${c}'`).join(', ');

/**
 * Prepared statements are expensive to build and safe to keep, but the PATCH
 * SQL varies with the set of columns being written. Cache by SQL text so each
 * distinct shape is compiled once for the life of the process rather than on
 * every request.
 */
const statementCache = new Map();

export function prepare(sql) {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

/** Rows that still need a rate looked up, newest first. */
export function tradesMissingFx() {
  return prepare(`
    SELECT * FROM trades
    WHERE borrow_currency NOT IN (${PEGGED_SQL})
      AND (
        (borrow_date IS NOT NULL AND borrow_fx IS NULL) OR
        (buy_date    IS NOT NULL AND buy_fx    IS NULL) OR
        (sell_date   IS NOT NULL AND sell_fx   IS NULL) OR
        (repay_date  IS NOT NULL AND repay_fx  IS NULL)
      )
    ORDER BY borrow_date DESC, id DESC
  `).all();
}

/**
 * Rows whose rate came from a day earlier than the day of the transaction, and
 * whose day is recent enough that the real rate could still arrive. The ECB
 * had not published yet when these were entered, so asking again later can
 * replace a stand-in with the real thing.
 *
 * The cutoff is what makes the list finite. A transaction on a day the ECB
 * never publishes on is converted at the business day before it, permanently
 * and correctly. This used to be decided by asking whether the day was a
 * weekday, which is true of Christmas Day and every other ECB holiday, so
 * those rows sat in this list forever, re-fetched on every refresh and counted
 * as still missing each time. Nothing here needs the ECB's holiday calendar:
 * a day whose real rate has not appeared within a few days is a day that has
 * no rate of its own.
 */
const IS_REPLACEABLE = (fx, fxDate, date) =>
  `(${fx} IS NOT NULL AND ${fxDate} IS NOT NULL AND ${fxDate} < ${date} AND ${date} >= @since)`;

export function tradesWithSubstitutedFx(sinceISO) {
  return prepare(`
    SELECT * FROM trades
    WHERE borrow_currency NOT IN (${PEGGED_SQL})
      AND (
        ${IS_REPLACEABLE('borrow_fx', 'borrow_fx_date', 'borrow_date')} OR
        ${IS_REPLACEABLE('buy_fx', 'buy_fx_date', 'buy_date')} OR
        ${IS_REPLACEABLE('sell_fx', 'sell_fx_date', 'sell_date')} OR
        ${IS_REPLACEABLE('repay_fx', 'repay_fx_date', 'repay_date')}
      )
    ORDER BY borrow_date DESC, id DESC
  `).all({ since: sinceISO });
}

let closed = false;

/**
 * Flush the write ahead log back into the main database file and close the
 * handle. Without this, stopping the server leaves committed rows sitting in
 * a -wal sidecar and the connection is never released.
 */
export function closeDb() {
  if (closed) return;
  closed = true;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('Could not checkpoint the database:', err.message);
  }
  try {
    db.close();
  } catch (err) {
    console.error('Could not close the database:', err.message);
  }
}

export const dbPath = dbFile;
