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
import { derive, summarize, unrealisedUsd } from './lib/calc.js';
import { ethPrice, ethStatus } from './eth.js';
import { alertPollMs } from './alerts.js';
import { n4, usd, signedUsd, pct1, pct2, padLeft, padRight, escHtml, MISSING } from './format.js';

/** Telegram refuses a message over 4096 characters, so stop well short of it. */
const MAX_CHARS = 3900;

/* ------------------------------------------------------------------- price */

/** "12 minutes" - only ever said about a figure old enough to be worth doubting. */
function ageWords(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function priceText(quote) {
  if (!quote || !Number.isFinite(quote.price)) {
    const why = ethStatus().lastError || 'No price has come back yet.';
    return `Could not get the ETH price.\n${escHtml(why)}`;
  }

  const lines = [`<b>ETH ${escHtml(usd(quote.price))}</b>`];

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

  return lines.join('\n');
}

/* ----------------------------------------------------------------- holding */

/**
 * Open positions, with the alert on each where there is one.
 *
 * The WHERE clause is the one the alert sweep uses, spelled out rather than
 * asking whether the ETH has been sold: a purchase can be undone as well as
 * followed by a sale, and both take a trade out of HOLDING. Both halves name
 * all three columns, because `stages()` does, and a bare `sell_date` is a row
 * the page still calls HOLDING. Only an armed alert earns a bell; a fired one
 * is not something still being waited for.
 *
 * Oldest first, which is the opposite of the table on the page. A chat report
 * is read downwards from the position you have held longest.
 */
const selectHolding = () =>
  prepare(`
    SELECT t.*, a.goal_price AS alert_goal
      FROM trades t
      LEFT JOIN alerts a ON a.trade_id = t.id AND a.status = 'armed'
     WHERE t.buy_date IS NOT NULL
       AND t.buy_amount IS NOT NULL
       AND t.buy_eth IS NOT NULL
       AND (t.sell_date IS NULL OR t.sell_amount IS NULL OR t.sell_eth IS NULL)
     ORDER BY t.borrow_date, t.id
  `);

export function holdingText(rows, price) {
  if (!rows.length) return 'Nothing is being held right now.';

  const hasPrice = Number.isFinite(price);
  let eth = 0;
  let gain = 0;
  let gainKnown = 0;
  let unpriced = 0;

  const cells = rows.map((t) => {
    const d = derive(t);
    const held = Number.isFinite(d.ethHeld) ? d.ethHeld : 0;
    eth += held;

    const g = hasPrice ? unrealisedUsd(d, price) : null;
    if (g === null) unpriced += 1;
    else {
      gain += g;
      gainKnown += 1;
    }

    return {
      id: `#${t.id}`,
      eth: n4(held),
      // A trade whose exchange rate has not been fetched has no dollar price
      // per ETH, and a dash is the honest answer rather than a euro figure
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
  const wEth = w('eth');
  const wPaid = w('paid');
  const wGain = w('gain');
  const wDays = w('days');

  const body = cells.map(
    (c) =>
      // "paid" sits at a fixed column with the figure padded after it, so the
      // dollar amounts line up under each other and a missing one is a dash in
      // the same place rather than a word adrift.
      `${padRight(c.id, wId)}  ${padLeft(c.eth, wEth)} ETH  paid ${padLeft(c.paid, wPaid)}  ` +
      // The bell goes last on purpose: an emoji is one character but takes
      // about two cells, so any column after it would sit crooked.
      `${padLeft(c.gain, wGain)}  ${padLeft(c.days, wDays)}${c.bell ? `  ${c.bell}` : ''}`,
  );

  // The tags are ours; only the values are escaped, and escaped where they are
  // interpolated rather than by a pass over the finished line, which would have
  // to be taught to leave the tags alone.
  const worth = hasPrice ? ` · ${escHtml(usd(eth * price))} at ${escHtml(usd(price))}` : '';
  const head = [
    `<b>Holding ${rows.length} trade${rows.length === 1 ? '' : 's'}</b> · ${escHtml(n4(eth))} ETH${worth}`,
  ];

  if (gainKnown > 0) {
    // Never a total over a subset without saying so. A gain missing a term is
    // not a smaller gain, it is a wrong one.
    const caveat = unpriced
      ? ` (${unpriced} without an exchange rate ${unpriced === 1 ? 'is' : 'are'} not counted)`
      : '';
    head.push(`Unrealised ${escHtml(signedUsd(gain))} after interest${caveat}`);
  } else if (unpriced) {
    head.push('No exchange rate yet, so the gain is not known in dollars.');
  }

  return `${head.join('\n')}\n\n<pre>${escHtml(fit(body))}</pre>`;
}

/** Trim trailing rows rather than let Telegram refuse the whole message. */
function fit(lines) {
  let out = lines.join('\n');
  if (out.length <= MAX_CHARS) return out;
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_CHARS - 40) break;
    kept.push(line);
    size += line.length + 1;
  }
  return `${kept.join('\n')}\n… and ${lines.length - kept.length} more`;
}

/* ----------------------------------------------------------------- summary */

/**
 * The four figures the page shows above the table, from the same function the
 * page uses, so the two cannot drift apart.
 */
export function summaryText(s) {
  const rows = [
    [
      'Realized net gain',
      // Not "$0.00" when nothing has a rate yet: those trades made a real gain
      // that is simply not known in dollars, the distinction the tile makes too.
      Number.isFinite(s.netGain)
        ? signedUsd(s.netGain)
        : s.missingFx
          ? 'not known in dollars yet'
          : MISSING,
    ],
    ['Blended annualized', pct2(s.avgPct)],
    ['Closed trades', String(s.closedCount)],
    [
      'Open positions',
      s.openCount
        ? `${s.openCount} (${usd(s.deployed)})${s.deployedMissingFx ? ' \u2014 some without a rate' : ''}`
        : '0',
    ],
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

export function helpText() {
  return [
    '<b>Aave Loop</b>',
    '',
    '/price - ETH now, with 24h, 7d and 30d change',
    '/holding - open positions, one line each',
    '/summary - realized gain, annualized, closed and open',
    '/watch - send the price every 20 minutes',
    '/unwatch - stop the price updates',
  ].join('\n');
}

/* ---------------------------------------------------------------- wrappers */

const CLOSED = 'The ledger is not open.';

/** Someone is waiting on this one, so a minute old is fresh enough. */
export async function priceMessage() {
  return priceText(await ethPrice());
}

/**
 * The same report on the timer, where nobody is waiting. Five minutes is what
 * the alert sweep settles for too, so a report landing near a sweep costs no
 * call at all.
 */
export async function watchMessage() {
  return priceText(await ethPrice({ maxAgeMs: 300_000 }));
}

export async function holdingMessage() {
  if (!db.open) return CLOSED;
  let rows;
  try {
    rows = selectHolding().all();
  } catch (err) {
    // A refused statement is not a reason to say nothing back. The command was
    // asked in a chat, and silence there reads as a broken bot.
    console.error('Could not read the open positions:', err.message);
    return 'Could not read the ledger just now. Try again in a moment.';
  }
  // Asked for even with nothing held, so the answer names the price it used.
  const quote = await ethPrice();
  return holdingText(rows, quote?.price ?? null);
}

/**
 * Named for the message rather than the figures, because `lib/calc.js` already
 * exports a `summaryReport` that means something else.
 */
export function summaryMessage() {
  if (!db.open) return CLOSED;
  try {
    return summaryText(summarize(prepare('SELECT * FROM trades').all()));
  } catch (err) {
    console.error('Could not read the ledger for a summary:', err.message);
    return 'Could not read the ledger just now. Try again in a moment.';
  }
}
