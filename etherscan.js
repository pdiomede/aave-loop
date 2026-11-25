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
import { NETWORK_META, networkOf } from './lib/address.js';
import { NodeError, nodeFor, nodeReceipt, nodeTransfersBetween } from './chainnode.js';
import { n2, fmtDate } from './format.js';

export const TX_STAGES = ['borrow', 'buy', 'sell', 'repay'];

// Each chain's contracts, lowercase as Etherscan writes them; a coin can
// have two on a rollup (native USDC and the bridged USDC.e), and a coin with
// none there (EURC on Arbitrum) cannot be searched on it. Ethereum's and
// Arbitrum's were each checked against Etherscan's own token record (symbol
// and decimals) on 25 Nov 2026. Base's and Optimism's could not be: the free
// plan refuses those chains (`UNSUPPORTED` below), so they are the published
// addresses, to be checked the first time a plan that covers them is used.
const STABLE = {
  ethereum: {
    DAI: ['0x6b175474e89094c44da98b954eedeac495271d0f'],
    EURC: ['0x1abaea1f7c830bd89acc67ec4af516284b1bc33c'],
    GHO: ['0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'],
    USDC: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
    USDT: ['0xdac17f958d2ee523a2206206994597c13d831ec7'],
  },
  arbitrum: {
    DAI: ['0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'],
    GHO: ['0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33'],
    USDC: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8'],
    USDT: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
  },
  base: {
    DAI: ['0x50c5725949a6f0c72e6c4a641f24049a917db0cb'],
    EURC: ['0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42'],
    USDC: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
  },
  optimism: {
    DAI: ['0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'],
    USDC: ['0x0b2c639c533813f4aa9d7837caf62653d097ff85', '0x7f5c764cbc14f9669b88837ca1490cca17c31607'],
    USDT: ['0x94b008aa00579c1307b0ef2c499ad98a8ce58e58'],
  },
};

// What a purchase brings in and a sale sends out, per chain. ETH is swapped
// as WETH by the aggregators these loops use; a swap of native ETH moves no
// token, so it simply has no asset leg to compare, for every candidate alike.
const ASSET_TOKEN = {
  ethereum: {
    eth: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
    cbbtc: ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'],
    wbtc: ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'],
  },
  arbitrum: {
    eth: ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
    cbbtc: ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'],
    wbtc: ['0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f'],
  },
  base: {
    eth: ['0x4200000000000000000000000000000000000006'],
    cbbtc: ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'],
  },
  optimism: {
    eth: ['0x4200000000000000000000000000000000000006'],
    wbtc: ['0x68f180fcce6836688e9084f035309e29bf0a2095'],
  },
};

// Places per contract, for transfers read from a node or a receipt, which
// carry none. Ethereum's and Arbitrum's as Etherscan's token records give
// them, Base's and Optimism's read from the contracts themselves (symbol and
// decimals), on 25 Nov 2026.
const DECIMALS = {
  '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI, Ethereum
  '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c': 6, // EURC, Ethereum
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': 18, // GHO, Ethereum
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC, Ethereum
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT, Ethereum
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 18, // WETH, Ethereum
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8, // WBTC, Ethereum
  '0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33': 18, // GHO, Arbitrum
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6, // USDC, Arbitrum
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 6, // USDC.e, Arbitrum
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6, // USDT, Arbitrum
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 18, // WETH, Arbitrum
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 8, // WBTC, Arbitrum
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC, Base
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 6, // EURC, Base
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18, // DAI, Base
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 6, // USDC, Optimism
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607': 6, // USDC.e, Optimism
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 6, // USDT, Optimism
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18, // DAI, Optimism
  '0x4200000000000000000000000000000000000006': 18, // WETH, Base and Optimism
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 8, // cbBTC
  '0x68f180fcce6836688e9084f035309e29bf0a2095': 8, // WBTC, Optimism
};

