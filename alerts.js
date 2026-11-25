/**
 * Price alerts on a trade whose ETH - or cbBTC - is still held.
 *
 * A trade in HOLDING has one number that matters and it is not in the ledger:
 * where its market is trading. An alert names the price you are waiting for,
 * and a timer here watches for it so nobody has to watch a chart. The market is
 * the trade's (`marketOf`): ETH for ETH, BTC for cbBTC, so a cbBTC goal is a
 * BTC price and is judged against BTC alone.
 *
 * Two things in here are load bearing and neither is obvious.
 *
 * The first is that the alert is claimed before the message is sent, with a
 * conditional UPDATE, and not after. `runETHRoundTrip.sh` will happily start a
 * second copy of the app on the next free port pointed at this same database
 * file, and both copies poll. Only one of them can win a
 * `WHERE status = 'armed'`, so only one of them sends. Sent-then-marked would
 * put the message in the group twice, and a message cannot be unsent.
 *
 * The second is that armed alerts are found by joining the trade and asking
 * whether it is still holding ETH. Selling it, or undoing the purchase, ends
 * the reason for the alert, and `closeUnwatched` then closes it for good.
 *
 * The third is that an alert is kept after it fires. A trade can therefore have
 * many, so every statement here keys on the alert's own id and never on the
 * trade - a statement that says `WHERE trade_id` would reach the history as
 * well as the live one. The rule that a trade has at most one *armed* alert is
 * a partial unique index in db.js.
 */
import { db, prepare } from './db.js';
import {
  derive,
  derivedOn,
  estimatedGainUsd,
  estimatedGainPct,
  estimateRate,
  asPrinted,
  isUsdPegged,
  todayISO,
  intervalMs,
  marketOf,
  ASSETS,
  ASSET_META,
} from './lib/calc.js';
import { resolveRate, cachedRate } from './fx.js';
import { marketPrices } from './prices.js';
import { sendTelegramMessage } from './telegram.js';
import { telegramConfig } from './config.js';
import { n2, qty, fmtDate, signedUsd, signedPct2 } from './format.js';
import { setting } from './env.js';

/**
 * Fifteen minutes. The price is checked on a schedule rather than watched, and
 * a goal price is not a limit order: being told within a quarter of an hour is
 * the point, and asking a free service four times an hour keeps us a polite
 * distance from its rate limit.
 */
const POLL_MS = intervalMs(setting('ALERT_POLL_MS'), 900_000);

/** A first look shortly after boot, so a restart is not blind for the interval. */
const FIRST_RUN_MS = 10_000;

/** Transport failures before an alert stops trying and says so on the card. */
const MAX_ATTEMPTS = 3;

/* ------------------------------------------------------------------ queries */

const selectAlertById = () => prepare('SELECT * FROM alerts WHERE id = ?');

const selectArmedForTrade = () =>
  prepare(`SELECT * FROM alerts WHERE trade_id = ? AND status = 'armed'`);

const selectAllArmed = () => prepare(`SELECT * FROM alerts WHERE status = 'armed'`);

/**
 * Every alert ever set, newest first. `id` rather than `created_at` because it
 * is monotonic by construction and never ties, and the two orders are the same.
 */
const selectLog = () => prepare('SELECT * FROM alerts ORDER BY id DESC');

/**
 * Alerts still worth evaluating, with the trade they belong to.
 *
 * The test is the trade still being HOLDING, spelled out in SQL: the purchase
 * recorded in full and no sale yet. It is not enough to ask whether the ETH has
 * been sold. A purchase can also be *undone* - every stage in this ledger can
 * be cleared - and an alert left armed on a trade with no purchase on it fired
 * a message reading "Bought 0.0000 ETH for 0.00 USDC", because the figures it
 * quotes had all been emptied.
 *
 * Both halves are spelled out the same way, which is the point of writing it
 * out at all. `stages()` calls a sale recorded only when the date, the amount
 * and the ETH are all there, so a row carrying a bare `sell_date` - which the
 * API accepts, and which the sale form cannot produce - is still HOLDING to
 * `derive`, and therefore to the bell on the card and to the check the PUT
 * makes before saving a goal. Asking about `sell_date` alone here disagreed
 * with all three: the goal saved, the bell lit, and this query never looked at
 * it again.
 *
 * An alert on a trade that fails this test is closed, not kept: see
 * `closeUnwatched`.
 */
