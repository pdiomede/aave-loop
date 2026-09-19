import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { PEGGED_CURRENCIES } from './lib/calc.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const dbFile = process.env.MYAAVE_DB || path.join(dataDir, 'myaave.db');

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
`);

/**
 * The rate cache is keyed on the peg rather than on the coin, so EUR is looked
 * up once however many euro coins ever get added. `date` is the day that was
 * asked about and `rate_date` the day the rate was published on. On a weekend
 * those differ, which is the whole reason both are kept.
 */

/**
 * SQLite has no 'ADD COLUMN IF NOT EXISTS', and CREATE TABLE IF NOT EXISTS
 * leaves an existing table exactly as it found it. So read the shape back and
 * add only what is missing. Every ledger written before exchange rates existed
 * has to keep opening, unchanged, without anyone running a migration by hand.
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

function addMissingColumns() {
  const present = new Set(db.pragma('table_info(trades)').map((c) => c.name));
  const missing = FX_COLUMN_TYPES.filter(([name]) => !present.has(name));
  for (const [name, type] of missing) {
    db.exec(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
  }
  return missing.length;
}

db.transaction(addMissingColumns)();

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
 * Rows whose rate came from a day other than the day of the transaction. The
 * ECB had not published yet when these were entered, so asking again later can
 * replace a stand-in with the real thing.
 *
 * Only for a transaction on a business day. The ECB never publishes on a
 * Saturday or a Sunday, so a weekend transaction is converted at Friday's rate
 * permanently and correctly. Matching on the dates alone put every weekend
 * trade in this list forever, to be re-fetched on every refresh and counted as
 * still missing each time.
 */
const IS_BUSINESS_DAY = (col) => `CAST(strftime('%w', ${col}) AS INTEGER) BETWEEN 1 AND 5`;

export function tradesWithSubstitutedFx() {
  return prepare(`
    SELECT * FROM trades
    WHERE borrow_currency NOT IN (${PEGGED_SQL})
      AND (
        (borrow_fx IS NOT NULL AND borrow_fx_date IS NOT borrow_date
           AND ${IS_BUSINESS_DAY('borrow_date')}) OR
        (buy_fx    IS NOT NULL AND buy_fx_date    IS NOT buy_date
           AND ${IS_BUSINESS_DAY('buy_date')})    OR
        (sell_fx   IS NOT NULL AND sell_fx_date   IS NOT sell_date
           AND ${IS_BUSINESS_DAY('sell_date')})   OR
        (repay_fx  IS NOT NULL AND repay_fx_date  IS NOT repay_date
           AND ${IS_BUSINESS_DAY('repay_date')})
      )
    ORDER BY borrow_date DESC, id DESC
  `).all();
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
