import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, prepare, closeDb, FIELDS, FX_COLUMNS } from './db.js';
import {
  derive,
  summaryReport,
  parseDate,
  parseAmount,
  stages,
  todayISO,
  CURRENCIES,
  FX_STAGES,
  STATUS,
} from './lib/calc.js';
import { fillFxColumns, staleFxColumns, backfillRates, resolveRate, fxStatus } from './fx.js';
import { telegramConfig, reportConfig } from './config.js';
import { ethPrice, cachedEthPrice, ethStatus } from './eth.js';
import { sendTelegramMessage } from './telegram.js';
import {
  allAlerts,
  saveAlert,
  deleteAlert,
  previewMessage,
  alertPollMs,
  startAlertPoller,
  stopAlertPoller,
} from './alerts.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT) || 3000;

const app = express();

// Says nothing about the stack to anyone who asks.
app.disable('x-powered-by');

/**
 * How this page may be embedded, and what a browser may assume about it.
 *
 * The ledger used to be reachable only from the machine running it, where
 * framing was moot. Behind a proxy it is not: without this an attacker's page
 * can frame the app against a logged in session and land a click on Delete
 * trade. `frame-ancestors` is the modern form and X-Frame-Options the one
 * older browsers read, so both are sent.
 *
 * It stops at framing on purpose. A script-src policy would need
 * 'unsafe-inline' for the theme script that runs before first paint and for
 * the bar widths in the summary, and a CSP that allows inline script is most
 * of the way back to no CSP at all. Tightening it means removing those first.
 */
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// The ledger has no authentication; the loopback bind is the whole of its
// protection. A request has to be addressed to loopback as well, or a page on
// the internet can point its own hostname at 127.0.0.1 and reach this API as a
// same origin, reading and deleting the entire ledger.
//
// Running behind a reverse proxy is a legitimate deployment, and there the Host
// is the public name rather than loopback, so the proxy's hostname has to be
// named. Naming it explicitly is what keeps the protection above intact: a page
// on the internet that points its own hostname at 127.0.0.1 still fails this
// check, because its name is not on the list. Left unset, this is exactly the
// loopback-only ledger it has always been.
const EXTRA_HOSTS = (process.env.MYAAVE_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_HOSTS = new Set([
  ...['localhost', '127.0.0.1', '[::1]'].flatMap((h) => [h, `${h}:${PORT}`]),
  ...EXTRA_HOSTS,
]);

app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    return res
      .status(403)
      .type('text/plain')
      .send(
        'This ledger only answers on localhost. Behind a proxy, name the host in ' +
          'MYAAVE_ALLOWED_HOSTS.',
      );
  }
  next();
});

app.use(express.json());

// Everything here is a small local file, so correctness beats caching. Without
// this the browser can keep serving a stale stylesheet or script from memory
// after an edit, leaving the page looking unchanged.
const staticOptions = {
  etag: true,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
};

app.use(express.static(path.join(root, 'public'), staticOptions));
app.use('/lib', express.static(path.join(root, 'lib'), staticOptions));
// In production nginx serves landing/ itself and requests never arrive here.
// This is for running without a proxy, where the 404 page below would otherwise
// be handed to a browser that cannot fetch the stylesheet it asks for.
app.use('/landing', express.static(path.join(root, 'landing'), staticOptions));

// API responses carried an ETag but no Cache-Control, which let the browser
// heuristically cache them and show a stale ledger after a change. These are
// live figures, so they must never be reused from cache.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ---------------------------------------------------------------- helpers */

class BadRequest extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

// A value of only whitespace is blank, not zero. Untrimmed, `toNumber(' ')`
// cleaned it to '' and `Number('')` made it 0, so a mistyped APR was stored as
// a silent 0% loan.
const isBlank = (v) =>
  v === undefined || v === null || (typeof v === 'string' ? v.trim() === '' : v === '');

const REQUIRED_BORROW = [
  ['borrow_date', 'Borrow date'],
  ['borrow_amount', 'Borrow amount'],
  ['borrow_currency', 'Currency'],
  ['borrow_apr', 'Borrow APR'],
];

function toNumber(value, field, label, { allowZero = false } = {}) {
  // Same parser the browser uses, so the two can no longer disagree about what
  // a value means: "1e5" was 15 in the form and 100000 here.
  const n = parseAmount(value);
  if (n === null) throw new BadRequest(`${label} must be a number.`, field);
  if (allowZero ? n < 0 : n <= 0) {
    throw new BadRequest(
      `${label} must be ${allowZero ? 'zero or more' : 'greater than zero'}.`,
      field,
    );
  }
  return n;
}