// The HOLDING test as SQL, for the trade aliased `t`. Shared by the read that
// lists the armed alerts, by the claim, which has to ask again (see `fire`),
// and by /holding in report.js.
//
// Not repaid either, as `stages()` has it: `derive` calls a repaid trade
// CLOSED whether or not its sale is complete. Without that line a row repaid
// with no full sale - which the API refuses now, but older rows can carry -
// was listed by /holding, its alert never closed, and the sweep fired it with
// interest counted to today on a loan repaid months before.
export const HOLDING = `
      t.buy_date IS NOT NULL
      AND t.buy_amount IS NOT NULL
      AND t.buy_eth IS NOT NULL
      AND (t.sell_date IS NULL OR t.sell_amount IS NULL OR t.sell_eth IS NULL)
      AND (t.repay_date IS NULL OR t.repay_amount IS NULL OR t.repay_amount <= 0)`;

// The trade's asset rides along, so the sweep judges each goal against its
// own market.
/**
 * The market of the trade aliased `t`, in SQL: 'BTC' for cbBTC, 'WBTC' for
 * WBTC, 'ETH' for anything else, built from `ASSET_META` so it cannot drift
 * from `marketOf`.
 * `ALERT_OFF_MARKET` is an alert whose goal is a price of the other market -
 * set before the trade's asset changed - which nothing may judge or send.
 */
const TRADE_MARKET = `CASE t.asset ${ASSETS.map((a) => `WHEN '${a}' THEN '${ASSET_META[a].market}'`).join(' ')} ELSE '${
  ASSET_META[ASSETS[0]].market
}' END`;
const ALERT_OFF_MARKET = `COALESCE(alerts.market, 'ETH') <> ${TRADE_MARKET}`;

const selectArmed = () =>
  prepare(`
    SELECT a.*, t.id AS t_id, t.asset AS t_asset FROM alerts a
    JOIN trades t ON t.id = a.trade_id
    WHERE a.status = 'armed' AND ${HOLDING}
  `);

const selectTrade = () => prepare('SELECT * FROM trades WHERE id = ?');

/**
 * Close every armed alert whose trade no longer holds ETH - sold, or its
 * purchase cleared - and answer how many.
 *
 * They used to be kept armed, so that undoing the sale brought the goal back.
 * In practice a sold position's goal is over, and the Alerts list went on
 * calling it ARMED, "not watched", on trades long since closed. Closed is
 * final: undoing the sale does not revive it, and the bell sets a new one.
 *
 * Conditional on `armed`, so two copies of the app sharing the file cannot
 * both close one - the same claim `fire` makes. Run after every trade edit, at
 * startup and at the top of each sweep, which also catches an edit made by the
 * other copy. A refused statement is logged and skipped: the trade edit that
 * called this has already been written, and must not be reported as failed.
 */
export function closeUnwatched() {
  if (!db.open) return 0;
  try {
    // And one left armed in the other market. The PATCH that changes an asset
    // closes the armed goal, but a goal claimed for sending at that moment is
    // not armed; its send failing then put it back, an ETH goal on a cbBTC
    // trade that the sweep passed over for good, its owed message never sent.
    return prepare(`
      UPDATE alerts SET status = 'closed', updated_at = @now
      WHERE status = 'armed'
        AND EXISTS (SELECT 1 FROM trades t WHERE t.id = alerts.trade_id
                     AND (NOT (${HOLDING}) OR ${ALERT_OFF_MARKET}))
    `).run({ now: new Date().toISOString() }).changes;
  } catch (err) {
    console.error('Could not close alerts on trades that sold:', err.message);
    return 0;
  }
}

/**
 * Close the armed alert on a trade whose asset has just changed, and answer how
 * many. Its goal was a price in the other market - an ETH goal of $3,000 on
 * what is now a cbBTC trade would read as BTC falling to $3,000 - so it is
 * over, as a sale ends one, and the bell sets a new one. Called by the PATCH
 * inside the transaction that writes the change, so no sweep can claim it in
 * between.
 *
 * No `last_error`, as `closeUnwatched` writes none: the Alerts view reads that
 * column as "not sent", which a goal never reached was not. One already
 * reached and waiting on its send keeps the error it has, which is true.
 */
export function closeForAssetChange(tradeId) {
  return prepare(`
    UPDATE alerts SET status = 'closed', updated_at = @now
    WHERE trade_id = @trade_id AND status = 'armed'
  `).run({ trade_id: tradeId, now: new Date().toISOString() }).changes;
}

