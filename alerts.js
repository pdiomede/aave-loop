/**
 * Price alerts on a trade whose ETH is still held.
 *
 * A trade in HOLDING has one number that matters and it is not in the ledger:
 * where ETH is trading. An alert names the price you are waiting for, and a
 * timer here watches for it so nobody has to watch a chart.
 *
 * Two things in here are load bearing and neither is obvious.
 *
 * The first is that the alert is claimed before the message is sent, with a
 * conditional UPDATE, and not after. `run_myAave.sh` will happily start a
 * second copy of the app on the next free port pointed at this same database
 * file, and both copies poll. Only one of them can win a
 * `WHERE status = 'armed'`, so only one of them sends. Sent-then-marked would
 * put the message in the group twice, and a message cannot be unsent.
 *
 * The second is that armed alerts are found by joining the trade and asking
 * whether it is still holding ETH. Selling it, or undoing the purchase, ends
 * the reason for the alert, and this way nothing has to remember to go and
 * switch it off.
 *
 * The third is that an alert is kept after it fires. A trade can therefore have
 * many, so every statement here keys on the alert's own id and never on the
 * trade - a statement that says `WHERE trade_id` would reach the history as
 * well as the live one. The rule that a trade has at most one *armed* alert is
 * a partial unique index in db.js.
 */
import { db, prepare } from './db.js';
import { derive, unrealisedUsd } from './lib/calc.js';
import { ethPrice } from './eth.js';
import { sendTelegramMessage } from './telegram.js';
import { n2, n4, fmtDate, signedUsd } from './format.js';

/**
 * Fifteen minutes. The price is checked on a schedule rather than watched, and
 * a goal price is not a limit order: being told within a quarter of an hour is
 * the point, and asking a free service four times an hour keeps us a polite
 * distance from its rate limit.
 */
const POLL_MS = Number(process.env.MYAAVE_ALERT_POLL_MS) || 900_000;

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
 * Nothing is deleted either way. Both edits can themselves be undone, and
 * restoring the stage brings the alert back with it.
 */
const selectArmed = () =>
  prepare(`
    SELECT a.*, t.id AS t_id FROM alerts a
    JOIN trades t ON t.id = a.trade_id
    WHERE a.status = 'armed'
      AND t.buy_date IS NOT NULL
      AND t.buy_amount IS NOT NULL
      AND t.buy_eth IS NOT NULL
      AND (t.sell_date IS NULL OR t.sell_amount IS NULL OR t.sell_eth IS NULL)
  `);

const selectTrade = () => prepare('SELECT * FROM trades WHERE id = ?');

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
      };

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
 * Save the goal for a trade, replacing whatever was there. `price` is ETH's
 * current price, which decides the direction; null when it could not be had.
 */
const clearArmed = () => prepare(`DELETE FROM alerts WHERE trade_id = ? AND status = 'armed'`);