// Chains Etherscan said the key's plan does not cover ("Free API access is not
// supported for this chain"), until when: asked again an hour on, so a plan
// upgraded meanwhile is noticed, and not on every stage of a scan before then.
const UNSUPPORTED = new Map();
const UNSUPPORTED_MS = 3_600_000;
const unsupportedReason = (network, why = null) =>
  `${why ?? `Etherscan's free plan does not cover ${NETWORK_META[network].label}, and no ${NETWORK_META[network].label} node is set (${network.toUpperCase()}_RPC_URL in config.env).`} ` +
  `Paste the hash from ${new URL(NETWORK_META[network].txExplorer).host} instead.`;

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
 * Whether a transaction's time is within a stage's own days: its date, a day
 * either side (the date typed is local, the chain keeps UTC). The search
 * reads a loan's window out to its purchase's day, to settle ties against
 * it, but a loan is only ever one of its own days; held to nothing, a loan
 * days off its date was linked, and the audit, holding it to this, called it
 * wrong.
 */
export function withinStageDays(t, stage, at) {
  const day = parseDate(t[RULE[stage].date]);
  return day !== null && at >= day - DAY && at < day + 2 * DAY;
}

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

/**
 * A search that could not be done, and what kind of failure it was, for the
 * page's Get onchain data to act on: `setup` (no key, or the key refused) ends
 * a scan at once, `busy` (the rate limit, a timeout, no answer, an answer that
 * is not Etherscan's) is waited out and tried again, and `unsupported` (a chain
 * the key's plan does not cover: Base and Optimism on the free one) skips that
 * wallet's stages. A stage simply not found is no error and has no kind.
 */
class EtherscanError extends Error {
  constructor(message, kind = 'busy') {
    super(message);
    this.kind = kind;
  }
}

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
    // The proxy module (a receipt, a block) answers as JSON-RPC does.
    if (body && 'jsonrpc' in body) {
      if (body.error) throw new EtherscanError(`Etherscan answered: ${redact(body.error.message ?? 'an error', key).slice(0, 160)}`);
      return body.result;
    }
    // "No transactions found" is an empty answer, not a failure.
    if (Array.isArray(body?.result) && /no transactions found/i.test(body?.message ?? '')) return [];
    const said = String(body?.result ?? body?.message ?? `status ${res.status}`);
    if (/not supported for this chain|upgrade your api plan/i.test(said)) {
      throw new EtherscanError(said, 'unsupported');
    }
    if (/invalid api key|missing\/invalid api key/i.test(said)) {
      throw new EtherscanError('Etherscan refused the ETHERSCAN_API_KEY in config.env.', 'setup');
    }
    // Per second or per day: "Max calls per sec rate limit reached", "Max daily limit reached".
    if (/rate limit|limit reached/i.test(said)) throw new RateLimited("Etherscan's rate limit was reached. Try again in a moment.");
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

// Per chain: a block number on Arbitrum is no block on Ethereum.
async function blockAt(chainid, ms, closest, key) {
  const k = `${chainid}:${ts(ms)}:${closest}`;
  if (blocks.has(k)) return blocks.get(k);
  const n = Number(await call({ chainid, module: 'block', action: 'getblocknobytime', timestamp: ts(ms), closest }, key));
  if (!Number.isSafeInteger(n)) throw new EtherscanError('Etherscan gave no block for that day.');
  if (ms < Date.now() - 3_600_000) blocks.set(k, n);
  return n;
}