/** What the browser is told. The chat id and the token are never in here. */
export const alertView = (row) =>
  row == null
    ? null
    : {
        id: row.id,
        tradeId: row.trade_id,
        goalPrice: row.goal_price,
        direction: row.direction,
        status: row.status,
        basisPrice: row.basis_price,
        createdAt: row.created_at,
        firedAt: row.fired_at,
        firedPrice: row.fired_price,
        lastError: row.last_error,
        market: marketOfAlert(row),
      };

/** The market an alert's goal is a price of; ETH for one saved before BTC. */
export const marketOfAlert = (row) => row?.market ?? 'ETH';

export const getAlertById = (id) => alertView(selectAlertById().get(id));

export const getArmedAlert = (tradeId) => alertView(selectArmedForTrade().get(tradeId));

/**
 * The armed alerts, keyed by trade, so a card looks one up rather than
 * scanning. Armed only: with history in the table, keying by trade is well
 * defined for the one status a trade can have at most one of, and nothing else.
 */
export function armedAlerts() {
  const out = {};
  for (const row of selectAllArmed().all()) out[row.trade_id] = alertView(row);
  return out;
}

/** Every alert ever set, newest first, for the Alerts view. */
export const alertLog = () => selectLog().all().map(alertView);

/**
 * Which way the price has to move to reach the goal.
 *
 * Decided against where ETH is *now*, not against what was paid for it. A goal
 * is a crossing that has not happened yet: with ETH at 3,000 and a purchase at
 * 2,500, a goal of 2,600 means "tell me if it falls back to 2,600". Read
 * against the purchase price that was an upward goal already met, so the next
 * tick fired it immediately and the message said ETH had hit a price it had in
 * fact fallen from.
 *
 * Settled once, when the alert is saved, rather than recomputed on every tick,
 * and the price it was decided from is stored beside it so a goal that looks
 * odd later can still be explained.
 *
 * The purchase price is only the fallback, for a ledger that has not managed to
 * reach the price service yet. With neither known the alert reads upward and
 * the window says so, rather than refusing the save: the habit everywhere here
 * is to save now and resolve later.
 */
export const directionFor = (goal, reference) =>
  reference == null || goal >= reference ? 'above' : 'below';

/** What a goal is judged against: the live price, or failing that what was paid. */
function referenceFor(trade, price) {
  if (Number.isFinite(price)) return price;
  const basis = derive(trade).buyPriceUsd;
  return Number.isFinite(basis) ? basis : null;
}

const reached = (alert, price) =>
  alert.direction === 'above' ? price >= alert.goal_price : price <= alert.goal_price;

/**
 * Save the goal for a trade, replacing whatever was there. `price` is the
 * current price of the trade's market, which decides the direction; null when
 * it could not be had.
 */
// Only a goal not yet reached. One that was reached and is waiting to be sent
// - put back to armed with `fired_at` after a failed send - is history: the
// Alerts view shows when and where it was hit, and deleting it took that
// record, and the message it owed, with it. It is closed as failed instead,
// its last error kept and the replacement named.
const clearArmed = () =>
  prepare(`DELETE FROM alerts WHERE trade_id = ? AND status = 'armed' AND fired_at IS NULL`);

const failReachedArmed = () =>
  prepare(`
    UPDATE alerts
       SET status = 'failed',
           last_error = COALESCE(last_error || CASE WHEN last_error LIKE '%.' THEN ' ' ELSE '. ' END, '')
                        || 'Replaced by a new goal before it was sent.',
           updated_at = @now
     WHERE trade_id = @trade_id AND status = 'armed' AND fired_at IS NOT NULL
  `);

const insertAlert = () =>
  prepare(`
    INSERT INTO alerts (trade_id, goal_price, direction, status, basis_price,
                        fired_at, fired_price, attempts, last_error, market, created_at, updated_at)
    VALUES (@trade_id, @goal_price, @direction, 'armed', @basis_price,
            NULL, NULL, 0, NULL, @market, @now, @now)
  `);

/**
 * Replace the armed alert on a trade, leaving its history where it is.
 *
 * Two statements, so one transaction: a crash between them would leave the
 * trade with no alert and no record that one had been replaced.
 *
 * Deliberately not an upsert. `ON CONFLICT ... DO UPDATE` would keep the old
 * row's `created_at`, and the Alerts view has a Set column - saving a goal
 * again should read as one set today, not as the old one wearing a new figure.
 * A fired or failed row on the same trade is not touched either way.
 */
const replaceArmed = db.transaction((p) => {
  failReachedArmed().run({ trade_id: p.trade_id, now: p.now });
  clearArmed().run(p.trade_id);
  return insertAlert().run(p).lastInsertRowid;
});

