import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

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
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trades_borrow_date ON trades (borrow_date);
`);

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
