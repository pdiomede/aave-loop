/**
 * What the bot says when it is asked.
 *
 * The builders are pure functions of data that is handed to them, and the
 * fetching lives in the thin wrappers underneath. That split is the same one
 * that lets the alert window in the browser render the exact message an alert
 * will send: a message you can print with `node -e` is a message you can check
 * before anyone receives it.
 *
 * Every builder returns HTML and is sent with `parse_mode: 'HTML'`, so every
 * value that reaches the text goes through `escHtml` first.
 */
import { db, prepare } from './db.js';
import {
  derive,
  derivedOn,
  summarize,
  estimatedGainUsd,
  isUsdPegged,
  todayISO,
  cents,
  ethHeldNow,
  PLATFORM_META,
  ASSETS,
  ASSET_META,
  MARKETS,
  assetOf,
  marketOf,
  priceFor,
} from './lib/calc.js';
import { marketPrices, priceStatus } from './prices.js';
import { resolveRate } from './fx.js';
import { alertPollMs } from './alerts.js';
import { units, usd, signedUsd, pct1, pct2, padLeft, padRight, escHtml, MISSING } from './format.js';

/**
 * Telegram refuses a message over 4096 characters, counted after its HTML is
 * parsed - tags gone, entities one character each. The table is trimmed to
 * what is left once the lines above it are counted, with room to spare.
 */
const TELEGRAM_MAX = 4096;
const MARGIN = 100;

/** A message's length as Telegram counts it. */
const visibleLength = (html) => html.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp|quot|#\d+);/g, '_').length;

/* ------------------------------------------------------------------- price */