/**
 * Save the goal for a trade. `price` is the current price of the trade's
 * market (ETH's, or BTC's for cbBTC), which decides the direction; null when it
 * could not be had.
 */
export function saveAlert(trade, goalPrice, price = null) {
  const basis = referenceFor(trade, price);
  const id = replaceArmed({
    trade_id: trade.id,
    goal_price: goalPrice,
    direction: directionFor(goalPrice, basis),
    basis_price: basis,
    market: marketOf(trade),
    now: new Date().toISOString(),
  });
  return getAlertById(id);
}

export function deleteAlert(id) {
  return prepare('DELETE FROM alerts WHERE id = ?').run(id).changes > 0;
}

/**
 * Everything, armed included. Answers how many went, because the only honest
 * thing the interface can say afterwards is the number.
 *
 * `through` is the newest alert id the page was showing. The page's list is
 * only as fresh as the last visit to the view, and the confirmation counts
 * from it, so without the bound a goal set since - from another device, or
 * the other copy of the app - was deleted unseen: "Delete all 15?" deleted
 * 16, the new armed goal among them, never to alert. Ids only grow, so
 * everything newer than the list is left.
 */
export function deleteAllAlerts(through = null) {
  return through == null
    ? prepare('DELETE FROM alerts').run().changes
    : prepare('DELETE FROM alerts WHERE id <= ?').run(through).changes;
}

/* ------------------------------------------------------------------ message */

/**
 * What lands in the group. Written to be read on a phone, at a glance, by
 * someone who has not opened the ledger: the headline first, then enough of
 * the trade to know which one it is without going and looking, then - after a
 * blank line, so the two blocks do not run together - what it is worth and
 * what it would make.
 *
 * It carries the trade's figures because that is what was asked for. Worth
 * remembering that a group is a room full of other people, and the alert
 * window shows this same text before anything is saved, so nothing arrives
 * there that was not read first.
 */
/**
 * `fxNow` is today's rate per borrowed coin, so a euro trade's gain reads the
 * same here as in /holding and on the page (see `estimatedGainUsd`).
 */
/**
 * `when` is 'now' for a message written at the price the sweep just fetched,
 * and 'then' for one owed since an earlier sweep and sent without a fresh
 * price: it is written at the price its goal was reached at, and says so
 * rather than calling an hours-old cached figure "now".
 */
export function alertMessage(trade, alert, price, fxNow = {}, { when = 'now' } = {}) {
  const d = derive(trade, derivedOn(trade));
  const c = trade.borrow_currency;
  // The goal is a price of the market, BTC for a cbBTC trade; the quantity is
  // of the asset itself. The alert's own market when it has one, so a message
  // says what the goal was set in.
  const market = alert.market ?? marketOf(trade);
  // The price is only worth stating when it is not the goal, which it usually
  // is not: a check every quarter hour finds the market somewhere past it. In
  // the window, where the two are equal by construction, saying it twice read
  // like a mistake.
  const at =
    n2(price) === n2(alert.goal_price) ? '' : when === 'then' ? ` at $${n2(price)}` : ` - now $${n2(price)}`;

  const lines = [
    // "Reached" either way. "Fell to" read as bad news on a goal set below
    // the price, which is often the one somebody is waiting to buy at.
    `${market} reached your $${n2(alert.goal_price)} goal${at}`,
    '',
    `Trade #${trade.id}: borrowed ${n2(trade.borrow_amount)} ${c} on ${fmtDate(trade.borrow_date)}`,
    `Bought: ${qty(trade.buy_eth, trade)}`,
  ];

  if (typeof d.buyPriceUsd === 'number') lines.push(`Purchase price: $${n2(d.buyPriceUsd)}`);

  const value = [];

  // Worth stands on its own line, so it can still be stated on a trade whose
  // rate is missing: what the asset is worth needs no exchange rate, while the
  // gain underneath it is measured against a cost basis that does.
  if (Number.isFinite(d.ethHeld) && Number.isFinite(price)) {
    value.push(`Worth ${when === 'then' ? 'then' : 'now'}: $${n2(d.ethHeld * price)}`);
  }

  const gain = estimatedGainUsd(trade, d, price, fxNow);
  if (gain !== null) {
    // The cost is stated rather than alluded to. "After interest" on a loan
    // taken out this morning claimed a deduction that had not happened yet,
    // and on an older one it asked the reader to take the size of it on trust.
    // `estimatedGainUsd` is null unless this figure is a number, so it is one.
    // Through `signedUsd` rather than a sign built here from the held value,
    // which put a minus on a gain too small to show: a goal typed a fraction
    // of a cent below break-even previewed as `Gain: -$0.00`.
    // The fees already paid are deducted too, so they are named too, for the
    // same reason the interest is. "Fees", not "gas": the swaps' figure carries
    // the DEX's own fee as well. Left off when nothing was recorded, rather
    // than claiming a $0.00 deduction nobody measured.
    const fees = Number.isFinite(d.feesUsd) ? ` and $${n2(d.feesUsd)} fees` : '';
    // The interest named is the interest taken off, so it is converted at the
    // rate the gain was: today's for a euro loan when it is known, which the
    // line then says, rather than the borrow day's figure from the card.
    const rate = estimateRate(trade, d, fxNow);
    const marked = rate !== null && !d.isUsdPegged;
    const interestUsd = marked ? d.accruedInterest * rate : d.accruedInterestUsd;
    // And what the move since the purchase did, because the lines above price
    // the purchase at the rate it was made at: without it "Worth now" less
    // that cost, the interest and the fees came to +$2,876.60 above a gain of
    // -$723.40, the missing $3,600 being 30,000 EURC from 1.05 to 1.17.
    const moved =
      marked && Number.isFinite(trade.buy_fx) ? -asPrinted(trade.buy_amount) * (rate - trade.buy_fx) : null;
    const at = !marked
      ? ''
      : moved === null
        ? ` (${c} at ${rate.toFixed(4)} today)`
        : ` (${c} at ${rate.toFixed(4)} today, bought at ${trade.buy_fx.toFixed(4)}: ${signedUsd(moved)})`;
    // The same gain over what the asset cost, signed the way the dollars are.
    const pct = estimatedGainPct(trade, d, price, fxNow);
    if (pct !== null) value.push(`Gain (%): ${signedPct2(pct)}`);
    value.push(`Gain ($): ${signedUsd(gain)} after $${n2(interestUsd)} interest${fees}${at}`);
  }

  if (value.length) lines.push('', ...value);

  return lines.join('\n');
}

