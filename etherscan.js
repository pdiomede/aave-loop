/**
 * Finding a trade's transactions on Etherscan: the hash of each stage, for
 * Wallets > Simulation. Server-only, like the price and rate fetchers: it
 * holds an API key, and the browser is served `lib/` wholesale.
 *
 * Every stage of a loop moves the trade's stablecoin into or out of its
 * wallet - the loan arrives, the purchase spends it, the sale brings it back,
 * the repayment sends it - so a stage's transaction is the one carrying that
 * ERC-20 transfer, on or about the stage's day, for about its amount. One
 * request lists every token transfer of the wallet over the stage's days
 * (`account/tokentx`, between two blocks looked up by time) and the rest is
 * worked out here.
 *
 * A token is known by its contract, never its symbol. Wallets are sent fake
 * tokens named like real ones to plant look-alike entries in their history
 * (address poisoning): the wallet these were written against holds an
 * "ÚЅDС" transfer of 10,000 beside its real USDC ones.
 *
 * The amount alone does not settle it either. Two loops run the same evening
 * each borrowed exactly 30,000 EURC and each swapped exactly 30,000 EURC for
 * WETH. The purchase is told apart by the asset it brought in (12.649134 WETH
 * against a typed 12.6491), the loan by being the last one before that
 * purchase, the repayment by being the first after the sale, and a hash
 * already linked to that stage of another trade is never offered again.
 * Whatever is left tied is still answered, with how many others fitted, so
 * the card can say to check it.
 */
import { setting } from './env.js';
import { etherscanKey } from './config.js';
import { assetOf, parseDate } from './lib/calc.js';
import { n2, fmtDate } from './format.js';

export const TX_STAGES = ['borrow', 'buy', 'sell', 'repay'];

// Mainnet contracts, lowercase as Etherscan writes them, each checked
// against Etherscan's own token record (symbol and decimals) on 25 Nov 2026.
const STABLE = {
  DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
  EURC: '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
  GHO: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
};

// What a purchase brings in and a sale sends out. ETH is swapped as WETH by
// the aggregators these loops use; a swap of native ETH moves no token, so it
// simply has no asset leg to compare, for every candidate alike.
const ASSET_TOKEN = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  cbbtc: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  wbtc: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
};

const RULE = {
  borrow: { dir: 'in', date: 'borrow_date', amount: 'borrow_amount', noun: 'loan' },
  buy: { dir: 'out', date: 'buy_date', amount: 'buy_amount', qty: 'buy_eth', qtyDir: 'in', noun: 'purchase' },
  sell: { dir: 'in', date: 'sell_date', amount: 'sell_amount', qty: 'sell_eth', qtyDir: 'out', noun: 'sale' },
  repay: { dir: 'out', date: 'repay_date', amount: 'repay_amount', noun: 'repayment' },
};

/** What a stage needs before it can be searched: its day and its amount. */
export const stageRecorded = (t, stage) => Boolean(t[RULE[stage].date]) && Number(t[RULE[stage].amount]) > 0;

/**
 * The stage whose transaction settles a tie for this one: the loan is the
 * last before its purchase, the repayment the first after its sale.
 */
export const ANCHOR = { borrow: 'buy', repay: 'sell' };

/**
 * The fields a stored hash was found from: a change to any of them clears it.
 * A loan's or repayment's includes its anchor's, which set its window and
 * decided its ties: a loan found while the purchase's quantity was mistyped
 * stayed linked to the other loop's loan once the quantity was put right.
 */
export function txBasis(stage) {
  const own = (r) => [r.date, r.amount, r.qty].filter(Boolean);
  const anchor = ANCHOR[stage] ? own(RULE[ANCHOR[stage]]) : [];
  return [...own(RULE[stage]), ...anchor, 'wallet_id', 'borrow_currency', 'asset'];
}

const DAY = 86_400_000;
// The free tier allows three calls a second, and refused one call in three
// spaced 250 ms apart; 400 ms leaves room, and a refusal for the rate is
// tried again, twice, after a second.
const GAP_MS = 400;
const RATE_RETRIES = 2;
const TIMEOUT_MS = 10_000;
const PAGE = 1000;
const MAX_PAGES = 10;
// Within 1% of the typed amount, or a cent: the typed figure is the card's,
// and a transfer carries more places (30,001.094107 for 30,001.09).
const TOLERANCE = 0.01;
const NEAR = 0.0005;

const BASE = () => setting('ETHERSCAN_URL') || 'https://api.etherscan.io/v2/api';

/** Any text leaving this module, with the key taken out of it. */
const redact = (text, key) => {
  const s = String(text ?? '');
  return key ? s.split(key).join('<key>') : s;
};

class EtherscanError extends Error {}

// One request at a time, spaced: two cards searched at once would otherwise
// fire six calls in a burst and the free tier refuses the sixth.
let queue = Promise.resolve();
let lastAt = 0;