function toDate(value, field, label) {
  const iso = String(value).trim();
  const ts = parseDate(iso);
  if (ts === null) throw new BadRequest(`${label} must be a valid date.`, field);
  // Compared against the same local calendar date the form uses. The old
  // 36 hour slack was measured from `Date.now()` while `parseDate` returns UTC
  // midnight, so tomorrow always fell inside it and still produced the negative
  // loan span this check exists to prevent.
  if (iso > todayISO()) {
    throw new BadRequest(`${label} cannot be in the future.`, field);
  }
  if (ts < Date.UTC(2015, 6, 30)) {
    throw new BadRequest(`${label} is before Ethereum existed. Check the year.`, field);
  }
  return iso;
}

/**
 * Normalise an incoming payload into database columns.
 * Only keys actually present are returned, so PATCH can send one stage.
 * A key sent as null or '' clears that column, which is how a stage is undone.
 */
function normalise(body, { requireBorrow }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  const numericField = (key, label, opts) => {
    if (!has(key)) return;
    out[key] = isBlank(body[key]) ? null : toNumber(body[key], key, label, opts);
  };
  const dateField = (key, label) => {
    if (!has(key)) return;
    out[key] = isBlank(body[key]) ? null : toDate(body[key], key, label);
  };

  dateField('borrow_date', 'Borrow date');
  numericField('borrow_amount', 'Borrow amount');
  // A promotional or incentivised borrow really can sit at 0%.
  numericField('borrow_apr', 'Borrow APR', { allowZero: true });
  if (has('borrow_currency')) {
    const c = String(body.borrow_currency || '').toUpperCase();
    if (!CURRENCIES.includes(c)) throw new BadRequest('Pick a supported currency.', 'borrow_currency');
    out.borrow_currency = c;
  }

  dateField('buy_date', 'Purchase date');
  numericField('buy_amount', 'Purchase amount');
  numericField('buy_eth', 'ETH purchased');

  dateField('sell_date', 'Sale date');
  numericField('sell_amount', 'Sale amount');
  numericField('sell_eth', 'ETH sold');

  dateField('repay_date', 'Repayment date');
  numericField('repay_amount', 'Repaid amount');

  if (has('notes')) out.notes = isBlank(body.notes) ? null : String(body.notes).slice(0, 2000);

  // Exchange rates are resolved here from a published source, never accepted
  // from the caller. A request that could set its own rate could move every
  // dollar figure in the ledger without touching a single amount.
  for (const stage of FX_STAGES) {
    for (const key of [`${stage}_fx`, `${stage}_fx_date`]) {
      if (has(key)) throw new BadRequest('Exchange rates are looked up, not submitted.', key);
    }
  }
  if (has('fx_source')) throw new BadRequest('Exchange rates are looked up, not submitted.', 'fx_source');

  for (const [key, label] of REQUIRED_BORROW) {
    // On create the field has to be there. On update it may be absent, but if
    // it was sent it cannot be blanked: the column is NOT NULL, so clearing it
    // used to fail deep in SQLite as an opaque 500.
    if (requireBorrow ? isBlank(out[key]) : has(key) && isBlank(out[key])) {
      throw new BadRequest(`${label} is required.`, key);
    }
  }

  // APR is a percentage, not a fraction. Reject an obviously wrong magnitude.
  if (out.borrow_apr != null && out.borrow_apr > 100) {
    throw new BadRequest('APR looks too high. Enter it as a percent, for example 4.27.', 'borrow_apr');
  }

  return out;
}

