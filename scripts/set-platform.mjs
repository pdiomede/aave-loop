#!/usr/bin/env node
/**
 * Fill in the platform on trades recorded before it was asked for.
 *
 *   node scripts/set-platform.mjs                       # dry run: what would change
 *   node scripts/set-platform.mjs --etherfi 25          # still a dry run
 *   node scripts/set-platform.mjs --etherfi 25 --apply  # write it
 *
 * The trades named with --etherfi (comma separated, or the flag repeated) are
 * set to Ether.fi, whatever they held. Every other trade with no platform is
 * set to Aave. A trade that already has one and is not named is left alone, so
 * running it twice changes nothing the second time.
 *
 * Against MYAAVE_DB, or data/myaave.db. It goes through db.js, so the column is
 * added first if the server has not been restarted on this version yet. Take a
 * backup first (./backupDatabase.sh); it writes in one transaction, and an
 * unknown id writes nothing at all.
 */
import { db } from '../db.js';
import { PLATFORMS, PLATFORM_META } from '../lib/calc.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/set-platform.mjs [--etherfi <id>[,<id>...]] [--apply]');
  process.exit(0);
}

const etherfi = new Set();
let apply = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--apply') apply = true;
  else if (a === '--etherfi' || a.startsWith('--etherfi=')) {
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (value === undefined) fail('--etherfi needs a trade id.');
    for (const part of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      // Plain digits only, as the API reads an id: "25abc" is not trade 25.
      if (!/^\d+$/.test(part)) fail(`"${part}" is not a trade id.`);
      etherfi.add(Number(part));
    }
  } else fail(`Unknown argument "${a}". Try --help.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const label = (p) => PLATFORM_META[p]?.label ?? '-';

const run = db.transaction(() => {
  const trades = db.prepare('SELECT id, borrow_date, borrow_currency, platform FROM trades ORDER BY id').all();
  const ids = new Set(trades.map((t) => t.id));
  const missing = [...etherfi].filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`No trade #${missing.join(', #')} in this ledger. Nothing was written.`);

  const plan = trades.map((t) => ({
    ...t,
    next: etherfi.has(t.id) ? 'etherfi' : t.platform ?? 'aave',
  }));
  const changes = plan.filter((t) => t.next !== t.platform);
  if (!plan.every((t) => PLATFORMS.includes(t.next))) throw new Error('Unexpected platform. Nothing was written.');

  if (apply) {
    // updated_at moves with the row, as any other edit's does: a PATCH from the
    // page that read the row before this ran works its edit out again.
    const stmt = db.prepare('UPDATE trades SET platform = ?, updated_at = ? WHERE id = ?');
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
console.log(`${pad('id', 6)}${pad('borrowed', 12)}${pad('coin', 6)}${pad('platform', 10)}`);
for (const t of plan) {
  const now = t.next === t.platform ? label(t.platform) : `${label(t.platform)} -> ${label(t.next)}`;
  console.log(`${pad(`#${t.id}`, 6)}${pad(t.borrow_date, 12)}${pad(t.borrow_currency, 6)}${now}`);
}
console.log('');
if (!changes.length) console.log('Nothing to change.');
else if (apply) console.log(`Set the platform on ${changes.length} trade${changes.length === 1 ? '' : 's'}.`);
else console.log(`Dry run: ${changes.length} trade${changes.length === 1 ? '' : 's'} would change. Add --apply to write.`);