/**
 * The message a goal would produce, without one having been saved.
 *
 * The window shows this while the goal is still being typed, which is the
 * whole reason it exists: the figures in that message leave the machine, and
 * they should be read before they do, not after.
 */
export function previewMessage(trade, goalPrice, price = null) {
  return alertMessage(
    trade,
    { goal_price: goalPrice, direction: directionFor(goalPrice, referenceFor(trade, price)) },
    // Written at the goal rather than at today's price: the message only goes
    // out once the goal is reached, so those are the figures it will carry.
    goalPrice,
    // From the cache alone, like the market price beside it: this answers while
    // the goal is being typed and must not wait on the network per keystroke.
    cachedRateToday(trade),
  );
}

/** `{ [coin]: today's cached rate }` for a coin that is not a dollar, or {}. */
function cachedRateToday(trade) {
  const c = trade.borrow_currency;
  if (isUsdPegged(c)) return {};
  const rate = cachedRate(c, todayISO())?.rate;
  return Number.isFinite(rate) && rate > 0 ? { [c]: rate } : {};
}

/* -------------------------------------------------------------------- sweep */

let timer = null;
let firstRun = null;
let sweeping = false;

/**
 * Claim the alert, then send.
 *
 * The UPDATE is the lock: it only matches while the row still says 'armed', so
 * of two processes arriving together exactly one gets `changes === 1` and the
 * other walks away having done nothing.
 */
/**
 * Put a claimed alert back to armed after a send that did not go through, in
 * one statement. Not back to armed on a trade sold while the send was in
 * flight - that put an armed goal on a sold trade until the next sweep - nor
 * when a newer goal already watches the trade (see the comment in `fire`).
 * `counted` adds the failure to `attempts` and gives up at `@max`.
 */