/** A stage cannot be dated before the loan that funded it. */
function checkChronology(row) {
  const order = [
    ['buy_date', 'The purchase'],
    ['sell_date', 'The sale'],
    ['repay_date', 'The repayment'],
  ];
  for (const [key, label] of order) {
    if (row[key] && parseDate(row[key]) < parseDate(row.borrow_date)) {
      throw new BadRequest(`${label} cannot be dated before the borrow.`, key);
    }
  }
  if (row.sell_date && row.buy_date && parseDate(row.sell_date) < parseDate(row.buy_date)) {
    throw new BadRequest('The sale cannot be dated before the purchase.', 'sell_date');
  }
  if (row.repay_date && row.sell_date && parseDate(row.repay_date) < parseDate(row.sell_date)) {
    throw new BadRequest('The repayment cannot be dated before the sale.', 'repay_date');
  }
  // The interface only opens a stage once the previous one is filled in. The
  // API enforces the same order, otherwise a trade can reach states the maths
  // has no answer for, such as repaid without ever having been sold.
  if (row.sell_date != null && row.buy_date == null) {
    throw new BadRequest('Record the ETH purchase before the sale.', 'sell_date');
  }
  if (row.repay_date != null && row.sell_date == null) {
    throw new BadRequest('Record the ETH sale before the repayment.', 'repay_date');
  }

  // Those checks only look at the dates. Clearing `buy_amount` or `sell_eth`
  // through the API left a row still labelled CLOSED whose net gain had become
  // null, so it silently dropped out of every realized total while being
  // counted as an open position. A stage counts as filled only when its
  // amounts are there too.
  const st = stages(row);
  if (st.sold && !st.bought) {
    throw new BadRequest('Record the ETH purchase before the sale.', 'buy_amount');
  }
  if (st.repaid && !st.sold) {
    throw new BadRequest('Record the ETH sale before the repayment.', 'sell_amount');
  }

  if (row.sell_eth != null && row.buy_eth != null && row.sell_eth > row.buy_eth * 1.0001) {
    throw new BadRequest('You cannot sell more ETH than you bought.', 'sell_eth');
  }

  if (row.repay_amount != null && row.borrow_amount != null) {
    // Repaying less than the principal made the implied interest negative,
    // which the net gain then counted as profit. A $20,000 repayment on a
    // $32,000 loan reported a $12,000 gain out of nowhere.
    if (row.repay_amount < row.borrow_amount - 0.005) {
      throw new BadRequest(
        `A repayment cannot be less than the ${row.borrow_amount.toLocaleString('en-US')} borrowed.`,
        'repay_amount',
      );
    }
    // Interest can never double a loan over the spans this tracks, so a figure
    // that far out is a slipped digit rather than a real number.
    if (row.repay_amount > row.borrow_amount * 2) {
      throw new BadRequest(
        `That is a long way above the ${row.borrow_amount.toLocaleString('en-US')} borrowed. Check the figure.`,
        'repay_amount',
      );
    }
  }
}

const withDerived = (row) => ({ ...row, derived: derive(row) });

/**
 * One writer at a time per trade.
 *
 * PATCH became asynchronous when rate lookups moved into it, so two requests
 * for the same trade now interleave across the await: the second reads the row
 * before the first has written, decides which rates are stale from that older
 * snapshot, and answers the browser with a row missing the change the first one
 * just made. Two tabs, or a rate backfill overlapping an edit, is enough.
 */
const tradeLocks = new Map();

function withTradeLock(id, fn) {
  const run = (tradeLocks.get(id) ?? Promise.resolve()).then(() => fn());
  // The next waiter must not inherit this one's rejection.
  const tail = run.then(
    () => {},
    () => {},
  );
  tradeLocks.set(id, tail);
  tail.then(() => {
    if (tradeLocks.get(id) === tail) tradeLocks.delete(id);
  });
  return run;
}

const selectAll = prepare('SELECT * FROM trades ORDER BY borrow_date DESC, id DESC');
const selectOne = prepare('SELECT * FROM trades WHERE id = ?');

/* ------------------------------------------------------------------ routes */

// Browsers ask for this even when the page names its icon explicitly.
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/AaveLoop_logo.png'));

app.get('/api/version', (_req, res) => res.json({ version: pkg.version }));

app.get('/api/trades', (_req, res) => {
  res.json(selectAll.all().map(withDerived));
});

app.get('/api/summary', (_req, res) => {
  res.json(summaryReport(selectAll.all()));
});

