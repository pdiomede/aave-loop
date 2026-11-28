#!/usr/bin/env node
/**
 * Mark every trade recorded before the side was asked for as a long.
 *
 *   node scripts/set-side.mjs          # dry run: what would change
 *   node scripts/set-side.mjs --apply  # write it
 *
 * Every trade with no side, open or closed, is set to Long: until shorts, every
 * loop borrowed a stablecoin and bought the asset, which is a long. A trade that
 * already has a side is left alone, so running it twice changes nothing the
 * second time.
 *
 * Against ETHROUNDTRIP_DB (or the older MYAAVE_DB), or data/myaave.db. It goes
 * through db.js, so the column is added first if the server has not been
 * restarted on this version yet. Take a backup first (./backupDatabase.sh); it
 * writes in one transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIDES, SIDE_META } from '../lib/calc.js';
import { setting } from '../env.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/set-side.mjs [--apply]');
  process.exit(0);
}

let apply = false;
for (const a of args) {
  if (a === '--apply') apply = true;
  else fail(`Unknown argument "${a}". Try --help.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The ledger has to exist before db.js is loaded, because loading it creates
// one, as in set-platform.mjs: a typo in ETHROUNDTRIP_DB made an empty ledger
// there and answered "Nothing to change.".
const dbFile = setting('DB') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'myaave.db');
if (!fs.existsSync(dbFile)) fail(`No database at ${dbFile}. Set ETHROUNDTRIP_DB to the ledger's path.`);
// db.js writes on opening (its column check takes the write lock), so a user
// who can read the ledger but not write it - anyone but the service's own -
// was answered with SQLite's stack trace. Nothing has been written by then.
let db;
try {
  ({ db } = await import('../db.js'));
} catch (err) {
  if (err?.code === 'SQLITE_READONLY' || err?.code === 'SQLITE_CANTOPEN') {
    fail(
      `Cannot write ${dbFile} as this user. Run it as the user the service runs as, ` +
        'for example: sudo -u <that user> node scripts/set-side.mjs. Nothing was written.',
    );
  }
  throw err;
}

const label = (s) => (SIDES.includes(s) ? SIDE_META[s].label : '-');

const run = db.transaction(() => {
  const trades = db.prepare('SELECT id, borrow_date, borrow_currency, repay_date, repay_amount, side FROM trades ORDER BY id').all();
  // Only a trade with none is filled in. A side that is neither long nor short
  // (written by hand, or by a newer version) is not one to overwrite with Long
  // unseen: the whole run is refused, as set-platform refuses an unknown id.
  const odd = trades.filter((t) => t.side != null && t.side !== '' && !SIDES.includes(t.side));
  if (odd.length) {
    throw new Error(`Trade #${odd.map((t) => `${t.id} has side "${t.side}"`).join(', #')}, neither long nor short. Nothing was written.`);
  }
  const plan = trades.map((t) => ({ ...t, next: SIDES.includes(t.side) ? t.side : 'long' }));
  const changes = plan.filter((t) => t.next !== t.side);
  if (apply) {
    // updated_at moves with the row, as any other edit's does: a PATCH from the
    // page that read the row before this ran works its edit out again.
    const stmt = db.prepare('UPDATE trades SET side = ?, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    for (const t of changes) stmt.run(t.next, now, t.id);
  }
  return { plan, changes };
});

let result;
try {
  // Immediate: the write lock is taken before the rows are read, so a second
  // copy of the app cannot change one in between.
  result = run.immediate();
} catch (err) {
  fail(err.message);
}

const { plan, changes } = result;
const pad = (v, n) => String(v).padEnd(n);
console.log(`${pad('id', 6)}${pad('borrowed', 12)}${pad('coin', 6)}${pad('state', 8)}side`);
for (const t of plan) {
  const now = t.next === t.side ? label(t.side) : `${label(t.side)} -> ${label(t.next)}`;
  console.log(`${pad(`#${t.id}`, 6)}${pad(t.borrow_date, 12)}${pad(t.borrow_currency, 6)}${pad(t.repay_date && t.repay_amount != null ? 'repaid' : 'open', 8)}${now}`);
}
console.log('');
if (!changes.length) console.log('Nothing to change.');
else if (apply) console.log(`Marked ${changes.length} trade${changes.length === 1 ? '' : 's'} as Long.`);
else console.log(`Dry run: ${changes.length} trade${changes.length === 1 ? '' : 's'} would change. Add --apply to write.`);