async function transfersBetween(chainid, address, fromMs, toMs, key) {
  const startblock = await blockAt(chainid, fromMs, 'after', key);
  const endblock = await blockAt(chainid, toMs, 'before', key);
  const k = `${chainid}:${lower(address)}:${startblock}:${endblock}`;
  const kept = transfers.get(k);
  if (kept && Date.now() - kept.at < TRANSFERS_MS) return kept.rows;
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await call(
      { chainid, module: 'account', action: 'tokentx', address, startblock, endblock, sort: 'asc', page, offset: PAGE },
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
 * A wallet's transfers on a chain read from its node, of every contract this
 * file knows there, so the trade's other stages and the other trades on that
 * chain are served from the same read. Read a UTC day at a time and kept by
 * day: a day an hour or more past never changes, so it is read once per
 * process; today's is kept two minutes, as Etherscan's answers are. A trade's
 * four stages, searched one after another, share their days.
 */
const nodeDays = new Map();

async function nodeRows(network, address, fromMs, toMs) {
  const contracts = [...new Set([...Object.values(STABLE[network] ?? {}), ...Object.values(ASSET_TOKEN[network] ?? {})].flat())];
  const rows = [];
  for (let day = Math.floor(fromMs / DAY) * DAY; day <= toMs; day += DAY) {
    const k = `${network}:${lower(address)}:${day}`;
    const kept = nodeDays.get(k);
    const settled = day + DAY < Date.now() - 3_600_000;
    let dayRows;
    if (kept && (settled || Date.now() - kept.at < TRANSFERS_MS)) dayRows = kept.rows;
    else {
      dayRows = await nodeTransfersBetween(network, address, day, Math.min(day + DAY - 1000, Date.now() - 60_000), contracts, DECIMALS);
      nodeDays.set(k, { at: Date.now(), rows: dayRows });
    }
    rows.push(...dayRows);
  }
  return rows.filter((r) => Number(r.timeStamp) * 1000 >= fromMs && Number(r.timeStamp) * 1000 <= toMs);
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
  const network = networkOf(wallet);
  const tokens = STABLE[network]?.[t.borrow_currency] ?? [];
  const want = Number(t[r.amount]);
  const w = lower(wallet.address);
  const assetTokens = ASSET_TOKEN[network]?.[assetOf(t)] ?? [];
  const wantQty = r.qty ? Number(t[r.qty]) : null;
  const out = [];
  for (const row of rows) {
    if (!tokens.includes(lower(row.contractAddress))) continue;
    if (r.dir === 'in' ? lower(row.to) !== w : lower(row.from) !== w) continue;
    if (claimed.has(lower(row.hash))) continue;
    if (!withinStageDays(t, stage, Number(row.timeStamp) * 1000)) continue;
    const amount = amountOf(row);
    const off = Math.abs(amount - want);
    if (!(off <= Math.max(0.01, want * TOLERANCE))) continue;
    const byAmount = off <= Math.max(0.01, want * NEAR) ? 0 : off / want;
    const sameTx = rows.filter((x) => x.hash === row.hash);
    let byQty = 0;
    if (!r.qty) {
      // A loan or repayment moves the coin and nothing else back. A
      // transaction that also moves the same coin the other way is a swap
      // within it - USDC to USDC.e on a rollup, 20,001.5 out and 20,001.5 in -
      // and was taken for the repayment that followed it. One that moves the
      // asset is a purchase or a sale - a repayment and a 30,000 purchase are
      // within 0.05% of each other - and ranks after a plain transfer rather
      // than being ruled out, since a loop contract can borrow and swap in one.
      const back = sameTx
        .filter((x) => tokens.includes(lower(x.contractAddress)))
        .filter((x) => (r.dir === 'in' ? lower(x.from) === w : lower(x.to) === w))
        .reduce((sum, x) => sum + amountOf(x), 0);
      if (back >= amount / 2) continue;
      byQty = sameTx.some((x) => assetTokens.includes(lower(x.contractAddress))) ? 1 : 0;
    }
    if (wantQty > 0) {
      // The asset leg of the same transaction, in the stage's direction; none
      // (a native ETH swap) ranks after any that has one.
      const leg = sameTx
        .filter((x) => assetTokens.includes(lower(x.contractAddress)))
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
  const list = candidates(rows, t, stage, wallet, claimed);
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
 * (`{ name, address, network }`); `claimed` is the set of hashes other
 * trades hold, at any stage - a hash is one stage of one trade, and another
 * trade's purchase was offered as this one's repayment when only the same
 * stage was excluded; `own` the trade's own stored hashes, by stage. Answers `{ found: true, hash, at, amount, others }` or
 * `{ found: false, reason, kind }` (`kind` as `EtherscanError`'s, none for a
 * stage not found), never throws: a search that could not be done
 * is a result the card shows.
 */
export async function findStageTx(t, stage, wallet, claimed = new Set(), own = {}) {
  const network = networkOf(wallet);
  const chain = NETWORK_META[network];
  // A chain read from its node needs no Etherscan key.
  const node = nodeFor(network);
  const { key, reason } = etherscanKey();
  if (!key && !node) return { found: false, reason, kind: 'setup' };
  // Not searchable, as an uncovered chain is not: tagged so, Get onchain data
  // counts it as not searched rather than as searched and not found.
  if (!STABLE[network]?.[t.borrow_currency]?.length) {
    return {
      found: false,
      reason: `${t.borrow_currency} has no known contract on ${chain.label} to search for. Paste the hash instead.`,
      kind: 'unsupported',
    };
  }
  const refused = UNSUPPORTED.get(network);
  if (refused && refused.until > Date.now()) return { found: false, reason: refused.reason, kind: 'unsupported' };
  const { from, to } = windowOf(t, stage);
  try {
    const rows = node ? await nodeRows(network, wallet.address, from, to) : await transfersBetween(chain.chainId, wallet.address, from, to, key);
    const best = pick(rows, t, stage, wallet, claimed, own);
    if (best) {
      return { found: true, hash: best.hash, at: new Date(best.at).toISOString(), amount: best.amount, others: best.others };
    }
    const r = RULE[stage];
    const span = `between ${fmtDate(new Date(from).toISOString().slice(0, 10))} and ${fmtDate(new Date(to).toISOString().slice(0, 10))}`;
    return {
      found: false,
      reason:
        `No ${t.borrow_currency} transfer of about ${n2(Number(t[r.amount]))} ` +
        `${r.dir === 'in' ? 'into' : 'out of'} ${wallet.name}${network === 'ethereum' ? '' : ` on ${chain.label}`} ${span} ` +
        `fits this ${r.noun}. Paste its hash instead.`,
    };
  } catch (err) {
    const known = err instanceof EtherscanError || err instanceof NodeError;
    if (known && err.kind === 'unsupported') {
      const reason = unsupportedReason(network, err instanceof NodeError ? `${redact(err.message, key)}.` : null);
      UNSUPPORTED.set(network, { until: Date.now() + UNSUPPORTED_MS, reason });
      return { found: false, reason, kind: 'unsupported' };
    }
    return {
      found: false,
      reason: known ? redact(err.message, key) : 'The search failed. Try again.',
      kind: known ? err.kind : 'busy',
    };
  }
}

/* ------------------------------------------------------------------ audit */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * A stored hash's transaction, for scripts/audit-hashes.mjs: `{ ok, at,
 * transfers }` with its ERC-20 transfers as Etherscan's rows, null when the
 * chain has no such transaction, or `{ reason }` when it could not be asked.
 * From Etherscan's proxy calls, or the chain's node where one is set.
 */
export async function txTransfers(network, hash) {
  const chain = NETWORK_META[network];
  let receipt;
  try {
    if (nodeFor(network)) {
      receipt = await nodeReceipt(network, hash);
    } else {
      const { key, reason } = etherscanKey();
      if (!key) return { reason };
      const r = await call({ chainid: chain.chainId, module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hash }, key);
      if (!r) return null;
      const block = await call(
        { chainid: chain.chainId, module: 'proxy', action: 'eth_getBlockByNumber', tag: r.blockNumber, boolean: 'false' },
        key,
      );
      receipt = { ok: r.status === '0x1', at: Number(BigInt(block.timestamp)) * 1000, logs: r.logs ?? [] };
    }
  } catch (err) {
    if (err?.kind === 'unsupported') return { reason: unsupportedReason(network, err instanceof NodeError ? `${err.message}.` : null) };
    return { reason: err instanceof EtherscanError || err instanceof NodeError ? err.message : 'It could not be fetched.' };
  }
  if (!receipt) return null;
  const transfers = receipt.logs
    .filter((l) => l.topics?.[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({
      hash: lower(hash),
      timeStamp: String(Math.floor(receipt.at / 1000)),
      contractAddress: lower(l.address),
      from: `0x${String(l.topics[1]).slice(26).toLowerCase()}`,
      to: `0x${String(l.topics[2]).slice(26).toLowerCase()}`,
      value: BigInt(l.data === '0x' ? 0 : l.data).toString(),
      tokenDecimal: String(DECIMALS[lower(l.address)] ?? 18),
    }))
    .filter((r) => DECIMALS[r.contractAddress] !== undefined);
  return { ok: receipt.ok, at: receipt.at, transfers };
}

/**
 * Whether a stored hash is the stage it is stored as, by the rules a search
 * goes by: `{ verdict: 'ok' | 'check' | 'wrong' | 'unchecked', notes }`, on
 * this trade alone; a hash other trades hold too is weighed across them by
 * the script. `tx` is `txTransfers`' answer. Pure.
 */
export function auditStage(t, stage, wallet, tx) {
  const r = RULE[stage];
  const network = networkOf(wallet);
  const chain = NETWORK_META[network].label;
  const coin = t.borrow_currency;
  const w = lower(wallet.address);
  const notes = [];
  let verdict = 'ok';
  const flag = (level, note) => {
    notes.push(note);
    if (level === 'wrong' || verdict === 'ok') verdict = level;
  };
  // A stage blanked since: the hash stands for nothing the trade records.
  if (!stageRecorded(t, stage)) return { verdict: 'wrong', notes: [`the ${r.noun} is no longer recorded on the trade`] };
  const tokens = STABLE[network]?.[coin] ?? [];
  // No contract known for the coin there: nothing to judge it by, which is
  // not the same as wrong - a pasted EURC hash on Arbitrum read "moves no EURC".
  if (!tokens.length) return { verdict: 'unchecked', notes: [`${coin} has no known contract on ${chain}, so it cannot be checked`] };
  if (!tx.ok) flag('wrong', 'the transaction failed on chain');
  const want = Number(t[r.amount]);
  const moving = tx.transfers.filter(
    (x) => tokens.includes(x.contractAddress) && (r.dir === 'in' ? x.to === w : x.from === w),
  );
  const best = moving.map((x) => ({ x, amount: amountOf(x) })).sort((a, b) => Math.abs(a.amount - want) - Math.abs(b.amount - want))[0];
  if (!best) {
    flag('wrong', `it moves no ${coin} ${r.dir === 'in' ? 'into' : 'out of'} ${wallet.name} on ${chain}`);
  } else {
    const off = Math.abs(best.amount - want);
    if (off > Math.max(0.01, want * TOLERANCE)) {
      flag('wrong', `it moves ${n2(best.amount)} ${coin}; the ${r.noun} is ${n2(want)}`);
    } else if (off > Math.max(0.01, want * NEAR)) {
      flag('check', `it moves ${n2(best.amount)} ${coin}; the ${r.noun} is ${n2(want)}`);
    }
  }
  const assetTokens = ASSET_TOKEN[network]?.[assetOf(t)] ?? [];
  if (!r.qty) {
    const back = tx.transfers
      .filter((x) => tokens.includes(x.contractAddress) && (r.dir === 'in' ? x.from === w : x.to === w))
      .reduce((sum, x) => sum + amountOf(x), 0);
    if (best && back >= best.amount / 2) flag('wrong', `a swap within ${coin}, not a ${r.noun}`);
    else if (tx.transfers.some((x) => assetTokens.includes(x.contractAddress))) {
      flag('check', `it also moves the asset: a purchase or sale, not a plain ${r.noun}?`);
    }
  } else if (Number(t[r.qty]) > 0) {
    const leg = tx.transfers
      .filter((x) => assetTokens.includes(x.contractAddress) && (r.qtyDir === 'in' ? x.to === w : x.from === w))
      .reduce((sum, x) => sum + amountOf(x), 0);
    const wantQty = Number(t[r.qty]);
    // Native ETH, or an intent order settled by a solver (CoW Swap's ETH flow:
    // the ETH left the wallet in an earlier transaction), moves no asset token
    // from the wallet here, so its side of the swap cannot be read.
    if (!leg) flag('check', `no asset token moves ${r.qtyDir === 'in' ? 'into' : 'out of'} the wallet in it: native ETH, or an intent order (CoW Swap) settled for it?`);
    else if (Math.abs(leg - wantQty) / wantQty > 0.005) flag('check', `it moves ${leg} of the asset; the ${r.noun} says ${wantQty}`);
  }
  if (!withinStageDays(t, stage, tx.at)) {
    flag('wrong', `it is dated ${fmtDate(new Date(tx.at).toISOString().slice(0, 10))}; the ${r.noun} says ${fmtDate(t[r.date])}`);
  }
  return { verdict, notes };
}