const backToArmed = ({ counted }) => {
  const holds = `EXISTS (SELECT 1 FROM trades t WHERE t.id = alerts.trade_id AND ${HOLDING})`;
  // Its trade changed asset while it was being sent: the goal is a price of
  // the other market now (see closeUnwatched).
  const offMarket = `EXISTS (SELECT 1 FROM trades t WHERE t.id = alerts.trade_id AND ${ALERT_OFF_MARKET})`;
  const superseded = `EXISTS (
          SELECT 1 FROM alerts other
           WHERE other.trade_id = alerts.trade_id
             AND other.status = 'armed'
             AND other.id <> alerts.id
        )`;
  // A newer goal saved while this one was being sent: closed as failed, with
  // the replacement named, as `failReachedArmed` closes one replaced after
  // its failure. Left as 'fired', the Alerts view called a message that
  // never went FIRED, and the same replacement read two ways by a second.
  const replaced = `${counted ? 'attempts + 1 < @max AND ' : ''}${holds} AND NOT ${offMarket} AND ${superseded}`;
  return prepare(`
    UPDATE alerts SET
      status = CASE
        ${counted ? "WHEN attempts + 1 >= @max THEN 'failed'" : ''}
        WHEN NOT ${holds} THEN 'closed'
        WHEN ${offMarket} THEN 'closed'
        WHEN ${superseded} THEN 'failed'
        ELSE 'armed'
      END,
      ${counted ? 'attempts = attempts + 1,' : ''}
      last_error = CASE
        WHEN ${replaced}
          THEN @error || CASE WHEN @error LIKE '%.' THEN ' ' ELSE '. ' END || 'Replaced by a new goal before it was sent.'
        ELSE @error
      END,
      updated_at = @now
    WHERE id = @id
  `);
};

async function fire(row, price, market, { when = 'now' } = {}) {
  // Today's rate, asked for properly: this message leaves the machine. A lookup
  // that fails answers null rather than throwing, and the stored rates stand in.
  //
  // Before the claim, not after: shutdown waits twelve seconds for a sweep, and
  // a euro alert's lookup (up to 2.5 s) and its send (up to 10 s) after the
  // claim outlasted it - the database closed under a claimed alert, left FIRED
  // with no error for a message never sent. Claimed after it, only the send is
  // left to wait for. A sweep told to stop meanwhile claims nothing.
  const before = selectTrade().get(row.trade_id);
  if (!before) return;
  const today = isUsdPegged(before.borrow_currency) ? null : await resolveRate(before.borrow_currency, todayISO());
  const fxNow = Number.isFinite(today?.rate) ? { [before.borrow_currency]: today.rate } : {};
  if (stopping || !db.open) return;

  const now = new Date().toISOString();
  // `last_error` is cleared here. A retry that succeeds writes nothing after
  // the claim, so the error from the attempt before it stayed on a delivered
  // alert, and the Alerts view - which draws "not sent" from that column -
  // showed a FIRED alert as not sent after a 500 followed by a 200.
  //
  // And the trade is asked again whether it is still holding. The list was
  // read before the price lookup and every earlier send, which together can
  // take a quarter of a minute, and a sale recorded in that window still sent
  // the alert: a goal message for a position that no longer existed.
  //
  // A retry keeps the time and price of the first claim. They say when the goal
  // was reached, and the retry goes out later, at whatever the market is by then.
  const claimed = prepare(`
    UPDATE alerts SET status = 'fired', fired_at = COALESCE(fired_at, @now),
      fired_price = COALESCE(fired_price, @price), last_error = NULL, updated_at = @now
    WHERE id = @id AND status = 'armed'
      AND EXISTS (SELECT 1 FROM trades t WHERE t.id = alerts.trade_id AND ${HOLDING}
                   AND NOT (${ALERT_OFF_MARKET}))
  `).run({ id: row.id, price, now });

  if (claimed.changes !== 1) return;

  const trade = selectTrade().get(row.trade_id);
  if (!trade) return;

  const sent = await sendTelegramMessage(alertMessage(trade, row, price, fxNow, { when }));
  if (sent.ok) {
    console.log(`Alert on trade #${row.trade_id} sent: ${market} at ${price}.`);
    return;
  }

  // The connection died mid-send, so whether it arrived is genuinely unknown.
  // Put the alert back and try again next tick, up to a point: an alert that
  // can never be delivered should say so rather than retry forever.
  if (!db.open) return;
  if (sent.retryable) {
    // `fired_at` and `fired_price` are left as the claim wrote them. They record
    // when the goal was reached, which is true however the send went, and an
    // alert that gives up after three tries needs them to say what it was
    // trying to tell you - blanking them left the window reading "Reached ,
    // but the message could not be sent". The retry's claim keeps them too.
    // Keyed on the alert, not the trade. With history in the table a trade can
    // have many, and `WHERE trade_id` would rewrite the status and the error
    // across every alert ever set on it - putting fired ones back to armed and
    // sending them again on the next sweep.
    //
    // Re-arming is refused when a newer goal is already watching this trade.
    // Claiming the alert is what unselects the bell, so the whole of the send -
    // ten seconds, when Telegram does not answer - is a window in which the
    // card offers to set another one. Re-arming regardless broke the partial
    // unique index that allows a trade one armed alert, and the throw was
    // caught by the sweep: this row kept `status = 'fired'` with no error on
    // it, so the Alerts view showed an ordinary sent alert for a message that
    // never went, and every alert still to be checked in that pass was skipped.
    //
    // One statement rather than a read and a write, because two copies of this
    // app poll the same file and anything in between is a race. Superseded, the
    // row is closed as failed with the replacement named - what a goal replaced
    // after its failure gets (`failReachedArmed`) - and carries the reason,
    // which is what the "not sent" note on the card is derived from.
    //
    // Counted in SQL, from the row as it stands. Counted here from `row`, read
    // when the sweep began and many seconds old by now, a failure recorded by
    // the other copy in between was written over, and the alert was re-armed
    // past its three tries. Every SET reads the row before the update, so
    // `attempts + 1` is the count this failure makes.
    //
    // Not counted when the request never left the machine (`notSent`): that
    // send cannot have arrived, so it is waited out like a setup error.
    const counted = !sent.notSent;
    backToArmed({ counted }).run({
      id: row.id,
      ...(counted ? { max: MAX_ATTEMPTS } : {}),
      error: sent.error,
      now: new Date().toISOString(),
    });
  } else if (sent.setup) {
    // The token or the chat is wrong, not the message: Telegram will take it
    // once config.env or the group is put right. Used up as a refusal, a goal
    // reached while the bot was out of the group was lost for good, though
    // the next send would have gone. So it waits, armed, with the reason on
    // the card, and goes out on the first sweep after the fix. Not counted
    // towards the three tries: those are for a send that may have arrived.
    backToArmed({ counted: false }).run({ id: row.id, error: sent.error, now: new Date().toISOString() });
  } else {
    // Telegram understood us and said no. It will say the same thing next
    // time, so the alert stays fired and the card carries the reason.
    prepare('UPDATE alerts SET last_error = @error, updated_at = @now WHERE id = @id').run({
      id: row.id,
      error: sent.error,
      now: new Date().toISOString(),
    });
  }
  console.error(`Alert on trade #${row.trade_id} could not be sent: ${sent.error}`);
}