/** "12 minutes" - only ever said about a figure old enough to be worth doubting. */
function ageWords(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Every market's price, ETH then BTC, a block each. `quotes` is `{ ETH, BTC }`
 * as `marketPrices` answers it. A market with no price is named once at the
 * end with the reason, rather than leaving the other's figure unsaid.
 */
export function priceText(quotes) {
  const blocks = [];
  const missing = [];
  for (const market of MARKETS) {
    const quote = quotes?.[market];
    if (!quote || !Number.isFinite(quote.price)) {
      missing.push(market);
      continue;
    }

    const lines = [`<b>${market} ${escHtml(usd(quote.price))}</b>`];

    // Only the windows that came back. CoinGecko leaves one null now and then,
    // and a row of dashes says less than a shorter row.
    const windows = [
      ['24h', quote.change24h],
      ['7d', quote.change7d],
      ['30d', quote.change30d],
    ].filter(([, v]) => Number.isFinite(v));

    if (windows.length) {
      lines.push(windows.map(([label, v]) => `${label} ${escHtml(pct1(v))}`).join('   '));
    }

    // The same threshold the alert window uses to call a price stale. Below it
    // nothing is said, because the age of a fresh figure is not news.
    if (Number.isFinite(quote.ageMs) && quote.ageMs > alertPollMs) {
      lines.push(`<i>Last fetched ${escHtml(ageWords(quote.ageMs))} ago.</i>`);
    }

    blocks.push(lines.join('\n'));
  }

  if (missing.length) {
    const why = priceStatus().lastError || 'No price has come back yet.';
    blocks.push(`Could not get the ${missing.join(' or ')} price.\n${escHtml(why)}`);
  }

  return blocks.join('\n\n');
}

/**
 * What the rows hold of each asset, in `ASSETS` order: `[{ asset, ticker,
 * market, total }]`, assets with nothing held left out.
 *
 * Each row's quantity is added as it prints, to its asset's own decimals, so a
 * total is the sum of the rows under it: 1.23455 and 2.23455 ETH print 1.2346
 * and 2.2346, and summed raw they were headed 3.4691. Kept per asset, because
 * ETH and cbBTC added together are a figure in no coin.
 */
function heldTotals(rows) {
  const sums = new Map();
  for (const t of rows) {
    const asset = assetOf(t);
    const { dp } = ASSET_META[asset];
    const held = ethHeldNow(derive(t, derivedOn(t)));
    // In units of the last printed place: ten-thousandths of an ETH,
    // hundred-millionths (satoshis) of a cbBTC.
    const printed = Math.round(Number(units(held, t).replace(/,/g, '')) * 10 ** dp);
    sums.set(asset, (sums.get(asset) ?? 0) + printed);
  }
  return ASSETS.filter((a) => sums.get(a) > 0).map((asset) => {
    const { ticker, market, dp } = ASSET_META[asset];
    return { asset, ticker, market, total: sums.get(asset) / 10 ** dp };
  });
}

/** "3.4691 ETH", a total from `heldTotals`, to its asset's decimals. */
const totalText = (h) => `${units(h.total, { asset: h.asset })} ${h.ticker}`;

/* ----------------------------------------------------------------- holding */

/**
 * The trades still holding ETH or cbBTC, with the alert on each where there is
 * one.
 *
 * Not every open position: a trade whose ETH is all sold but whose loan is not
 * repaid is open - /summary and the page count it - and holds no ETH, so it is
 * not here, and /help says so rather than calling this the open positions. A
 * trade sold in part holds what it kept until it is repaid, and is here.
 *
 * The query reads every trade that could hold ETH - bought, not repaid, with
 * all three purchase columns as `stages()` asks - and `ethHeldNow` decides
 * which do, so a partial sale is judged as its card judges it. Only an armed
 * alert earns a bell; a fired one is not something still being waited for.
 *
 * Oldest first, which is the opposite of the table on the page. A chat report
 * is read downwards from the position you have held longest.
 */
// Bought and not repaid: every trade that can hold ETH. Which of them do is
// `derive`'s answer (`ethHeldNow`), not SQL's - HOLDING, the alerts' test,
// counts a partial sale as holding nothing, and the bot left those out.
const selectHolding = () =>
  prepare(`
    SELECT t.*, a.goal_price AS alert_goal
      FROM trades t
      LEFT JOIN alerts a ON a.trade_id = t.id AND a.status = 'armed'
     WHERE t.buy_date IS NOT NULL AND t.buy_amount IS NOT NULL AND t.buy_eth IS NOT NULL
       AND (t.repay_date IS NULL OR t.repay_amount IS NULL OR t.repay_amount <= 0)
     ORDER BY t.borrow_date, t.id
  `);

const heldRows = () => selectHolding().all().filter((t) => ethHeldNow(derive(t, derivedOn(t))) > 0);

/**
 * `prices` is `{ ETH, BTC }` in dollars, and each row is valued at its own
 * asset's market (`priceFor`): a cbBTC position at BTC, never at ETH. `ages` is
 * how old each of those prices is. `fxNow` is today's rate per borrowed coin,
 * the one the page's Open positions tile uses, so a euro position reads the
 * same figure in the chat as on the page (see `estimatedGainUsd`).
 */
export function holdingText(rows, prices = {}, fxNow = {}, { ages = {} } = {}) {
  if (!rows.length) return 'Nothing is being held right now.';
  const priceOf = (t) => priceFor(t, prices);
  // The markets the rows are valued at, in `MARKETS` order.
  const markets = MARKETS.filter((m) => rows.some((t) => marketOf(t) === m));
  // In whole cents as each row prints it (see `cents` in lib/calc.js), so the
  // Unrealised total is the sum of the gains listed under it. Summed raw, three
  // rows of +$96.71 sat under a total of +$290.14.
  let gain = 0;
  let gainKnown = 0;
  // Two different absences, kept apart so each is named for what it is: a row
  // whose market has no price, and a row whose exchange rate is not known.
  let noRate = 0;
  const noPrice = new Map();
  let gassed = 0;
  const marked = new Set();
  // What the euro's move since each purchase did to the total, for the same
  // reason the alert line names it: "paid" is at the purchase's rate.
  let moved = 0;
  let movedKnown = false;
  // A marked trade whose purchase rate is not known has a move nobody can
  // state. Then the move is not given at all: "(-$1,200.00 of it from the
  // move)" under a total of two euro trades named one trade's move as the
  // whole of it.
  let moveGap = false;

  const cells = rows.map((t) => {
    const d = derive(t, derivedOn(t));
    const held = ethHeldNow(d);

    const price = priceOf(t);
    const g = price === null ? null : estimatedGainUsd(t, d, price, fxNow);
    if (g === null) {
      if (price === null) noPrice.set(marketOf(t), (noPrice.get(marketOf(t)) ?? 0) + 1);
      else noRate += 1;
    } else {
      gain += cents(g);
      gainKnown += 1;
      if (Number.isFinite(d.feesUsd)) gassed += 1;
      const today = fxNow?.[t.borrow_currency];
      if (!d.isUsdPegged && Number.isFinite(today)) {
        marked.add(t.borrow_currency);
        // In cents as each alert prints it, which is also how each gain took
        // it (`markedUsd`): summed raw, two moves printed -$1,207.24 and
        // -$1,207.66 were called -$2,414.91. A partial sale's gain is marked
        // otherwise, so no move is claimed for it.
        if (Number.isFinite(t.buy_fx) && Number.isFinite(d.ethHeld)) {
          moved += cents(-t.buy_amount * (today - t.buy_fx));
          movedKnown = true;
        } else moveGap = true;
      }
    }

    return {
      id: `#${t.id}`,
      // Where the trade runs. A trade from before it was asked for has none,
      // and a dash says so rather than calling it Aave.
      platform: PLATFORM_META[t.platform]?.label ?? MISSING,
      // To the asset's own decimals, its ticker in a column of its own.
      qty: units(held, t),
      ticker: ASSET_META[assetOf(t)].ticker,
      // A trade whose exchange rate has not been fetched has no dollar price
      // per unit, and a dash is the honest answer rather than a euro figure
      // wearing a dollar sign.
      paid: Number.isFinite(d.buyPriceUsd) ? usd(d.buyPriceUsd) : MISSING,
      gain: g === null ? MISSING : signedUsd(g),
      days: `${Number.isFinite(d.elapsedDays) ? d.elapsedDays : 0}d`,
      bell: Number.isFinite(t.alert_goal) ? `\u{1F514} ${usd(t.alert_goal)}` : '',
    };
  });

  // Widths from the data, so a ledger of small numbers is not padded out to fit
  // a figure nobody has.
  const w = (key) => Math.max(...cells.map((c) => c[key].length));
  const wId = w('id');
  const wPlatform = w('platform');
  const wQty = w('qty');
  const wTicker = w('ticker');
  const wPaid = w('paid');
  const wGain = w('gain');
  const wDays = w('days');

  const body = cells.map(
    (c) =>
      // "paid" sits at a fixed column with the figure padded after it, so the
      // dollar amounts line up under each other and a missing one is a dash in
      // the same place rather than a word adrift.
      // On a ledger of ETH alone the ticker column is "ETH" every time, and
      // the line reads exactly as it did before cbBTC.
      `${padRight(c.id, wId)}  ${padRight(c.platform, wPlatform)}  ${padLeft(c.qty, wQty)} ${padRight(c.ticker, wTicker)}  paid ${padLeft(c.paid, wPaid)}  ` +
      // The bell goes last on purpose: an emoji is one character but takes
      // about two cells, so any column after it would sit crooked.
      `${padLeft(c.gain, wGain)}  ${padLeft(c.days, wDays)}${c.bell ? `  ${c.bell}` : ''}`,
  );

  // The tags are ours; only the values are escaped, and escaped where they are
  // interpolated rather than by a pass over the finished line, which would have
  // to be taught to leave the tags alone.
  // One total per asset held, each at its own market's price. A ledger of one
  // asset keeps it on the title line, as it always read; two take a line each,
  // since a single line carrying both ran past a phone's width.
  const totals = heldTotals(rows).map((h) => {
    const p = prices?.[h.market];
    const worth = Number.isFinite(p) ? ` · ${escHtml(usd(h.total * p))} at ${escHtml(usd(p))}` : '';
    return `${escHtml(totalText(h))}${worth}`;
  });
  const title = `<b>Holding ${rows.length} trade${rows.length === 1 ? '' : 's'}</b>`;
  const head = totals.length === 1 ? [`${title} · ${totals[0]}`] : [title, ...totals];
  // A price the service could not refresh is the cached one, possibly hours
  // old, and every figure below is worked out at it. /price said so; this
  // valued the positions at it in silence. Same threshold and words, naming
  // the market when there are two.
  for (const m of markets) {
    const age = ages?.[m];
    if (!Number.isFinite(prices?.[m]) || !Number.isFinite(age) || age <= alertPollMs) continue;
    const which = markets.length > 1 ? `${m} price` : 'price';
    head.push(`<i>At the ${which} last fetched ${escHtml(ageWords(age))} ago.</i>`);
  }

  const unpricedCount = [...noPrice.values()].reduce((a, b) => a + b, 0);
  if (gainKnown > 0) {
    // Never a total over a subset without saying so. A gain missing a term is
    // not a smaller gain, it is a wrong one. Each absence named for what it is.
    const left = [
      ...(noRate ? [`${noRate} without an exchange rate`] : []),
      ...[...noPrice].map(([m, n]) => `${n} without a ${m} price`),
    ];
    const n = noRate + unpricedCount;
    const caveat = left.length ? ` (${left.join(', ')} ${n === 1 ? 'is' : 'are'} not counted)` : '';
    // The estimate takes the fees already paid off too, and a figure has to
    // be described by what was actually taken from it: "after interest" alone
    // under a total that is also after fees named one deduction and hid one.
    // "Fees", not "gas": the swaps' figure carries the DEX's own fee as well.
    const less = gassed ? 'interest and fees' : 'interest';
    // A euro loan is marked at today's rate rather than the one it was bought
    // at, and a figure has to say how it was arrived at.
    const at = [...marked].map((c) => `${c} at ${fxNow[c].toFixed(4)}`).join(', ');
    const move = movedKnown && !moveGap ? ` (${signedUsd(moved / 100)} of it from the move since purchase)` : '';
    head.push(
      `Unrealised ${escHtml(signedUsd(gain / 100))} after ${less}${caveat}${at ? `, ${escHtml(`${at} today${move}`)}` : ''}`,
    );
  } else if (noRate || unpricedCount) {
    // Two different absences. With no ETH price every ETH row is unpriced, a
    // dollar coin included, and blaming the exchange rate sat above a table
    // printing that trade's purchase price in dollars.
    head.push(
      unpricedCount
        ? `No ${[...noPrice.keys()].join(' or ')} price right now, so the gain is not known.`
        : 'No exchange rate yet, so the gain is not known in dollars.',
    );
  }

  // The table gets what the lines above it leave. It used to have 3,900 of
  // its own whatever they took, and a long ledger at an old price, its
  // stale-price and move lines included, came to 4,102 and got no reply.
  const top = `${head.join('\n')}\n\n`;
  return `${top}<pre>${escHtml(fit(body, TELEGRAM_MAX - visibleLength(top) - MARGIN))}</pre>`;
}

/** Trim trailing rows rather than let Telegram refuse the whole message. */
function fit(lines, budget) {
  let out = lines.join('\n');
  if (out.length <= budget) return out;
  const kept = [];
  let size = 0;
  for (const line of lines) {
    // Room left for the "... and N more" line.
    if (size + line.length + 1 > budget - 40) break;
    kept.push(line);
    size += line.length + 1;
  }
  return `${kept.join('\n')}\n… and ${lines.length - kept.length} more`;
}

/* ----------------------------------------------------------------- summary */

/**
 * The four figures the page shows above the table, from the same function the
 * page uses, so the two cannot drift apart - and under them what is held of
 * each asset, from `holdingTotals`, valued at its own market's price.
 */
export function summaryText(s, held = []) {
  const rows = [
    [
      'Realized net gain',
      // Not "$0.00" when nothing has a rate yet: those trades made a real gain
      // that is simply not known in dollars, the distinction the tile makes too.
      // Keyed on closed trades without a dollar result, as on the page:
      // `missingFx` counts open trades too, so it said "not known" with
      // nothing closed and said nothing under a total that was short.
      Number.isFinite(s.netGain)
        ? `${signedUsd(s.netGain)}${s.closedCount > s.valuedCount ? ' (some without a rate)' : ''}`
        : s.closedCount > s.valuedCount
          ? 'not known in dollars yet'
          : MISSING,
    ],
    ['Blended annualized', pct2(s.avgPct)],
    ['Closed trades', String(s.closedCount)],
    [
      'Open positions',
      s.openCount
        ? `${s.openCount}${Number.isFinite(s.deployed) ? ` (${usd(s.deployed)})` : ''}${
            s.deployedMissingFx ? ' (some without a rate)' : ''
          }`
        : '0',
    ],
    // ETH and cbBTC held now, a line each, totalled as /holding totals them.
    // Only an asset something is held of: a "cbBTC held: 0" line on an ETH
    // ledger would say nothing.
    ...held.map((h) => [
      `${h.ticker} held`,
      `${totalText(h)}${Number.isFinite(h.price) ? ` (${usd(h.total * h.price)})` : ''}`,
    ]),
  ];

  // Inside a `pre` for the same reason the holdings table is: Telegram draws
  // message text proportionally, so spaces between a label and a figure line
  // nothing up. Width from the longest label, so nothing is padded to fit a
  // column that is not there.
  const w = Math.max(...rows.map(([label]) => label.length)) + 2;
  const body = rows.map(([label, value]) => `${padRight(`${label}:`, w)}${value}`).join('\n');

  return `<b>Summary</b>\n<pre>${escHtml(body)}</pre>`;
}

/* -------------------------------------------------------------------- help */

/**
 * `every` is the interval the bot actually sends `/watch` at, in words, which
 * `MYAAVE_WATCH_MS` can change; this said "every 20 minutes" regardless.
 */
export function helpText(every = '20 minutes') {
  return [
    '<b>ETH Roundtrip</b>',
    '',
    '/price - ETH and BTC now, with 24h, 7d and 30d change',
    '/holding - trades still holding ETH or cbBTC, one line each',
    '/summary - realized gain, annualized, closed, open and held',
    `/watch - send the ETH and BTC prices every ${every}`,
    '/unwatch - stop the price updates',
  ].join('\n');
}

/* ---------------------------------------------------------------- wrappers */

const CLOSED = 'The ledger is not open.';

/** Someone is waiting on this one, so a minute old is fresh enough. */
export async function priceMessage() {
  return priceText(await marketPrices());
}

/**
 * The same report on the timer, where nobody is waiting. Five minutes is what
 * the alert sweep settles for too, so a report landing near a sweep costs no
 * call at all.
 */
/**
 * How many trades still hold ETH or cbBTC, by the same test /holding uses.
 * /watch reports only while this is above zero: the prices every twenty
 * minutes is for deciding when to sell, and with nothing held there is
 * nothing to decide. Null when the ledger cannot be read, so a caller can
 * tell "none" from "unknown".
 */
export function holdingCount() {
  if (!db.open) return null;
  try {
    return heldRows().length;
  } catch (err) {
    console.error('Could not count the open positions:', err.message);
    return null;
  }
}

export async function watchMessage() {
  return priceText(await marketPrices({ maxAgeMs: 300_000 }));
}

export async function holdingMessage() {
  if (!db.open) return CLOSED;
  let rows;
  try {
    rows = heldRows();
  } catch (err) {
    // A refused statement is not a reason to say nothing back. The command was
    // asked in a chat, and silence there reads as a broken bot.
    console.error('Could not read the open positions:', err.message);
    return 'Could not read the ledger just now. Try again in a moment.';
  }
  // Only the markets held: an ETH-only ledger has no reason to wait on BTC.
  const markets = [...new Set(rows.map(marketOf))];
  const quotes = markets.length ? await marketPrices({ markets }) : {};
  const prices = Object.fromEntries(MARKETS.map((m) => [m, quotes[m]?.price ?? null]));
  const ages = Object.fromEntries(MARKETS.map((m) => [m, quotes[m]?.ageMs ?? null]));
  // Not asked for without a price: every figure is a dash then, and today's
  // rate is provisional until the ECB publishes, so asking goes to the network
  // and held the reply back for nothing.
  const priced = markets.some((m) => Number.isFinite(prices[m]));
  return holdingText(rows, prices, priced ? await ratesToday(rows) : {}, { ages });
}

/**
 * Today's rate for every coin the rows were borrowed in that is not a dollar,
 * from the same cached ECB lookup the page asks `/api/fx/rate` for. A coin
 * whose rate cannot be had is left out, and its trades fall back to their
 * stored rates.
 */
async function ratesToday(rows) {
  const coins = [...new Set(rows.map((t) => t.borrow_currency).filter((c) => !isUsdPegged(c)))];
  const today = todayISO();
  const out = {};
  for (const c of coins) {
    try {
      const hit = await resolveRate(c, today);
      if (Number.isFinite(hit?.rate) && hit.rate > 0) out[c] = hit.rate;
    } catch {
      // `resolveRate` answers null rather than throwing; this is belt and braces
      // so a chat command is never left without a reply.
    }
  }
  return out;
}

/**
 * Named for the message rather than the figures, because `lib/calc.js` already
 * exports a `summaryReport` that means something else.
 */
export async function summaryMessage() {
  if (!db.open) return CLOSED;
  let summary;
  let held;
  try {
    summary = summarize(prepare('SELECT * FROM trades').all());
    held = heldTotals(heldRows());
  } catch (err) {
    console.error('Could not read the ledger for a summary:', err.message);
    return 'Could not read the ledger just now. Try again in a moment.';
  }
  // The price of each market something is held in, to value it; a market the
  // service cannot price leaves the quantity standing alone.
  const markets = [...new Set(held.map((h) => h.market))];
  const quotes = markets.length ? await marketPrices({ markets }) : {};
  return summaryText(
    summary,
    held.map((h) => ({ ...h, price: quotes[h.market]?.price ?? null })),
  );
}