app.post('/api/trades', async (req, res, next) => {
  try {
    const patch = normalise(req.body || {}, { requireBorrow: true });
    // Built over both lists before the INSERT names them, or better-sqlite3
    // refuses the statement for a parameter it was never handed.
    const row = Object.fromEntries([...FIELDS, ...FX_COLUMNS].map((f) => [f, patch[f] ?? null]));
    checkChronology(row);
    Object.assign(row, await fillFxColumns(row));

    const now = new Date().toISOString();
    const cols = [...FIELDS, ...FX_COLUMNS, 'created_at', 'updated_at'];
    const stmt = prepare(
      `INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    );
    const info = stmt.run({ ...row, created_at: now, updated_at: now });
    res.status(201).json(withDerived(selectOne.get(info.lastInsertRowid)));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/trades/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // Validate the body before queueing, so a bad request is refused at once
    // rather than after waiting behind someone else's rate lookup.
    const patch = normalise(req.body || {}, { requireBorrow: false });

    const row = await withTradeLock(id, async () => {
      // Read inside the lock: anything queued ahead of us has finished writing.
      const current = selectOne.get(id);
      if (!current) return null;
      if (Object.keys(patch).length === 0) return current;

      const merged = { ...current, ...patch };
      checkChronology(merged);

      // An edit can invalidate a rate that was right when it was stored. Clear
      // those first, then look up replacements, so the write carries the change
      // and its consequences in one statement rather than two.
      const stale = staleFxColumns(current, patch);
      Object.assign(merged, stale);
      const fresh = await fillFxColumns(merged);

      const write = { ...patch, ...stale, ...fresh };
      const keys = Object.keys(write);

      prepare(
        `UPDATE trades SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`,
      ).run({ ...write, updated_at: new Date().toISOString(), id: current.id });

      return selectOne.get(current.id);
    });

    if (!row) return res.status(404).json({ error: 'Trade not found.' });
    res.json(withDerived(row));
  } catch (err) {
    next(err);
  }
});

/*
 * The rate endpoints answer 200 even when they could not reach anything. Being
 * unable to look a rate up is a result the interface is built to show, not a
 * server fault, and the browser's api() helper throws on any status that is not
 * ok, which would turn "no rate yet" into an error toast.
 */

app.get('/api/fx/rate', async (req, res, next) => {
  try {
    await rateLookup(req, res);
  } catch (err) {
    // Express 4 does not catch a rejected async handler. Without this the
    // rejection became an uncaughtException, the process exited, and the
    // request was left hanging with no response at all.
    next(err);
  }
});

async function rateLookup(req, res) {
  const currency = String(req.query.currency || '').toUpperCase();
  const date = String(req.query.date || '').trim();
  if (!CURRENCIES.includes(currency) || parseDate(date) === null) {
    return res.json({ currency, date, rate: null, reason: 'That is not a currency and date I can look up.' });
  }
  const hit = await resolveRate(currency, date);
  if (!hit) {
    const status = fxStatus();
    return res.json({
      currency, date, rate: null,
      reason: status.offline
        ? 'Rate lookups are switched off.'
        : status.lastError || 'No rate has been published for that date yet.',
    });
  }
  res.json({ currency, date, rate: hit.rate, rateDate: hit.rateDate, source: hit.source });
}

app.get('/api/fx/status', (_req, res) => {
  const trades = selectAll.all().map(withDerived);
  const missing = trades.filter((t) => !t.derived.fxComplete);
  res.json({
    ...fxStatus(),
    missing: {
      count: missing.length,
      tradeIds: missing.map((t) => t.id),
    },
  });
});

app.post('/api/fx/backfill', async (req, res, next) => {
  try {
    res.json(await backfillRates({ refresh: req.body?.refresh === true }));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ price alerts */

/**
 * Everything the alert window needs, in one call: whether there is anywhere to
 * send a message, what ETH last cost, and every alert keyed by its trade.
 *
 * The bot token and the chat id are not in here and must never be. The browser
 * needs to know that sending works and what the group is called; it has no use
 * for the credentials, and this server answers anything that can reach
 * loopback.
 */
app.get('/api/alerts', async (req, res, next) => {
  try {
    // `refresh` asks for a price fetched now rather than whatever the last
    // sweep left behind. The window opening is the one moment that figure is
    // read by a person and compared against a goal, and on a ledger with no
    // armed alerts nothing has asked for a price in hours. Page load does not
    // send it, because a boot should not wait on an outside service.
    if (req.query.refresh === '1') await ethPrice();

    const { configured, groupName, reason } = telegramConfig();
    const quote = cachedEthPrice();
    res.json({
      config: { configured, groupName, reason },
      eth: quote
        ? { price: quote.price, fetchedAt: quote.fetchedAt, stale: quote.ageMs > alertPollMs }
        : { price: null, fetchedAt: null, stale: true, reason: ethStatus().lastError },
      alerts: allAlerts(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Set the goal price for a trade. The id is the trade's, because a trade has
 * one alert, which is also why this is a PUT: saving the same goal twice is
 * the same ledger either way.
 */
app.put('/api/alerts/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const trade = selectOne.get(id);
    if (!trade) return res.status(404).json({ error: 'Trade not found.' });

    if (derive(trade).status !== STATUS.HOLDING) {
      throw new BadRequest('A price alert only applies while the ETH is held.', 'goal_price');
    }

    // The same parser the browser uses, so "3,000" cannot mean one thing in
    // the form and another here.
    const goal = toNumber(req.body?.goal_price, 'goal_price', 'ETH goal price');
    if (goal > 1_000_000) {
      throw new BadRequest('That looks like a slipped digit. The price is in dollars.', 'goal_price');
    }

    // Before the save, not after: the direction is decided from this price, so
    // a goal set while the last quote is hours old would be read against the
    // wrong side of the market. `ethPrice` never throws and falls back to the
    // cache, so an unreachable service costs a moment and nothing else.
    const quote = await ethPrice();

    res.json(saveAlert(trade, goal, quote?.price ?? null));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/alerts/:id', (req, res) => {
  if (!deleteAlert(Number(req.params.id))) {
    return res.status(404).json({ error: 'No alert on that trade.' });
  }
  res.status(204).end();
});

/*
 * A dry run. Proving the token and the chat id are right by waiting for ETH to
 * move is no way to find out they are wrong, so this sends one message now.
 *
 * It answers 200 even when the send fails, for the same reason the rate
 * endpoints above do: "Telegram would not take it" is a result this interface
 * is built to show, not a fault in this server.
 */
let lastTestAt = 0;
const TEST_EVERY_MS = 10_000;

app.post('/api/alerts/test', async (req, res, next) => {
  try {
    const since = Date.now() - lastTestAt;
    if (since < TEST_EVERY_MS) {
      return res.json({ ok: false, error: 'Give it a few seconds before testing again.' });
    }
    lastTestAt = Date.now();

    const { groupName } = telegramConfig();
    const sent = await sendTelegramMessage(
      `Test message from the Aave Loop ledger. Price alerts will arrive here, in ${groupName}.`,
    );
    res.json({ ok: sent.ok, error: sent.error });
  } catch (err) {
    next(err);
  }
});

/**
 * The message a goal would send, shown in the window while it is being typed.
 *
 * Takes the goal as a query rather than reading a saved alert, because the
 * moment it is most worth reading is before anything has been saved. Answers
 * 200 with a null text when the goal is not a number yet, since a half typed
 * figure is an ordinary state of a form and not an error.
 */
app.get('/api/alerts/:id/preview', (req, res) => {
  const id = Number(req.params.id);
  const trade = selectOne.get(id);
  if (!trade) return res.status(404).json({ error: 'Trade not found.' });

  const goal = parseAmount(req.query.goal);
  if (goal === null || goal <= 0) return res.json({ text: null });

  // The live price only settles which way the alert reads; the message itself
  // is written at the goal, because that is the position it will describe when
  // it goes out. Quoting today's price in it read as a contradiction.
  res.json({ text: previewMessage(trade, goal, cachedEthPrice()?.price ?? null) });
});

app.delete('/api/trades/:id', (req, res) => {
  const info = prepare('DELETE FROM trades WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Trade not found.' });
  res.status(204).end();
});

/**
 * Anything reaching here matched no route and no file on disk.
 *
 * An API caller gets JSON, because every other answer from /api is JSON and
 * handing a client an HTML page is a confusing way to say "no such path". A
 * browser gets the same page nginx serves for a missing public file, so the two
 * layers agree on what a missing page looks like.
 *
 * This sits after every route and before the error handler below on purpose.
 * Earlier and it would answer for the static mounts before they could; after
 * the error handler and it would never run at all, since Express dispatches a
 * four argument handler only when something has thrown.
 */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'No such endpoint.' });
  }
  res.status(404).sendFile(path.join(root, 'landing', '404.html'), (err) => {
    // The page is part of the repo, so a failure here means a broken checkout
    // rather than a bad request. Fall back to something rather than hanging.
    if (err) next(err);
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof BadRequest) {
    return res.status(400).json({ error: err.message, field: err.field });
  }
  // express.json() rejects unparseable bodies with a SyntaxError.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'That request body was not valid JSON.' });
  }
  // An oversized body is the caller's problem, not a server fault.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request body was too large.' });
  }
  // A second instance on the same file held the write lock for longer than the
  // busy timeout. Reporting that as a 500 read as data loss.
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY')) {
    return res.status(503).json({
      error: 'The ledger is busy, probably a second copy of the app writing to it. Try again.',
    });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Loopback only. This is a personal ledger with no authentication, so it has
// no business being reachable from the rest of the network.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Aave Loop v${pkg.version} running at http://localhost:${PORT}`);
  // Started here rather than at import, so the port being taken below cannot
  // leave a poller running in a process that is on its way out.
  reportConfig();
  startAlertPoller();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try ./run_myAave.sh, which picks a free one.`);
  } else {
    console.error(err);
  }
  stopAlertPoller();
  closeDb();
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down.`);
  // Before the database closes, or a tick landing mid-shutdown finds the
  // connection gone.
  stopAlertPoller();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Do not let a hung connection hold the database open indefinitely.
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
process.on('uncaughtException', (err) => {
  console.error(err);
  stopAlertPoller();
  closeDb();
  process.exit(1);
});