/**
 * One pass. Counts what is armed before it does anything else, so a ledger
 * with no alerts on it never touches the network however long it is left
 * running.
 */
/**
 * How old the sweep's price may be, and still be taken as today's: the age it
 * asks for, twice over, so one late refresh is not an outage.
 */
const PRICE_FRESH_MS = 2 * Math.min(POLL_MS, 300_000);

/**
 * The quote's price while it is fresh, else null. `marketPrices` falls back to the
 * cache when the service fails - a 429 parks it for up to an hour, and the
 * network is gone after the Mac wakes - and the cache has no age limit, so a
 * goal was fired, and a message that cannot be unsent went out, on a price a
 * day and a half old called "now"; and a goal saved meanwhile took its
 * direction from it. Exported for that save.
 */
export function freshPrice(quote) {
  if (!quote || !Number.isFinite(quote.price)) return null;
  // An age that is not a number is not fresh. `ageOf` answers Infinity for a
  // fetch time ahead of the clock, which it calls unknown; tested as "older
  // than", Infinity was not finite, so passed, and a goal fired on it.
  return Number.isFinite(quote.ageMs) && quote.ageMs <= PRICE_FRESH_MS ? quote.price : null;
}

/**
 * The sweep under way, if any, for shutdown to wait on. Stopped mid-send, the
 * claim had already marked the alert fired and the result was never written:
 * a message Telegram refused, or never got, read as sent and was never tried
 * again. Settles, never rejects.
 */
let sweepInFlight = null;
export function alertSweepDone() {
  return sweepInFlight ?? Promise.resolve();
}

export function runAlertSweep() {
  const run = sweepOnce();
  // A sweep that found one already running returns at once; the running one
  // stays the one to wait on.
  if (!sweepInFlight) {
    const tracked = run
      .catch(() => {})
      .finally(() => {
        if (sweepInFlight === tracked) sweepInFlight = null;
      });
    sweepInFlight = tracked;
  }
  return run;
}