async function call(params, key) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callOnce(params, key);
    } catch (err) {
      if (!(err instanceof RateLimited) || attempt >= RATE_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
}

class RateLimited extends EtherscanError {}

function callOnce(params, key) {
  const run = queue.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    const url = new URL(BASE());
    for (const [k, v] of Object.entries({ chainid: 1, ...params, apikey: key })) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new EtherscanError(
        err?.name === 'TimeoutError' ? 'Etherscan did not answer in time. Try again.' : 'Etherscan could not be reached. Try again.',
      );
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new EtherscanError(`Etherscan answered ${res.status} with something that is not its JSON. Try again.`);
    }
    if (body?.status === '1') return body.result;
    // "No transactions found" is an empty answer, not a failure.
    if (Array.isArray(body?.result) && /no transactions found/i.test(body?.message ?? '')) return [];
    const said = String(body?.result ?? body?.message ?? `status ${res.status}`);
    if (/invalid api key|missing\/invalid api key/i.test(said)) {
      throw new EtherscanError('Etherscan refused the ETHERSCAN_API_KEY in config.env.');
    }
    if (/rate limit/i.test(said)) throw new RateLimited("Etherscan's rate limit was reached. Try again in a moment.");
    throw new EtherscanError(`Etherscan answered: ${redact(said, key).slice(0, 160)}`);
  });
  queue = run.catch(() => {});
  return run;
}

const ts = (ms) => Math.floor(ms / 1000);

// A block for a time an hour or more past never changes, so it is asked for
// once per process. And a wallet's transfers over a window are kept for two
// minutes: the four stages of a trade mostly search the same days, and
// finding all four was twelve calls where it is now about five.
const blocks = new Map();
const transfers = new Map();
const TRANSFERS_MS = 120_000;

async function blockAt(ms, closest, key) {
  const k = `${ts(ms)}:${closest}`;
  if (blocks.has(k)) return blocks.get(k);
  const n = Number(await call({ module: 'block', action: 'getblocknobytime', timestamp: ts(ms), closest }, key));
  if (!Number.isSafeInteger(n)) throw new EtherscanError('Etherscan gave no block for that day.');
  if (ms < Date.now() - 3_600_000) blocks.set(k, n);
  return n;
}

async function transfersBetween(address, fromMs, toMs, key) {
  const startblock = await blockAt(fromMs, 'after', key);
  const endblock = await blockAt(toMs, 'before', key);
  const k = `${lower(address)}:${startblock}:${endblock}`;
  const kept = transfers.get(k);
  if (kept && Date.now() - kept.at < TRANSFERS_MS) return kept.rows;
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await call(
      { module: 'account', action: 'tokentx', address, startblock, endblock, sort: 'asc', page, offset: PAGE },
      key,
    );
    if (!Array.isArray(rows)) throw new EtherscanError('Etherscan answered without a list of transfers.');
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  for (const [old, v] of transfers) if (Date.now() - v.at >= TRANSFERS_MS) transfers.delete(old);
  transfers.set(k, { at: Date.now(), rows: out });
  return out;
}

/**
 * The days searched for a stage: its own, a day either side - the date typed
 * is the reader's local day and the chain keeps UTC - and, for the loan and
 * the repayment, the purchase or sale they are told apart by when it is
 * within a week. Never past now.
 */
function windowOf(t, stage) {
  const day = (iso) => parseDate(iso);
  const own = day(t[RULE[stage].date]);
  let from = own;
  let to = own;
  if (stage === 'borrow' && t.buy_date && day(t.buy_date) >= own && day(t.buy_date) - own <= 7 * DAY) to = day(t.buy_date);
  if (stage === 'repay' && t.sell_date && day(t.sell_date) <= own && own - day(t.sell_date) <= 7 * DAY) from = day(t.sell_date);
  return { from: from - DAY, to: Math.min(to + 2 * DAY - 1000, Date.now() - 60_000) };
}

const lower = (s) => String(s ?? '').toLowerCase();
const amountOf = (row) => Number(row.value) / 10 ** Number(row.tokenDecimal);

/**
 * The transfers that could be this stage, best first. Ranked by the amount
 * first - anything within 0.05% or a cent of the typed one counts as exact
 * (`near`), the rest by how far off they are - and only then, for a purchase
 * or sale, by how far the asset leg of the same transaction is from the typed
 * quantity. Added into one score, a sale with no WETH leg at all (swapped
 * through aEthWETH, say) lost to another trade's sale 0.08% off whose WETH leg
 * happened to fit. Pure, over rows already fetched.
 */
