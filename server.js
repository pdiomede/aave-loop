import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, prepare, closeDb, FIELDS } from './db.js';
import { derive, summaryReport, parseDate, CURRENCIES } from './lib/calc.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
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

const isBlank = (v) => v === undefined || v === null || v === '';

const REQUIRED_BORROW = [
  ['borrow_date', 'Borrow date'],
  ['borrow_amount', 'Borrow amount'],
  ['borrow_currency', 'Currency'],
  ['borrow_apr', 'Borrow APR'],
];

function toNumber(value, field, label, { allowZero = false } = {}) {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s$%]/g, '')) : Number(value);
  if (!Number.isFinite(n)) throw new BadRequest(`${label} must be a number.`, field);
  if (allowZero ? n < 0 : n <= 0) {
    throw new BadRequest(
      `${label} must be ${allowZero ? 'zero or more' : 'greater than zero'}.`,
      field,
    );
  }
  return n;
}

// One day of slack, because the client's calendar may be a timezone ahead.
const FUTURE_SLACK_MS = 36 * 60 * 60 * 1000;

function toDate(value, field, label) {
  const iso = String(value).trim();
  const ts = parseDate(iso);
  if (ts === null) throw new BadRequest(`${label} must be a valid date.`, field);
  if (ts > Date.now() + FUTURE_SLACK_MS) {
    // A future date yields a negative loan span, which quietly suppressed the
    // interest and the annualized return rather than reporting anything.
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
    if (!CURRENCIES.includes(c)) throw new BadRequest('Pick a supported stablecoin.', 'borrow_currency');
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

const selectAll = prepare('SELECT * FROM trades ORDER BY borrow_date DESC, id DESC');
const selectOne = prepare('SELECT * FROM trades WHERE id = ?');

/* ------------------------------------------------------------------ routes */

// Browsers ask for this even when the page names its icon explicitly.
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/aaveLogo.png'));

app.get('/api/version', (_req, res) => res.json({ version: pkg.version }));

app.get('/api/trades', (_req, res) => {
  res.json(selectAll.all().map(withDerived));
});

app.get('/api/summary', (_req, res) => {
  res.json(summaryReport(selectAll.all()));
});

app.post('/api/trades', (req, res, next) => {
  try {
    const patch = normalise(req.body || {}, { requireBorrow: true });
    const row = Object.fromEntries(FIELDS.map((f) => [f, patch[f] ?? null]));
    checkChronology(row);

    const now = new Date().toISOString();
    const cols = [...FIELDS, 'created_at', 'updated_at'];
    const stmt = prepare(
      `INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    );
    const info = stmt.run({ ...row, created_at: now, updated_at: now });
    res.status(201).json(withDerived(selectOne.get(info.lastInsertRowid)));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/trades/:id', (req, res, next) => {
  try {
    const current = selectOne.get(Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Trade not found.' });

    const patch = normalise(req.body || {}, { requireBorrow: false });
    const keys = Object.keys(patch);
    if (keys.length === 0) return res.json(withDerived(current));

    checkChronology({ ...current, ...patch });

    prepare(
      `UPDATE trades SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`,
    ).run({ ...patch, updated_at: new Date().toISOString(), id: current.id });

    res.json(withDerived(selectOne.get(current.id)));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/trades/:id', (req, res) => {
  const info = prepare('DELETE FROM trades WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Trade not found.' });
  res.status(204).end();
});

app.use((err, _req, res, _next) => {
  if (err instanceof BadRequest) {
    return res.status(400).json({ error: err.message, field: err.field });
  }
  // express.json() rejects unparseable bodies with a SyntaxError.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'That request body was not valid JSON.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Loopback only. This is a personal ledger with no authentication, so it has
// no business being reachable from the rest of the network.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Aave Loop Ledger v${pkg.version} running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try ./run_myAave.sh, which picks a free one.`);
  } else {
    console.error(err);
  }
  closeDb();
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down.`);
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
  closeDb();
  process.exit(1);
});