async function sweepOnce() {
  // A tick can arrive while the last one is still away, and again after the
  // database has been closed on the way out.
  if (sweeping || !db.open) return { checked: 0, fired: 0 };

  sweeping = true;
  let checked = 0;
  try {
    // Inside the try with everything else. Reading the armed list can throw
    // like any other statement - a second copy of the app checkpointing this
    // same file holds an exclusive lock, and a read that waits longer than the
    // busy timeout is refused - and this ran on a timer, so the rejection
    // became an uncaughtException and took the whole server down with it.
    closeUnwatched();
    const armed = selectArmed().all();
    checked = armed.length;
    if (armed.length === 0) return { checked: 0, fired: 0 };

    // Nowhere to send it, so nothing is claimed. Claiming first used the alert
    // up: the send failed as not retryable and the row stayed fired for good,
    // while the alert window promises the goal "will be sent once config.env
    // is filled in". Left armed, the first sweep after the file is filled in
    // sends it.
    if (!telegramConfig().configured) return { checked: armed.length, fired: 0 };

    // Both markets in one request, and only when some armed goal is on each -
    // a ledger with no cbBTC goal never makes BTC's price a reason to ask.
    const markets = [...new Set(armed.map(marketOfAlert))];
    const quotes = await marketPrices({ maxAgeMs: Math.min(POLL_MS, 300_000), markets });
    if (stopping || !db.open) return { checked: armed.length, fired: 0 };

    let fired = 0;
    for (const row of armed) {
      // Shutdown has begun: nothing more is claimed. The loop used to go on to
      // the next reached goal after SIGTERM, claim it nine seconds later, and
      // have the database closed under its send - FIRED, no error, never sent.
      if (stopping || !db.open) break;
      // Each goal against its own market. A BTC quote that could not be had
      // holds back the cbBTC goals and nothing else.
      const market = marketOfAlert(row);
      // A goal set in one market on a trade now valued in the other is never
      // judged: the PATCH that changed the asset closed it in the same
      // transaction, so this only meets one written by something else.
      if (market !== marketOf({ asset: row.t_asset })) continue;
      const quote = quotes[market];
      const fresh = freshPrice(quote);
      // An armed row with a firing time already reached its goal and is only
      // waiting for the message to go through - after a send that failed, or
      // while Telegram's setup was wrong - so it is sent whatever the market
      // is now. Gated on the price like a fresh one, a send that timed out was
      // retried only if ETH happened to be past the goal again a quarter of an
      // hour later: a dip that came back never got its message, and the card
      // went on calling the alert armed. A goal saved afresh has none.
      // A fresh goal is judged on a fresh price only. One already reached is
      // owed its message, whatever the price is now.
      if (row.fired_at == null && (fresh === null || !reached(row, fresh))) continue;
      // An owed one is sent at a fresh price when there is one, and otherwise
      // at the price its goal was reached at, said as such: resent on the
      // cached figure, it read "- now $2,540.00" at a price three hours old.
      const sendAt = fresh ?? row.fired_price;
      if (!Number.isFinite(sendAt)) continue;
      // Each one on its own. The catch below covers the pass, so anything
      // thrown here used to abandon every alert still to be looked at - and
      // the one that threw had already been claimed, which is to say marked
      // as sent. One bad row should cost one message, not the rest of the
      // quarter hour.
      try {
        await fire(row, sendAt, market, { when: fresh === null ? 'then' : 'now' });
        fired += 1;
      } catch (err) {
        console.error(`Alert ${row.id} on trade #${row.trade_id} failed:`, err.message);
      }
      if (!db.open) break;
    }
    return {
      checked: armed.length,
      fired,
      prices: Object.fromEntries(Object.entries(quotes).map(([m, q]) => [m, q?.price ?? null])),
    };
  } catch (err) {
    // A sweep is unattended. It must never be the thing that takes the
    // process down, so anything unexpected is logged and the timer carries on.
    console.error('Price alert check failed:', err.message);
    return { checked, fired: 0 };
  } finally {
    sweeping = false;
  }
}

/**
 * Set once shutdown begins (`stopAlertPoller`), so a sweep under way claims
 * nothing more; it finishes the send it has, and shutdown waits for that.
 */
let stopping = false;

export function startAlertPoller() {
  if (timer) return;
  stopping = false;
  // Unreferenced, both of them: a pending check must never be the reason the
  // process refuses to exit.
  firstRun = setTimeout(runAlertSweep, FIRST_RUN_MS);
  firstRun.unref?.();
  timer = setInterval(runAlertSweep, POLL_MS);
  timer.unref?.();
}

/** How often the sweep runs, so nothing else has to guess at it. */
export const alertPollMs = POLL_MS;
/** The age past which a price is not fresh (`freshPrice`), for the bot's age lines. */
export const priceFreshMs = PRICE_FRESH_MS;

export function stopAlertPoller() {
  stopping = true;
  clearTimeout(firstRun);
  clearInterval(timer);
  firstRun = null;
  timer = null;
}
