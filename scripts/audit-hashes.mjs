#!/usr/bin/env node
/**
 * Check every stored transaction hash against its trade.
 *
 *   node scripts/audit-hashes.mjs           # report only; the ledger is opened read-only
 *   node scripts/audit-hashes.mjs --apply   # also forget the *searched* hashes judged wrong
 *
 * Each hash's transaction is fetched on its trade's wallet's chain - Etherscan's
 * proxy calls for Ethereum and Arbitrum, the chain's node for Optimism and,
 * when BASE_RPC_URL is set, Base - and judged by the rules a search goes by
 * (`auditStage` in etherscan.js): it succeeded; it moves the trade's coin into
 * the wallet (loan, sale) or out of it (purchase, repayment) for about the
 * stage's amount; a loan or repayment is no swap within the coin, nor a
 * purchase or sale; a purchase or sale moves about the typed quantity of the
 * asset; it is dated within a day of the stage; and no other trade holds the
 * same hash. Hashes found before those rules were tightened (25 Nov 2026)
 * were never checked again, which is what this is for.
 *
 * WRONG is a hash that cannot be the stage; CHECK one that may be, worth a
 * look on the explorer. `--apply` forgets WRONG hashes that a search found,
 * so the magnifier or Get onchain data can look again; a pasted one is only
 * reported, its reader having vouched for it. A row changed since it was read
 * is left alone.
 *
 * Against ETHROUNDTRIP_DB (or the older MYAAVE_DB), or data/myaave.db, with
 * config.env's ETHERSCAN_API_KEY and node settings. On the VPS, as the user
 * that owns the ledger: sudo -u myaave node scripts/audit-hashes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setting } from '../env.js';
import { auditStage, txTransfers } from '../etherscan.js';
import { NETWORK_META, networkOf } from '../lib/address.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/audit-hashes.mjs [--apply]');
  process.exit(0);
}
for (const a of args) {
  if (a !== '--apply') {
    console.error(`Unknown argument "${a}". Try --help.`);
    process.exit(1);
  }
}
const apply = args.includes('--apply');

const dbFile = setting('DB') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'myaave.db');
if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}. Set ETHROUNDTRIP_DB to the ledger's path.`);
  process.exit(1);
}
// Read-only unless asked to write: no migration, no lock held while the
// chain is asked about each hash.
const db = new Database(dbFile, { readonly: !apply, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stage_tx'").get();
if (!hasTable) {
  console.log('No hashes stored yet: this ledger has never had the server of 2.2.1 or later run on it.');
  process.exit(0);
}

const rows = db
  .prepare(
    `SELECT s.trade_id, s.stage, s.hash, s.source, t.*, w.name AS wallet_name, w.address AS wallet_address,
            w.network AS wallet_network
       FROM stage_tx s
       JOIN trades t ON t.id = s.trade_id
       LEFT JOIN wallets w ON w.id = t.wallet_id
      ORDER BY s.trade_id, CASE s.stage WHEN 'borrow' THEN 1 WHEN 'buy' THEN 2 WHEN 'sell' THEN 3 ELSE 4 END`,
  )
  .all();
if (!rows.length) {
  console.log('No hashes stored yet.');
  process.exit(0);
}

const CARD = { borrow: 'Borrowed', buy: 'Bought', sell: 'Sold', repay: 'Repaid' };
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const holders = new Map();
for (const r of rows) {
  if (!holders.has(r.hash)) holders.set(r.hash, []);
  holders.get(r.hash).push({ trade_id: r.trade_id, stage: r.stage });
}

const tally = { ok: 0, check: 0, wrong: 0, unchecked: 0 };
const toForget = [];
console.log(`${rows.length} stored hash${rows.length === 1 ? '' : 'es'}, ${dbFile}\n`);
for (const r of rows) {
  const head = `#${r.trade_id} ${CARD[r.stage].padEnd(8)} ${(r.source === 'manual' ? 'pasted' : 'found').padEnd(6)} ${short(r.hash)}`;
  let verdict;
  let notes;
  if (r.wallet_id == null || !r.wallet_address) {
    verdict = 'unchecked';
    notes = ['the trade names no wallet, so no chain to look on'];
  } else {
    const wallet = { name: r.wallet_name, address: r.wallet_address, network: r.wallet_network };
    const tx = await txTransfers(networkOf(wallet), r.hash);
    if (tx === null) {
      verdict = 'wrong';
      notes = [`no such transaction on ${NETWORK_META[networkOf(wallet)].label}`];
    } else if (tx.reason) {
      verdict = 'unchecked';
      notes = [tx.reason];
    } else {
      const other = holders.get(r.hash).find((h) => h.trade_id !== r.trade_id) ?? null;
      ({ verdict, notes } = auditStage(r, r.stage, wallet, tx, other));
    }
  }
  tally[verdict] += 1;
  const mark = { ok: 'OK   ', check: 'CHECK', wrong: 'WRONG', unchecked: '?    ' }[verdict];
  console.log(`${mark} ${head}${notes.length ? `\n        ${notes.join('\n        ')}` : ''}`);
  if (verdict === 'wrong' && r.source === 'search') toForget.push(r);
}

console.log(
  `\n${tally.ok} ok, ${tally.check} to check, ${tally.wrong} wrong` +
    `${tally.unchecked ? `, ${tally.unchecked} not checked` : ''}.`,
);
if (!toForget.length) process.exit(0);
if (!apply) {
  console.log(
    `${toForget.length} wrong hash${toForget.length === 1 ? ' was' : 'es were'} found by a search: ` +
      'run again with --apply to forget them, so they can be searched for again.',
  );
  process.exit(0);
}
// Only the row as it was read, and only a searched one: a hash replaced or
// pasted meanwhile is not this one.
const forget = db.prepare("DELETE FROM stage_tx WHERE trade_id = ? AND stage = ? AND hash = ? AND source = 'search'");
const gone = db.transaction(() => toForget.reduce((n, r) => n + forget.run(r.trade_id, r.stage, r.hash).changes, 0)).immediate();
console.log(`Forgot ${gone} wrong searched hash${gone === 1 ? '' : 'es'}. Pasted ones are only reported.`);