const insertAlert = () =>
  prepare(`
    INSERT INTO alerts (trade_id, goal_price, direction, status, basis_price,
                        fired_at, fired_price, attempts, last_error, created_at, updated_at)
    VALUES (@trade_id, @goal_price, @direction, 'armed', @basis_price,
            NULL, NULL, 0, NULL, @now, @now)
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
  clearArmed().run(p.trade_id);
  return insertAlert().run(p).lastInsertRowid;
});

/**
 * Save the goal for a trade. `price` is ETH's current price, which decides the
 * direction; null when it could not be had.
 */
export function saveAlert(trade, goalPrice, price = null) {
  const basis = referenceFor(trade, price);
  const id = replaceArmed({
    trade_id: trade.id,
    goal_price: goalPrice,
    direction: directionFor(goalPrice, basis),
    basis_price: basis,
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
 */
export function deleteAllAlerts() {
  return prepare('DELETE FROM alerts').run().changes;
}

/* ------------------------------------------------------------------ message */

/**
 * What lands in the group. Written to be read on a phone, at a glance, by
 * someone who has not opened the ledger: the headline first, then enough of
 * the trade to know which one it is without going and looking.
 *
 * It carries the trade's figures because that is what was asked for. Worth
 * remembering that a group is a room full of other people, and the alert
 * window shows this same text before anything is saved, so nothing arrives
 * there that was not read first.
 */
export function alertMessage(trade, alert, price) {
  const d = derive(trade);
  const c = trade.borrow_currency;
  const verb = alert.direction === 'above' ? 'hit' : 'fell to';

  // The price is only worth stating when it is not the goal, which it usually
  // is not: a check every quarter hour finds the market somewhere past it. In
  // the window, where the two are equal by construction, saying it twice read
  // like a mistake.
  const at = n2(price) === n2(alert.goal_price) ? '' : ` - now $${n2(price)}`;

  const lines = [
    `ETH ${verb} your $${n2(alert.goal_price)} goal${at}`,
    '',
    `Trade #${trade.id}: borrowed ${n2(trade.borrow_amount)} ${c} on ${fmtDate(trade.borrow_date)}`,
    `Bought: ${n4(trade.buy_eth)} ETH`,
  ];

  if (typeof d.buyPriceUsd === 'number') lines.push(`Purchase price: $${n2(d.buyPriceUsd)}`);

  // Worth stands on its own line, so it can still be stated on a trade whose
  // rate is missing: what the ETH is worth needs no exchange rate, while the
  // gain underneath it is measured against a cost basis that does.
  if (Number.isFinite(d.ethHeld) && Number.isFinite(price)) {
    lines.push(`Worth now: $${n2(d.ethHeld * price)}`);
  }

  const gain = unrealisedUsd(d, price);
  if (gain !== null) {
    // The cost is stated rather than alluded to. "After interest" on a loan
    // taken out this morning claimed a deduction that had not happened yet,
    // and on an older one it asked the reader to take the size of it on trust.
    // `unrealisedUsd` is null unless this figure is a number, so it is one.
    // Through `signedUsd` rather than a sign built here from the held value,
    // which put a minus on a gain too small to show: a goal typed a fraction
    // of a cent below break-even previewed as `Gain: -$0.00`.
    lines.push(`Gain: ${signedUsd(gain)} after $${n2(d.accruedInterestUsd)} interest`);
  }

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
  );
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
async function fire(row, price) {
  const now = new Date().toISOString();
  const claimed = prepare(`
    UPDATE alerts SET status = 'fired', fired_at = @now, fired_price = @price, updated_at = @now
    WHERE id = @id AND status = 'armed'
  `).run({ id: row.id, price, now });

  if (claimed.changes !== 1) return;

  const trade = selectTrade().get(row.trade_id);
  if (!trade) return;

  const sent = await sendTelegramMessage(alertMessage(trade, row, price));
  if (sent.ok) {
    console.log(`Alert on trade #${row.trade_id} sent: ETH at ${price}.`);
    return;
  }

  // The connection died mid-send, so whether it arrived is genuinely unknown.
  // Put the alert back and try again next tick, up to a point: an alert that
  // can never be delivered should say so rather than retry forever.
  if (!db.open) return;
  if (sent.retryable) {
    const attempts = (row.attempts ?? 0) + 1;
    // `fired_at` and `fired_price` are left as the claim wrote them. They record
    // when the goal was reached, which is true however the send went, and an
    // alert that gives up after three tries needs them to say what it was
    // trying to tell you - blanking them left the window reading "Reached ,
    // but the message could not be sent". A row back at 'armed' ignores them,
    // and re-firing overwrites them.
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
    // row stays as the claim left it and carries the reason, which is what the
    // "not sent" note on the card is derived from.
    prepare(`
      UPDATE alerts SET
        status = CASE
          WHEN @status = 'armed' AND EXISTS (
            SELECT 1 FROM alerts other
             WHERE other.trade_id = alerts.trade_id
               AND other.status = 'armed'
               AND other.id <> alerts.id
          ) THEN 'fired'
          ELSE @status
        END,
        attempts = @attempts, last_error = @error, updated_at = @now
      WHERE id = @id
    `).run({
      id: row.id,
      status: attempts >= MAX_ATTEMPTS ? 'failed' : 'armed',
      attempts,
      error: sent.error,
      now: new Date().toISOString(),
    });
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
export async function runAlertSweep() {
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
    const armed = selectArmed().all();
    checked = armed.length;
    if (armed.length === 0) return { checked: 0, fired: 0 };

    const quote = await ethPrice({ maxAgeMs: Math.min(POLL_MS, 300_000) });
    if (!quote || !db.open) return { checked: armed.length, fired: 0 };

    let fired = 0;
    for (const row of armed) {
      if (!reached(row, quote.price)) continue;
      // Each one on its own. The catch below covers the pass, so anything
      // thrown here used to abandon every alert still to be looked at - and
      // the one that threw had already been claimed, which is to say marked
      // as sent. One bad row should cost one message, not the rest of the
      // quarter hour.
      try {
        await fire(row, quote.price);
        fired += 1;
      } catch (err) {
        console.error(`Alert ${row.id} on trade #${row.trade_id} failed:`, err.message);
      }
      if (!db.open) break;
    }
    return { checked: armed.length, fired, price: quote.price };
  } catch (err) {
    // A sweep is unattended. It must never be the thing that takes the
    // process down, so anything unexpected is logged and the timer carries on.
    console.error('Price alert check failed:', err.message);
    return { checked, fired: 0 };
  } finally {
    sweeping = false;
  }
}

export function startAlertPoller() {
  if (timer) return;
  // Unreferenced, both of them: a pending check must never be the reason the
  // process refuses to exit.
  firstRun = setTimeout(runAlertSweep, FIRST_RUN_MS);
  firstRun.unref?.();
  timer = setInterval(runAlertSweep, POLL_MS);
  timer.unref?.();
}

/** How often the sweep runs, so nothing else has to guess at it. */
export const alertPollMs = POLL_MS;

export function stopAlertPoller() {
  clearTimeout(firstRun);
  clearInterval(timer);
  firstRun = null;
  timer = null;
}