function candidates(rows, t, stage, wallet, claimed) {
  const r = RULE[stage];
  const token = STABLE[t.borrow_currency];
  const want = Number(t[r.amount]);
  const w = lower(wallet);
  const assetToken = ASSET_TOKEN[assetOf(t)];
  const wantQty = r.qty ? Number(t[r.qty]) : null;
  const out = [];
  for (const row of rows) {
    if (lower(row.contractAddress) !== token) continue;
    if (r.dir === 'in' ? lower(row.to) !== w : lower(row.from) !== w) continue;
    if (claimed.has(lower(row.hash))) continue;
    const amount = amountOf(row);
    const off = Math.abs(amount - want);
    if (!(off <= Math.max(0.01, want * TOLERANCE))) continue;
    const byAmount = off <= Math.max(0.01, want * NEAR) ? 0 : off / want;
    let byQty = 0;
    if (wantQty > 0) {
      // The asset leg of the same transaction, in the stage's direction; none
      // (a native ETH swap) ranks after any that has one.
      const leg = rows
        .filter((x) => x.hash === row.hash && lower(x.contractAddress) === assetToken)
        .filter((x) => (r.qtyDir === 'in' ? lower(x.to) === w : lower(x.from) === w))
        .reduce((s, x) => s + amountOf(x), 0);
      byQty = leg > 0 ? Math.abs(leg - wantQty) / wantQty : Infinity;
    }
    out.push({ hash: lower(row.hash), at: Number(row.timeStamp) * 1000, amount, byAmount, byQty });
  }
  return out.sort((a, b) => a.byAmount - b.byAmount || cmp(a.byQty, b.byQty) || a.at - b.at);
}

const cmp = (a, b) => (a === b ? 0 : a - b);
const same = (a, b) => a === b || Math.abs(a - b) <= SAME;

// Scores this close are the same fit: 1e-6 is a hundredth of a cent on 10,000.
const SAME = 1e-6;

/** The best fit for a stage, or null, with how many others fitted as well. */
function pick(rows, t, stage, wallet, claimed, own = {}) {
  const list = candidates(rows, t, stage, wallet, claimed[stage] ?? new Set());
  if (!list.length) return null;
  let tied = list.filter((c) => same(c.byAmount, list[0].byAmount) && same(c.byQty, list[0].byQty));
  if (tied.length > 1) {
    // The loan is the last one before its purchase, the repayment the first
    // after its sale; anything else, the one nearest the day typed. The
    // purchase or sale is the trade's own stored one when it has one - a hash
    // pasted after checking it is the purchase, where a fresh guess may be
    // the other loop's - and otherwise found here, and a guess it was passes
    // its doubt on: the loan it settles is no surer than it.
    const anchorStage = ANCHOR[stage];
    let anchor = null;
    if (anchorStage && stageRecorded(t, anchorStage)) {
      const kept = own[anchorStage] && rows.find((x) => lower(x.hash) === own[anchorStage]);
      anchor = kept ? { at: Number(kept.timeStamp) * 1000, others: 0 } : pick(rows, t, anchorStage, wallet, claimed, own);
    }
    if (anchor) {
      const ordered =
        stage === 'borrow'
          ? tied.filter((c) => c.at <= anchor.at).sort((a, b) => b.at - a.at)
          : tied.filter((c) => c.at >= anchor.at).sort((a, b) => a.at - b.at);
      if (ordered.length) return { ...ordered[0], others: anchor.others };
    }
    const noon = parseDate(t[RULE[stage].date]) + DAY / 2;
    tied = [...tied].sort((a, b) => Math.abs(a.at - noon) - Math.abs(b.at - noon));
  }
  return { ...tied[0], others: tied.length - 1 };
}

/**
 * Search Etherscan for one stage of a trade. `wallet` is the trade's
 * (`{ name, address }`); `claimed` maps each stage to the hashes other trades
 * already hold for it; `own` the trade's own stored hashes, by stage. Answers `{ found: true, hash, at, amount, others }` or
 * `{ found: false, reason }`, never throws: a search that could not be done
 * is a result the card shows.
 */
export async function findStageTx(t, stage, wallet, claimed = {}, own = {}) {
  const { key, reason } = etherscanKey();
  if (!key) return { found: false, reason };
  if (!STABLE[t.borrow_currency]) return { found: false, reason: `${t.borrow_currency} has no known contract to search for.` };
  const { from, to } = windowOf(t, stage);
  try {
    const rows = await transfersBetween(wallet.address, from, to, key);
    const best = pick(rows, t, stage, wallet.address, claimed, own);
    if (best) {
      return { found: true, hash: best.hash, at: new Date(best.at).toISOString(), amount: best.amount, others: best.others };
    }
    const r = RULE[stage];
    const span = `between ${fmtDate(new Date(from).toISOString().slice(0, 10))} and ${fmtDate(new Date(to).toISOString().slice(0, 10))}`;
    return {
      found: false,
      reason:
        `No ${t.borrow_currency} transfer of about ${n2(Number(t[r.amount]))} ` +
        `${r.dir === 'in' ? 'into' : 'out of'} ${wallet.name} ${span} fits this ${r.noun}. Paste its hash instead.`,
    };
  } catch (err) {
    return {
      found: false,
      reason: err instanceof EtherscanError ? redact(err.message, key) : 'The search failed. Try again.',
    };
  }
}
