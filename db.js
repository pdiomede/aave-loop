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

export const dbPath = dbFile;
