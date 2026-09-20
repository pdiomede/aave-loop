import {
  derive,
  summarize,
  summaryReport,
  accruedInterest,
  daysBetween,
  todayISO,
  parseAmount,
  normaliseAmountText,
  CURRENCIES,
  FX_STAGES,
  isUsdPegged,
} from '/lib/calc.js';

/* ------------------------------------------------------------- formatters */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Money is always shown to the cent and ETH always to four places, so that
// columns line up and a rounded figure never hides a real difference.
const USD_DP = 2;
const ETH_DP = 4;

function amount(v, dp) {
  return Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function usd(v, digits = USD_DP) {
  if (!isNum(v)) return '';
  return `${v < 0 ? '-' : ''}$${amount(v, digits)}`;
}

function signedUsd(v) {
  if (!isNum(v)) return '';
  return `${v >= 0 ? '+' : '-'}$${amount(v, USD_DP)}`;
}

/**
 * A stablecoin amount carries its own ticker instead of a dollar sign. The
 * cards are all denominated in the coin that was borrowed, so "32,000.00 USDT"
 * reads in one line. Prices stay in dollars, since ETH is quoted in dollars.
 */
function money(v, currency) {
  if (!isNum(v)) return '';
  return `${v < 0 ? '-' : ''}${amount(v, USD_DP)} ${currency}`;
}

function signedMoney(v, currency) {
  if (!isNum(v)) return '';
  return `${v >= 0 ? '+' : '-'}${amount(v, USD_DP)} ${currency}`;
}

function ethQty(v) {
  return isNum(v) ? amount(v, ETH_DP) : '';
}

function eth(v) {
  return isNum(v) ? `${ethQty(v)} ETH` : '';
}

function pct(v, digits = 2) {
  if (!isNum(v)) return '';
  return `${v.toFixed(digits)}%`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  // Escaped, because every caller drops the result straight into innerHTML and
  // one of the dates it formats is the rate publication day, which arrives
  // from outside the app.
  return esc(`${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`);
}

/**
 * The calendar day an ISO instant fell on, locally.
 *
 * `created_at` is stored as a UTC instant while every other date in the ledger
 * is a calendar day on the local clock, the one `todayISO` settled on. Slicing
 * the instant named the wrong day for anyone whose clock is not UTC: a trade
 * added at 00:09 in Berlin was stamped as added the day before.
 */
function localDay(instant) {
  const t = instant ? new Date(instant) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  const mo = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${t.getFullYear()}-${mo}-${d}`;
}

/**
 * The local wall clock time of an ISO instant, to the minute.
 *
 * `fired_at` is stored in UTC like `created_at`, so slicing the string prints
 * the wrong hour for everyone whose clock is not UTC - the same trap `localDay`
 * above exists for.
 */
function localTime(instant) {
  const t = instant ? new Date(instant) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const gainClass = (v) => (!isNum(v) ? '' : v >= 0 ? 'pos' : 'neg');

/**
 * The marker that carries an explanation. A real button, so the sentence can be
 * reached by keyboard and by tap, neither of which a native title allowed. It
 * does nothing when pressed: CSS draws the bubble from data-tip, which is the
 * whole point, since a title waits a second before it appears.
 *
 * aria-label repeats the sentence because the visible glyph is only a question
 * mark, which tells a screen reader nothing.
 */
const hintMark = (tip) =>
  tip ? ` <button type="button" class="kv__hint" data-tip="${esc(tip)}" aria-label="${esc(tip)}">?</button>` : '';

/**
 * A column header that can be asked what it means. The trigger is the header
 * itself rather than a marker beside it, because a question mark on all ten
 * columns doubles the weight of a row that is meant to be scanned.
 *
 * Sighted hover only, exactly like the title it replaces. Exposing it to a
 * screen reader would fold the sentence into the column header's accessible
 * name and have it read out against every cell in the column.
 */
const hintHead = (label, tip, cls = '') =>
  `<th${cls ? ` class="${cls}"` : ''} data-tip="${esc(tip)}"><span class="th-tip">${label}</span></th>`;

/**
 * Every explanation in the Summary, in one place, so the wording can be checked
 * against lib/calc.js rather than against the label sitting above it.
 *
 * Each one says which trades it counts. That is the detail that makes two
 * correct figures look inconsistent when it quietly differs between them, and
 * it is what sent this ledger looking for math bugs that were not there.
 */
const TIPS = {
  netGain:
    'What the repaid trades made once the loan was settled: the ETH sale less the purchase, ' +
    'less what the loan cost. A closed trade still waiting on an exchange rate is left out ' +
    'rather than counted as zero.',
  avgPct:
    'The return on the capital actually deployed, weighted by how much and for how long. ' +
    'Not the average of the percentages in the table: a one day flip would otherwise ' +
    'count as heavily as a trade held for months.',
  interestPaid:
    'Interest on the closed loans only, each converted at the rate published for the day it ' +
    'was repaid. Interest still accruing on an open loan is not in here.',
  currencyEffect:
    'The other half of what the loan cost: the principal revalued between the day you ' +
    'borrowed and the day you repaid. A negative figure means the currency moved your way ' +
    'and the loan cost less than the interest alone. Always zero on a dollar loan.',
  winRate:
    'The share of closed trades that finished above water, counted only where the dollar ' +
    'result is known. A trade that came out exactly flat counts as neither a win nor a loss.',
  totalBorrowed:
    'Everything ever borrowed, open trades included, each loan valued at the rate on its own ' +
    'borrow date. A running total, not the amount currently at risk. A trade still waiting on ' +
    'a rate is left out, the same as everywhere else on this card.',
  avgHold:
    'Mean days from borrowing to repaying, over the same closed trades the figures above are ' +
    'built from.',
  best: 'Ranked by dollars made, not by the annualized rate.',
  worst: 'Ranked by dollars, not by the annualized rate.',
  cur: {
    currency:
      'The stablecoin the loan was denominated in. A trade is grouped by what you borrowed, ' +
      'not by what you bought.',
    closed: 'Trades in this currency that have been repaid.',
    open: 'Trades in this currency still running, whether the ETH has been bought, sold or neither.',
    borrowed:
      'Everything borrowed in this currency, open and closed, in dollars at the rate on each ' +
      'borrow date. The line beneath is the same total in the currency itself.',
    netGain: 'The dollar result of the closed trades in this currency. Open trades contribute nothing.',
    avgPct:
      'The closed trades in this currency blended together, weighted by loan size and days ' +
      'held, the same way the headline rate is.',
  },
  month: {
    month:
      'The month the loan was repaid, which is when the gain became real. A trade opened in ' +
      'March and closed in May lands in May.',
    trades: 'Closed trades that landed in this month.',
    netGain: 'The dollar result of the trades closed in this month.',
    share:
      'The result for this month against the largest month in the table, so the bars can be ' +
      'compared at a glance.',
  },
  noRate: 'No exchange rate for this date yet. Use Fetch rates on the Summary.',
  alerts: {
    trade: 'The trade the goal was set on. A trade can appear more than once: an alert is kept after it fires, so setting a new goal adds a row rather than replacing one.',
    goal: 'The ETH price the alert is waiting for, in dollars.',
    direction:
      'Settled when the alert was saved, against what ETH cost at that moment rather than what you paid for it. A goal above the price then is one it has to rise to; below, one it has to fall to.',
    status:
      'ARMED is still being watched. FIRED means the goal was reached. FAILED means the message could not be delivered after three attempts. A FIRED row can also carry a "not sent" note, which means the goal was reached but Telegram refused the message.',
    set: 'The day the goal was saved.',
    firedAt: 'When the goal was reached, and the price it was reached at. Blank while an alert is still armed.',
  },
};

// Artwork for the stablecoins we have it for. The rest fall back to a
// tinted circle carrying the ticker.
const COIN_ART = {
  USDC: '/usdc.svg',
  USDT: '/usdt.svg',
  DAI: '/dai.svg',
  GHO: '/gho.svg',
  EURC: '/eurc.svg',
};

function coin(currency) {
  const art = COIN_ART[currency];
  return art
    ? `<img class="coin coin--art" src="${art}" alt="${esc(currency)}" width="26" height="26" />`
    : `<span class="coin coin--${esc(currency)}">${esc(currency)}</span>`;
}

/**
 * A trade in a coin that is not a dollar carries its amount twice: what was
 * actually borrowed or spent, and what that was worth in dollars on the day.
 * The rate and the day it was published are stated alongside, because a
 * converted figure nobody can check against the ECB's own tables is worse than
 * no figure at all. On a weekend the published day is the Friday before, which
 * is why it is shown rather than assumed to be the transaction date.
 */
/*
 * The dollar figure and the rate that produced it are two separate facts, and
 * on a card a quarter of the page wide they do not fit on one line. Each gets
 * its own, which also puts the provenance directly under the number it
 * explains rather than trailing off the edge of the card.
 */
function fxNote(usdValue, leg) {
  if (!isNum(usdValue)) return RATE_MISSING;
  const at = leg && isNum(leg.rate) ? `<span class="fx-note__rate">at ${leg.rate.toFixed(4)}${
    leg.date ? ` on ${fmtDate(leg.date)}` : ''
  }</span>` : '';
  return `<span class="fx-note__usd">${usd(usdValue)}</span>${at}`;
}

function signedFxNote(usdValue, leg) {
  if (!isNum(usdValue)) return RATE_MISSING;
  const at = leg && isNum(leg.rate) ? `<span class="fx-note__rate">at ${leg.rate.toFixed(4)}</span>` : '';
  return `<span class="fx-note__usd">${signedUsd(usdValue)}</span>${at}`;
}

const RATE_MISSING = `<span class="chip chip--warn" data-tip="${esc(TIPS.noRate)}">no rate</span>`;

const ethMark = `<img class="eth-mark" src="/eth.svg" alt="" width="15" height="15" />`;

/* ------------------------------------------------------- sorting + paging */

const PAGE_SIZE = 15;
const SORT_KEY = 'myaave-sort';

// Newest borrow date first, which is the order the server already sends and
// therefore what the table showed before it could be sorted at all.
const DEFAULT_SORT = { key: 'trade', dir: 'desc' };

const STATUS_ORDER = { OPEN: 0, HOLDING: 1, SOLD: 2, CLOSED: 3 };

/**
 * What each column sorts on.
 *
 * Net gain reads the same figure the cell shows, the projection included, not
 * just the realized one. Sorting a column by a number other than the one on
 * screen looks like a bug even when the ordering is correct.
 */
const SORT_KEYS = {
  trade: (t) => t.borrow_date,
  eth: (t) => t.buy_eth,
  buy: (t, d) => d.buyPriceUsd,
  sell: (t, d) => d.sellPriceUsd,
  days: (t, d) => d.days,
  gain: (t, d) => (isNum(d.netGainUsd) ? d.netGainUsd : d.projectedNetGainUsd),
  pct: (t, d) => d.pct,
  status: (t, d) => STATUS_ORDER[d.status],
};

const SORT_LABELS = {
  trade: 'Trade date',
  eth: 'ETH',
  buy: 'Buy price',
  sell: 'Sell price',
  days: 'Days',
  gain: 'Net gain',
  pct: 'Annualized',
  status: 'Status',
};

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (saved && SORT_KEYS[saved.key] && (saved.dir === 'asc' || saved.dir === 'desc')) {
      return saved;
    }
  } catch (e) {
    /* private browsing, or something else wrote nonsense to the key */
  }
  return { ...DEFAULT_SORT };
}

function saveSort() {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(state.sort));
  } catch (e) {
    /* the sort simply will not persist */
  }
}

/**
 * The trades in the order the table should show them.
 *
 * Works on a copy: state.trades stays exactly as the server sent it, because
 * summarize() and summaryReport() read it whole for the hero tiles and the
 * Summary view, and neither should notice this feature exists.
 *
 * A row with no value for the column sorts last in BOTH directions. Ascending
 * by net gain should not fill the first page with open trades that have no gain
 * to rank; they belong at the end either way.
 */
function sortedTrades() {
  const { key, dir } = state.sort;
  const read = SORT_KEYS[key] || SORT_KEYS.trade;
  const value = (t) => {
    const v = read(t, t.derived || derive(t));
    return v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))
      ? null
      : v;
  };

  return [...state.trades].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return b.id - a.id;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === 'string' ? (va < vb ? -1 : va > vb ? 1 : 0) : va - vb;
    // Ties break on id so the order is stable and a re-render never reshuffles
    // rows that compare equal.
    return cmp === 0 ? b.id - a.id : dir === 'asc' ? cmp : -cmp;
  });
}

const pageCount = (total) => Math.max(1, Math.ceil(total / PAGE_SIZE));

/**
 * The page a given trade currently falls on. Creating a trade opens it, and
 * under any sort but the default it may not be on the page being looked at, so
 * the row would expand somewhere the user cannot see.
 */
function pageOfTrade(id) {
  const i = sortedTrades().findIndex((t) => t.id === id);
  return i < 0 ? state.page : Math.floor(i / PAGE_SIZE) + 1;
}

/**
 * Two tables paginate now, and they sit on different views. The markup is
 * shared verbatim; only which counter it reads and what it scrolls back to
 * differ, so those are the two things named here.
 */
const PAGERS = {
  trades: { key: 'page', mount: 'table-mount', label: 'Trade pages' },
  alerts: { key: 'alertsPage', mount: 'alerts-mount', label: 'Alert pages' },
};

const pageOf = (scope) => state[PAGERS[scope].key];
const setPage = (scope, n) => {
  state[PAGERS[scope].key] = n;
};

/** Keep the page inside the range, so deleting the last row of the last page
 *  lands on the one before it rather than on an empty table. */
function clampPage(total, scope = 'trades') {
  setPage(scope, Math.min(Math.max(1, pageOf(scope)), pageCount(total)));
  return pageOf(scope);
}

/**
 * Which page numbers to draw. Beyond seven pages it keeps the first, the last
 * and the current with one either side, so the pager can never wrap onto a
 * second row however long the ledger gets.
 */
function pageItems(pages, current) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(pages - 1, current + 1);
  if (from > 2) out.push('gap');
  for (let i = from; i <= to; i += 1) out.push(i);
  if (to < pages - 1) out.push('gap');
  out.push(pages);
  return out;
}

function pager(total, scope = 'trades') {
  const pages = pageCount(total);
  // Nothing appears until the table is actually long enough to need it.
  if (pages <= 1) return '';
  const current = pageOf(scope);
  const step = (to, label, glyph, disabled) =>
    `<button class="pager__btn" type="button" data-page="${to}" data-page-scope="${scope}" aria-label="${label}"${
      disabled ? ' disabled' : ''
    }>${glyph}</button>`;

  const numbers = pageItems(pages, current)
    .map((n) =>
      n === 'gap'
        ? '<span class="pager__gap" aria-hidden="true">&hellip;</span>'
        : `<button class="pager__btn ${n === current ? 'is-active' : ''}" type="button" data-page="${n}" data-page-scope="${scope}" aria-label="Page ${n}"${
            n === current ? ' aria-current="page"' : ''
          }>${n}</button>`,
    )
    .join('');

  const first = (current - 1) * PAGE_SIZE + 1;
  const last = Math.min(current * PAGE_SIZE, total);

  return `<nav class="pager" aria-label="${PAGERS[scope].label}">
    <span class="pager__count">${first}-${last} of ${total}</span>
    <span class="pager__nums">
      ${step(current - 1, 'Previous page', '&lsaquo;', current === 1)}
      ${numbers}
      ${step(current + 1, 'Next page', '&rsaquo;', current === pages)}
    </span>
  </nav>`;
}

/** A column header that can be clicked or tabbed to. */
function sortHeader(key, extraClass = '') {
  const active = state.sort.key === key;
  const aria = active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th class="${extraClass}" aria-sort="${aria}">
    <button class="th-sort ${active ? 'is-active' : ''}" type="button" data-sort="${key}">
      ${SORT_LABELS[key]}<span class="th-sort__caret" aria-hidden="true"></span>
    </button>
  </th>`;
}

/**
 * Below 760px the table becomes cards and the header row is hidden, so the
 * sort buttons are unreachable. A plain select stands in for them there.
 */
function sortControl() {
  const opts = Object.keys(SORT_KEYS)
    .map((k) => `<option value="${k}"${k === state.sort.key ? ' selected' : ''}>${SORT_LABELS[k]}</option>`)
    .join('');
  return `<div class="sortbar">
    <label class="sortbar__label" for="sort-by">Sort by</label>
    <div class="control control--select"><select id="sort-by" data-sort-select>${opts}</select></div>
    <button class="btn btn--sm" type="button" data-sort-dir aria-label="Reverse sort order">
      ${state.sort.dir === 'asc' ? '&uarr; Ascending' : '&darr; Descending'}
    </button>
  </div>`;
}

/** Switching column starts descending, which is the useful way round for money
 *  and for dates. Clicking the column already sorted flips it. */
function applySort(key) {
  if (!SORT_KEYS[key]) return;
  state.sort =
    state.sort.key === key
      ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'desc' };
  saveSort();
  // A half filled stage form whose row may have just moved to another page is
  // a draft with nowhere to go, so the editor closes rather than stranding it.
  state.editing = null;
  state.page = 1;
  render();
}

/* ------------------------------------------------------------------ state */

const state = {
  view: 'trades',
  draft: null,
  trades: [],
  openId: null,
  editing: null, // { id, stage }
  creating: false,
  // The column is remembered between visits, the page deliberately is not:
  // coming back to a ledger you have not looked at today and landing on page 4
  // of it is disorienting.
  sort: loadSort(),
  page: 1,
  // Price alerts, keyed by trade id, plus what the server knows about where an
  // alert would go and what ETH last cost. All three are fetched once at boot
  // and kept in step by the writes themselves, so a card can read them
  // synchronously while it renders.
  alerts: {},
  alertConfig: null,
  ethPrice: null,
  // Every alert ever set, for the Alerts view. Null until that view has been
  // opened once, which is what lets the table tell "not fetched yet" from
  // "there are none".
  alertLog: null,
  alertLogError: null,
  alertsPage: 1,
};

/* --------------------------------------------------------------- api calls */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    // These are live figures. Never let the browser answer from its cache, or
    // the ledger can show numbers that were already superseded.
    cache: 'no-store',
    ...options,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'Request failed.');
    err.field = body.field;
    // Carried so a caller can tell "there was nothing there" from "the request
    // did not get through", which are the same sentence otherwise.
    err.status = res.status;
    throw err;
  }
  return body;
}

// The server's `derived` block is a snapshot taken when the request was served.
// A tab left open across midnight kept showing the day count and the accrued
// interest from page load, so drop it and recompute from the shared module.
const withoutDerived = ({ derived, ...row }) => row;

/**
 * Reload the ledger, discarding a reply that is already out of date.
 *
 * Two of these can be in flight at once, and one of them can be older than
 * what is on screen: **Fetch rates** reloads the whole ledger, and a stage
 * saved while that is away answers first and writes itself into `state.trades`
 * directly. The reload was issued against the ledger as it stood before that
 * save, so letting it land put the row back the way it was and left it there
 * until the page was reloaded, with no error and nothing to suggest the save
 * had not taken. The server had it right the whole time.
 *
 * `loadSeq` drops a reply a newer load has overtaken; `writeSeq` drops one
 * that a write superseded while it was on the wire.
 */
let loadSeq = 0;
let writeSeq = 0;

async function loadTrades() {
  const seq = ++loadSeq;
  const wroteAt = writeSeq;
  const rows = (await api('/api/trades')).map(withoutDerived);
  if (seq !== loadSeq || wroteAt !== writeSeq) return false;
  state.trades = rows;
  return true;
}

/**
 * The alerts, in their own request rather than riding along on each trade row.
 *
 * `/api/trades` is fetched again after every single write, and an alert is
 * read by one card on one row; taxing every load for it would be the wrong
 * trade. The configuration and the ETH price have no home on a trade row at
 * all, and this is the only call that needs them.
 *
 * Nothing here is refetched after a save. The write answers with the alert it
 * just stored, which is put straight into `state.alerts`, so there is no
 * second reply that can arrive late and undo it.
 */
async function loadAlerts({ refresh = false } = {}) {
  const body = await api(`/api/alerts${refresh ? '?refresh=1' : ''}`);
  state.alerts = body.alerts || {};
  state.alertConfig = body.config || null;
  state.ethPrice = body.eth || null;
}

/**
 * The whole log, for the Alerts view. Its own call: `/api/alerts` is fetched at
 * boot and every time the alert window opens, and with `refresh` it goes to the
 * price service - which a table of past alerts has no business triggering.
 *
 * Guarded the same way `loadTrades` is, and for the same reason. This runs on
 * every visit to the view, so one of these is in flight for as long as the
 * round trip takes, and a delete landing inside that window was undone by the
 * reply: the row came back on screen, deleted from the database, and pressing
 * Delete on it again answered 404 - which this app reads as "already gone" and
 * reports as a second successful removal.
 */
let alertLogSeq = 0;
let alertWriteSeq = 0;

async function loadAlertLog() {
  const seq = ++alertLogSeq;
  const wroteAt = alertWriteSeq;
  try {
    const rows = (await api('/api/alerts/log')).alerts || [];
    // Overtaken by a newer load, or superseded by a write made while this was
    // on the wire. Either way this answer describes a list that no longer is.
    if (seq !== alertLogSeq || wroteAt !== alertWriteSeq) return;
    state.alertLog = rows;
    state.alertLogError = null;
  } catch (err) {
    // Whatever was on screen is left there. A refresh that could not get
    // through should not blank a table that is still true.
    if (seq !== alertLogSeq) return;
    state.alertLogError = err.message || 'Could not reach the server.';
  }
}

/* ----------------------------------------------------- input and validation */

// Ethereum's genesis block. Nothing in this ledger can predate it.
const EARLIEST_DATE = '2015-07-30';

/**
 * Strip what can never belong in a number, as the user types.
 *
 * A pasted amount arrives complete, so a European decimal comma can be read
 * for what it is: gutting "32.000,00" down to "32.00000" recorded a 32,000
 * loan as 32. A comma typed one keystroke at a time cannot be read that way,
 * because "1,5" on its way to "1,500" would become 1.5, so typing keeps the
 * old behaviour of dropping the separator.
 */
function sanitizeNumeric(text, { pasted = false } = {}) {
  const start = pasted ? normaliseAmountText(String(text ?? '')) : String(text ?? '');
  let out = start.replace(/[^0-9.]/g, '');
  const firstDot = out.indexOf('.');
  if (firstDot !== -1) {
    out = out.slice(0, firstDot + 1) + out.slice(firstDot + 1).replace(/\./g, '');
  }
  return out;
}

/**
 * Input types that deliver a complete value rather than one more keystroke.
 * A drop and an autofill are as whole as a paste, and only a value arriving a
 * character at a time has to keep the old behaviour, because "1,5" on its way
 * to "1,500" cannot be read as a decimal comma. Dropping "32.000,00" into an
 * amount used to record a 32,000 loan as 32.
 */
const WHOLE_VALUE_INPUT = new Set(['insertFromPaste', 'insertFromDrop', 'insertReplacementText']);

const FIELD_LABELS = {
  goal_price: 'ETH goal price',
  borrow_date: 'Borrow date',
  borrow_amount: 'Amount borrowed',
  borrow_apr: 'Borrow APR',
  buy_date: 'Purchase date',
  buy_amount: 'Amount spent',
  buy_eth: 'ETH purchased',
  sell_date: 'Sale date',
  sell_eth: 'ETH sold',
  sell_amount: 'Amount received',
  repay_date: 'Repayment date',
  repay_amount: 'Amount repaid',
};

/**
 * Check one field in the context of the trade it belongs to.
 * Returns an error string, or null when the value is acceptable.
 */
function validateField(name, raw, trade = {}) {
  const label = FIELD_LABELS[name] || name;
  const text = String(raw ?? '').trim();

  if (text === '') return `${label} is required.`;

  if (name.endsWith('_date')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${label} must be a valid date.`;
    if (text > todayISO()) return `${label} cannot be in the future.`;
    if (text < EARLIEST_DATE) return `${label} is before Ethereum existed. Check the year.`;

    const after = (other, otherLabel) =>
      trade[other] && text < trade[other] ? `${label} cannot be before the ${otherLabel}.` : null;
    // The mirror of `after`. Moving an early stage forward past a later one is
    // exactly as wrong as dragging a late stage back, but only the server
    // caught it, and its message names the stage it collided with rather than
    // the one being edited. That field is not in the form on screen, so the
    // message fell through to the form's error line with no field marked.
    const before = (other, otherLabel) =>
      trade[other] && text > trade[other] ? `${label} cannot be after the ${otherLabel}.` : null;
    if (name === 'borrow_date') {
      return before('buy_date', 'purchase') || before('sell_date', 'sale') || before('repay_date', 'repayment');
    }
    if (name === 'buy_date') {
      return after('borrow_date', 'borrow') || before('sell_date', 'sale') || before('repay_date', 'repayment');
    }
    if (name === 'sell_date') {
      return (
        after('buy_date', 'purchase') || after('borrow_date', 'borrow') || before('repay_date', 'repayment')
      );
    }
    if (name === 'repay_date') return after('sell_date', 'sale') || after('borrow_date', 'borrow');
    return null;
  }

  const value = parseAmount(text);
  if (value === null) return `${label} must be a number.`;

  if (name === 'borrow_apr') {
    if (value < 0) return 'APR cannot be negative.';
    if (value > 100) return 'APR looks too high. Enter it as a percent, for example 4.27.';
    return null;
  }

  if (value <= 0) return `${label} must be greater than zero.`;

  // Matched to the server's own ceiling, so a slipped digit is caught here
  // rather than after a round trip.
  if (name === 'goal_price') {
    return value > 1_000_000 ? 'That looks like a slipped digit. The price is in dollars.' : null;
  }

  if (name === 'sell_eth' && isNum(trade.buy_eth) && value > trade.buy_eth * 1.0001) {
    return `You only bought ${ethQty(trade.buy_eth)} ETH.`;
  }
  // The same pair from the other side: cutting the purchase below what has
  // already been sold, or the loan below what has already been repaid.
  if (name === 'buy_eth' && isNum(trade.sell_eth) && value * 1.0001 < trade.sell_eth) {
    return `You already sold ${ethQty(trade.sell_eth)} ETH.`;
  }
  if (name === 'borrow_amount' && isNum(trade.repay_amount)) {
    if (trade.repay_amount < value - 0.005) {
      return `You repaid ${amount(trade.repay_amount, USD_DP)}, which is less than this.`;
    }
    if (trade.repay_amount > value * 2) {
      return `You repaid ${amount(trade.repay_amount, USD_DP)}, more than double this.`;
    }
  }
  if (name === 'repay_amount' && isNum(trade.borrow_amount)) {
    if (value < trade.borrow_amount - 0.005) {
      return `A repayment cannot be less than the ${amount(trade.borrow_amount, USD_DP)} borrowed.`;
    }
    if (value > trade.borrow_amount * 2) {
      return `That is a long way above the ${amount(trade.borrow_amount, USD_DP)} borrowed.`;
    }
  }
  return null;
}

/* -------------------------------------------------------- field rendering */

/**
 * One rounded field. Everything the user types into goes through here so the
 * styling and the hint slot stay identical across the four stage forms.
 */
function field({
  name,
  label,
  type = 'text',
  value = '',
  prefix = '',
  suffix = '',
  step = 'any',
  placeholder = '',
  hint = '',
  options = null,
  autofocus = false,
  auto = false,
}) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  let control;

  if (options) {
    const opts = options
      .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`)
      .join('');
    control = `<div class="control control--select"><select id="${id}" name="${name}">${opts}</select></div>`;
  } else {
    const cls = ['control', prefix && 'control--prefix', suffix && 'control--suffix']
      .filter(Boolean)
      .join(' ');

    // Numbers are collected as text with a decimal keypad rather than
    // type="number". A number input silently throws away anything it cannot
    // parse, so pasting "12,000" or "$12000" straight out of a wallet left the
    // field blank with no explanation. As text we keep what was typed, tidy it
    // up, and say what is wrong.
    const isNumeric = type === 'number';
    const attrs = isNumeric
      ? `type="text" inputmode="decimal" data-numeric="1"`
      : `type="${type}"${type === 'date' ? ` min="${EARLIEST_DATE}" max="${todayISO()}"` : ''}`;

    control = `<div class="${cls}">
      ${prefix ? `<span class="control__prefix">${esc(prefix)}</span>` : ''}
      <input id="${id}" name="${name}" ${attrs} value="${esc(value)}"
        placeholder="${esc(placeholder)}" ${autofocus ? 'autofocus' : ''}
        ${auto ? 'data-auto="1"' : ''} autocomplete="off" spellcheck="false" />
      ${suffix ? `<span class="control__suffix">${esc(suffix)}</span>` : ''}
    </div>`;
  }

  return `<div class="field" data-field="${name}">
    <label class="field__label" for="${id}">${esc(label)}</label>
    ${control}
    <div class="field__hint" data-hint="${name}">${hint}</div>
  </div>`;
}

const actions = (submitLabel, cancelAttr) => `
  <div class="form__actions">
    <span class="form__error" data-form-error></span>
    <button class="btn btn--ghost btn--sm" type="button" ${cancelAttr}>Cancel</button>
    <button class="btn btn--primary btn--sm" type="submit">${esc(submitLabel)}</button>
  </div>`;

/* ------------------------------------------------------------- stage forms */

// Amounts on a trade are denominated in the coin that was borrowed, so the
// fields carry that ticker rather than a dollar sign.
const unitOf = (t) => t.borrow_currency || 'USDC';

function borrowFields(t = {}) {
  return `<div class="grid">
    ${field({ name: 'borrow_date', label: 'Borrow date', type: 'date', value: t.borrow_date || todayISO(), autofocus: true })}
    ${field({ name: 'borrow_amount', label: 'Amount borrowed', type: 'number', value: t.borrow_amount ?? '', suffix: unitOf(t), placeholder: '25000' })}
    ${field({ name: 'borrow_currency', label: 'Currency', value: t.borrow_currency || 'USDC', options: CURRENCIES })}
    ${field({ name: 'borrow_apr', label: 'Borrow APR', type: 'number', value: t.borrow_apr ?? '', suffix: '%', placeholder: '4.27' })}
  </div>`;
}

function buyFields(t) {
  return `<div class="grid">
    ${field({ name: 'buy_date', label: 'Purchase date', type: 'date', value: t.buy_date || t.borrow_date, autofocus: true })}
    ${field({ name: 'buy_amount', label: 'Amount spent', type: 'number', value: t.buy_amount ?? t.borrow_amount, suffix: unitOf(t), placeholder: String(t.borrow_amount ?? '') })}
    ${field({ name: 'buy_eth', label: 'ETH purchased', type: 'number', value: t.buy_eth ?? '', suffix: 'ETH', placeholder: '8.0773' })}
  </div>`;
}

function sellFields(t) {
  return `<div class="grid">
    ${field({ name: 'sell_date', label: 'Sale date', type: 'date', value: t.sell_date || todayISO(), autofocus: true })}
    ${field({ name: 'sell_amount', label: 'Amount received', type: 'number', value: t.sell_amount ?? '', suffix: unitOf(t) })}
    ${field({ name: 'sell_eth', label: 'ETH sold', type: 'number', value: t.sell_eth ?? t.buy_eth ?? '', suffix: 'ETH' })}
  </div>`;
}

function suggestedRepayOn(t, dateISO) {
  const interest = accruedInterest(t.borrow_amount, t.borrow_apr, daysBetween(t.borrow_date, dateISO));
  return isNum(interest) ? Math.round((t.borrow_amount + interest) * 100) / 100 : '';
}

function repayFields(t) {
  // Loans are almost always repaid the day the ETH is sold, so start there.
  const date = t.repay_date || t.sell_date || todayISO();
  const amount = t.repay_amount ?? suggestedRepayOn(t, date);
  return `<div class="grid">
    ${field({ name: 'repay_date', label: 'Repayment date', type: 'date', value: date, autofocus: true })}
    ${field({
      name: 'repay_amount',
      label: 'Amount repaid',
      type: 'number',
      value: amount,
      suffix: unitOf(t),
      // Stays in step with the date until the user types their own figure.
      auto: t.repay_amount == null,
    })}
  </div>`;
}

/* ------------------------------------------------- live hints while typing */

/**
 * Recompute the helper text under the fields from whatever is currently typed,
 * merged over the saved trade. Uses the same calc module as the server.
 */
function refreshHints(form, trade, stage) {
  const data = Object.fromEntries(new FormData(form).entries());
  // An empty field means "not filled in". A typed 0 is a real value: a 0% APR
  // borrow is accepted, and treating it as absent hid the preview entirely.
  const merged = {
    ...trade,
    ...Object.fromEntries(
      Object.entries(data).map(([k, v]) => [
        k,
        k.endsWith('_date') || k === 'borrow_currency' ? v || null : parseAmount(v),
      ]),
    ),
  };
  // A rate belongs to a date. Once the form moves a stage to another day, the
  // rate stored against that stage is no longer its rate, and converting at it
  // showed a dollar figure the save would not produce: moving a repayment from
  // 17 May to 15 July left the net gain at +$1,937.36, still converted at the
  // rate published on 15 May. Dropping it is what the server does on the same
  // edit, and it makes the preview fall back to the coin with "(converted on
  // save)" underneath, which is the honest answer.
  const saved = trade || {};
  for (const s of FX_STAGES) {
    if (merged[`${s}_date`] !== saved[`${s}_date`]) {
      merged[`${s}_fx`] = null;
      merged[`${s}_fx_date`] = null;
    }
  }

  const d = derive(merged);
  const set = (name, html) => {
    // A field still flagged invalid is showing its error in this very slot.
    // Typing in a sibling field used to paint a hint over it, leaving a red
    // field explaining nothing, and the hint was computed from the value that
    // had just been rejected: a repayment of 1 against a 52,500 loan read
    // "Net gain +57,224.00". The error stays until that field is edited, at
    // which point the input handler clears it before this runs.
    const wrap = form.querySelector(`[data-field="${name}"]`);
    if (wrap && wrap.classList.contains('is-invalid')) return;
    const el = form.querySelector(`[data-hint="${name}"]`);
    if (el) el.innerHTML = html;
  };

  // Declared before the first branch that reads it. The borrow branch below
  // used `c` while the `const` still sat further down, so every keystroke in a
  // borrow form with both an amount and an APR threw a ReferenceError and the
  // interest-per-day hint never appeared at all.
  const c = unitOf(merged);

  if (stage === 'borrow') {
    const days = daysBetween(merged.borrow_date, todayISO());
    set('borrow_apr', isNum(merged.borrow_amount) && isNum(merged.borrow_apr)
      ? `About <strong>${money((merged.borrow_amount * merged.borrow_apr) / 100 / 365, c)}</strong> of interest per day`
      : '');
    set('borrow_date', isNum(days) && days > 0 ? `${days} day${days === 1 ? '' : 's'} ago` : '');
  }

  // The preview runs before anything is saved, so a brand new trade in another
  // currency has no rate on it yet. Rather than convert with a rate invented in
  // the browser, the preview stays in the coin being spent and says where the
  // dollar figure comes from. It appears as soon as the stage is saved.
  const previewPrice = (usdValue, nativeValue) =>
    isNum(usdValue) ? `<strong>${usd(usdValue)}</strong>` : `<strong>${money(nativeValue, c)}</strong>`;
  const asSaved = isUsdPegged(c) ? '' : ' <span class="muted">(converted on save)</span>';

  if (stage === 'buy') {
    set('buy_eth', isNum(d.buyPrice)
      ? `ETH price ${previewPrice(d.buyPriceUsd, d.buyPrice)}${isNum(d.buyPriceUsd) ? '' : asSaved}`
      : '');
  }

  if (stage === 'sell') {
    set('sell_amount', isNum(d.sellPrice)
      ? `ETH price ${previewPrice(d.sellPriceUsd, d.sellPrice)}${
          isNum(d.grossGain) ? `, gross ${signedMoney(d.grossGain, c)}` : ''
        }${isNum(d.sellPriceUsd) ? '' : asSaved}`
      : '');
  }

  if (stage === 'repay') {
    const amountInput = form.querySelector('input[name="repay_amount"]');
    if (amountInput && amountInput.dataset.auto === '1') {
      const fresh = suggestedRepayOn(trade, merged.repay_date);
      if (fresh !== '' && String(fresh) !== amountInput.value) {
        amountInput.value = fresh;
        merged.repay_amount = fresh;
      }
    }

    // Recompute from the shared module rather than re-deriving here. A local
    // `sell_amount - repay_amount` disagreed with what the server stored: on a
    // partial sale the preview read -4,028.77 where the saved result was
    // +971.23.
    const after = derive({ ...merged, repay_date: merged.repay_date, repay_amount: merged.repay_amount });
    const days = after.days;

    set('repay_date', isNum(days)
      ? `${days} day${days === 1 ? '' : 's'} of loan${
          isNum(after.interestPaid) ? `, interest ${money(after.interestPaid, c)}` : ''
        }`
      : '');

    set('repay_amount', isNum(after.netGain)
      ? `Net gain <strong class="${gainClass(after.netGain)}">${signedMoney(after.netGain, c)}</strong>${
          isNum(after.netGainUsd) ? ` (${signedUsd(after.netGainUsd)})` : asSaved
        }${isNum(after.pct) ? `, <strong>${pct(after.pct)}</strong> annualized` : ''}`
      : isNum(d.suggestedRepay)
        ? `Suggested ${money(d.suggestedRepay, c)} from the APR`
        : '');
  }
}

/* ---------------------------------------------------------- price alerts */

/**
 * The alert on a trade, or null. Read from the state directly rather than
 * passed down, the same way the stage cards already read `state.editing`.
 */
const alertFor = (id) => state.alerts?.[id] ?? null;

/**
 * The summary row the Bought ETH card grows once an alert is set.
 *
 * Armed only, because `state.alerts` is armed only. A fired or failed alert
 * lives in the Alerts view; the card is about what is being waited for.
 */
function alertRow(row, t) {
  const a = alertFor(t.id);
  return a ? row('Alert', `${usd(a.goalPrice)} goal`) : '';
}

const BELL_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>`;

/**
 * The bell, beside Edit on the Bought ETH card.
 *
 * Shown only while the ETH is held, which is the only time a target price is
 * a question: before the purchase there is nothing to watch and after the sale
 * there is nothing to decide. That is the same test `derive` applies to call a
 * trade HOLDING, written from the stage flags the card already has.
 */
function alertBell(t, d) {
  if (!d.stages.bought || d.stages.sold) return '';
  const a = alertFor(t.id);
  const label = a ? `Price alert at ${usd(a.goalPrice)}` : 'Set a price alert';

  return `<button class="btn btn--ghost btn--sm alert-bell ${a ? 'is-armed' : ''}" type="button"
    data-alert-trade="${t.id}" aria-label="${esc(label)}" title="${esc(label)}">${BELL_SVG}</button>`;
}

/* ------------------------------------------------------------ stage cards */

const STAGES = [
  { key: 'borrow', name: 'Borrowed', done: (s) => s.borrowed, fields: borrowFields },
  { key: 'buy', name: 'Bought ETH', done: (s) => s.bought, fields: buyFields },
  { key: 'sell', name: 'Sold ETH', done: (s) => s.sold, fields: sellFields },
  { key: 'repay', name: 'Repaid', done: (s) => s.repaid, fields: repayFields },
];

function stageSummary(stage, t, d) {
  const row = (label, value, cls = '') =>
    value === '' || value == null ? '' : `<div class="stage__row"><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;

  // The same row with the dollar equivalent underneath. A dollar coin has no
  // equivalent to state, so those cards stay exactly as they always were.
  const row2 = (label, value, sub, cls = '') => {
    if (value === '' || value == null) return '';
    const under = d.isUsdPegged || !sub ? '' : `<small class="fx-note">${sub}</small>`;
    return `<div class="stage__row"><dt>${label}</dt><dd class="${cls}">${value}${under}</dd></div>`;
  };

  // A row with a dollar figure and no native counterpart: the two parts a loan
  // cost in another currency splits into. They explain the figure above them
  // rather than standing on their own, so they are set quieter.
  const rowUsd = (label, value, cls = '') =>
    value === '' || value == null
      ? ''
      : `<div class="stage__row stage__row--sub"><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;

  // Every card puts the money on the second line, in the coin that was
  // borrowed, so the four cards can be read straight down.
  const c = t.borrow_currency;

  switch (stage) {
    case 'borrow':
      return (
        row('Date', fmtDate(t.borrow_date)) +
        row2('Amount', money(t.borrow_amount, c), fxNote(d.borrowUsd, d.fx.borrow)) +
        row('APR', pct(t.borrow_apr)) +
        row(d.stages.repaid ? 'Loan length' : 'Running for', isNum(d.days) ? `${d.days} days` : '')
      );
    case 'buy':
      return (
        row('Date', fmtDate(t.buy_date)) +
        row2('Spent', money(t.buy_amount, c), fxNote(d.buyUsd, d.fx.buy)) +
        row('Bought', eth(t.buy_eth)) +
        // ETH is quoted in dollars, so this column is converted. Dividing a
        // euro amount by a quantity of ETH gives euros per ETH, which this
        // used to print under a dollar sign.
        row('ETH price', isNum(d.buyPriceUsd) ? usd(d.buyPriceUsd) : RATE_MISSING) +
        // Only when there is one. A card that says "Alert: none" on every
        // trade nobody set one on is four words of noise per row.
        alertRow(row, t)
      );
    case 'sell':
      return (
        row('Date', fmtDate(t.sell_date)) +
        row2('Received', money(t.sell_amount, c), fxNote(d.sellUsd, d.fx.sell)) +
        row('Sold', eth(t.sell_eth)) +
        row('ETH price', isNum(d.sellPriceUsd) ? usd(d.sellPriceUsd) : RATE_MISSING) +
        (d.isPartialSale ? row2('Cost of ETH sold', money(d.costOfSoldEth, c), fxNote(d.costOfSoldEthUsd, d.fx.buy)) : '') +
        (d.isPartialSale ? row('Still held', eth(d.retainedEth)) : '') +
        // No single rate to name: the proceeds are converted at the sale's
        // rate and the cost basis at the purchase's, so quoting the sale rate
        // here invited a reader to multiply by it and get a different number.
        // Net gain and Loan cost, the other figures built from more than one
        // rate, already pass null for the same reason.
        row2('Gross gain', signedMoney(d.grossGain, c), signedFxNote(d.grossGainUsd, null), gainClass(d.grossGain))
      );
    case 'repay':
      // The interest the loan actually cost, which is what the net gain is
      // computed from. Showing the theoretical accrual here meant the card did
      // not add up: gross minus the interest shown missed the net by cents.
      //
      // For a loan in another currency the dollar cost is the interest plus
      // whatever the currency itself did to the principal, so it is labelled
      // for what it is and the two parts are shown separately.
      return (
        row('Date', fmtDate(t.repay_date)) +
        row2('Repaid', money(t.repay_amount, c), fxNote(d.repayUsd, d.fx.repay)) +
        row2(
          d.isUsdPegged ? 'Interest' : 'Loan cost',
          money(d.interestPaid ?? d.accruedInterest, c),
          fxNote(d.loanCostUsd, null),
        ) +
        // Only for a loan in another currency, and only once it is repaid. The
        // dollar cost can come out negative when the currency fell, and these
        // two rows are the whole explanation of how: crammed onto one line they
        // ran off the card, which is the one figure a reader most needs to see.
        (!d.isUsdPegged && isNum(d.principalFxUsd)
          ? rowUsd('of which interest', usd(d.interestPaidUsd)) +
            rowUsd('of which currency', signedUsd(d.principalFxUsd), gainClass(d.principalFxUsd))
          : '') +
        row2('Net gain', signedMoney(d.netGain, c), signedFxNote(d.netGainUsd, null), gainClass(d.netGain)) +
        row('Annualized', pct(d.pct), gainClass(d.netGainUsd))
      );
    default:
      return '';
  }
}

function stageCard(stage, t, d) {
  const done = stage.done(d.stages);
  const editing = state.editing && state.editing.id === t.id && state.editing.stage === stage.key;

  let body;
  if (editing) {
    body = `<form data-stage-form="${stage.key}" data-trade="${t.id}" novalidate>
      ${stage.fields(t)}
      ${actions('Save', `data-cancel-stage`)}
    </form>`;
  } else if (done) {
    body = `<dl class="stage__rows">${stageSummary(stage.key, t, d)}</dl>`;
  } else {
    body = `<p class="stage__empty">Not yet.</p>`;
  }

  const canEdit = stage.key === 'borrow' || done || prerequisiteMet(stage.key, d.stages);

  return `<article class="stage ${done ? 'is-done' : ''}">
    <header class="stage__head">
      <span class="stage__marker">&#10003;</span>
      <span class="stage__name">${stage.name}</span>
      ${
        editing || !canEdit
          ? ''
          : `<button class="btn btn--ghost btn--sm" type="button" data-edit-stage="${stage.key}" data-trade="${t.id}">${done ? 'Edit' : '+ Add'}</button>`
      }
      ${stage.key === 'buy' && !editing ? alertBell(t, d) : ''}
    </header>
    ${body}
  </article>`;
}

/** A stage only opens once the one before it is filled in. */
function prerequisiteMet(key, s) {
  if (key === 'buy') return s.borrowed;
  if (key === 'sell') return s.bought;
  if (key === 'repay') return s.sold;
  return true;
}

/* ---------------------------------------------------------- table render */

function tradeRow(t, index, total) {
  const d = t.derived || derive(t);
  const isOpen = state.openId === t.id;

  // A trade has an end date only once the loan is repaid, so that is the only
  // time a range is shown. While it is still running the borrow date stands
  // alone rather than being paired with today, which would put a date on the
  // row that nobody entered and that changes by itself overnight.
  //
  // Gated on stages.repaid rather than on repay_date being set: that flag also
  // requires a repayment amount, and it is what the rest of the app means by
  // closed, so the range can never appear on a row the table calls OPEN.
  //
  // fmtDate escapes its own output, so nothing here is escaped a second time.
  const dates = d.stages.repaid
    ? `${fmtDate(t.borrow_date)}<span class="row__arrow" aria-hidden="true">&rarr;</span>` +
      `<span class="sr-only"> to </span>${fmtDate(t.repay_date)}`
    : fmtDate(t.borrow_date);

  const gain = isNum(d.netGainUsd) ? d.netGainUsd : d.projectedNetGainUsd;
  const gainCell = isNum(gain)
    ? `<span class="${gainClass(gain)}">${signedUsd(gain)}</span>${isNum(d.netGainUsd) ? '' : ' <span class="chip">est</span>'}`
    : d.fxComplete
      ? '<span class="muted">-</span>'
      : RATE_MISSING;

  return `
  <tr class="row ${isOpen ? 'is-open' : ''}" data-trade="${t.id}" tabindex="0">
    <td data-label="Trade date">
      <div class="row__asset">
        <span class="caret"></span>
        ${coin(t.borrow_currency)}
        <span class="row__stack">
          <span>${isNum(d.borrowUsd) ? usd(d.borrowUsd) : RATE_MISSING}</span>
          ${
            // Only for a coin that is not a dollar. On a dollar stablecoin the
            // native amount and the line above it are the same number, and
            // printing it twice is noise.
            d.isUsdPegged
              ? ''
              : `<small class="row__native">${money(t.borrow_amount, t.borrow_currency)}</small>`
          }
          <small>${dates}</small>
        </span>
      </div>
    </td>
    <td data-label="ETH" class="num">${
      isNum(t.buy_eth)
        ? `<span class="eth-cell">${ethMark}${ethQty(t.buy_eth)}</span>`
        : '<span class="muted">-</span>'
    }</td>
    <td data-label="Buy price" class="num">${isNum(d.buyPriceUsd) ? usd(d.buyPriceUsd) : '<span class="muted">-</span>'}</td>
    <td data-label="Sell price" class="num">${isNum(d.sellPriceUsd) ? usd(d.sellPriceUsd) : '<span class="muted">-</span>'}</td>
    <td data-label="Days" class="num">${isNum(d.days) ? d.days : ''}</td>
    <td data-label="Net gain" class="num">${gainCell}</td>
    <td data-label="Annualized" class="num">${isNum(d.pct) ? `<span class="${gainClass(d.netGainUsd)}">${pct(d.pct)}</span>` : '<span class="muted">-</span>'}</td>
    <td data-label="Status"><span class="pill pill--${d.status}">${d.status}</span></td>
  </tr>
  ${
    isOpen
      ? `<tr class="detail"><td colspan="8">
          <div class="stages">${STAGES.map((s) => stageCard(s, t, d)).join('')}</div>
          <div class="detail__foot">
            <span class="detail__note">${
              // The id first, and the position said in words. `#N` is the
              // trade's own id everywhere else in this app - the Alerts table,
              // every Telegram message - and here it was the row's place in
              // the current sort, so one trade called itself #4, #9 or #2
              // depending on which column the table happened to be ordered by.
              `Trade #${t.id} &middot; row ${index} of ${total} &middot; added ${fmtDate(localDay(t.created_at))}`
            }</span>
            <button class="btn btn--sm btn--danger" type="button" data-delete="${t.id}">Delete trade</button>
          </div>
        </td></tr>`
      : ''
  }`;
}

/**
 * Capture what is typed into the open stage form so a re-render does not throw
 * it away. Switching to Summary and back used to silently reset the fields to
 * the stored values.
 */
function captureDraft() {
  const form = document.querySelector('[data-stage-form]');
  if (!form) return null;
  return {
    id: Number(form.dataset.trade),
    stage: form.dataset.stageForm,
    values: payloadOf(form),
    auto: !!form.querySelector('input[name="repay_amount"][data-auto="1"]'),
  };
}

function restoreDraft(draft) {
  if (!draft) return;
  const form = document.querySelector('[data-stage-form]');
  if (!form || Number(form.dataset.trade) !== draft.id || form.dataset.stageForm !== draft.stage) {
    return;
  }
  for (const [name, value] of Object.entries(draft.values)) {
    const input = form.elements[name];
    if (input && input.value !== value) input.value = value;
  }
  const repay = form.querySelector('input[name="repay_amount"]');
  if (repay && !draft.auto) delete repay.dataset.auto;
}

function renderTable() {
  const mount = document.getElementById('table-mount');

  if (state.trades.length === 0) {
    mount.innerHTML = `<div class="empty">
      <h3>No trades yet</h3>
      <p>Start with the stablecoin you borrowed on Aave, then add each stage as it happens.</p>
    </div>`;
    return;
  }

  const rows = sortedTrades();
  const total = rows.length;
  const page = clampPage(total);
  const start = (page - 1) * PAGE_SIZE;
  const shown = rows.slice(start, start + PAGE_SIZE);

  mount.innerHTML = `${sortControl()}
  <table class="table">
    <thead>
      <tr>
        ${sortHeader('trade')}${sortHeader('eth', 'num')}${sortHeader('buy', 'num')}${sortHeader('sell', 'num')}
        ${sortHeader('days', 'num')}${sortHeader('gain', 'num')}${sortHeader('pct', 'num')}${sortHeader('status')}
      </tr>
    </thead>
    <tbody>
      ${shown.map((t, i) => tradeRow(t, start + i + 1, total)).join('')}
    </tbody>
  </table>
  ${pager(total)}`;

  const openForm = mount.querySelector('[data-stage-form]');
  if (openForm) {
    restoreDraft(state.draft);
    const trade = state.trades.find((t) => t.id === Number(openForm.dataset.trade));
    refreshHints(openForm, trade, openForm.dataset.stageForm);
    // Only take focus when the form has just been opened. Stealing it on every
    // re-render pulls the caret away from whatever else is being typed in.
    if (!state.draft) openForm.querySelector('input, select')?.focus();
  }
  state.draft = null;
}

/* ---------------------------------------------------------------- summary */

const dash = '<span class="muted">-</span>';

function statRow(label, value, cls = '', hint = '') {
  return `<div class="kv">
    <dt>${label}${hintMark(hint)}</dt>
    <dd class="${cls}">${value || dash}</dd>
  </div>`;
}

/**
 * One figure on the Performance card, as a tile.
 *
 * The two figures that used to head this card, the realized gain and the
 * blended rate, are the first two tiles above the table on every view, so they
 * were being stated twice on the same screen. What is left is the six that are
 * only here, and six read better as a grid than as two columns of a list.
 */
function perfTile(label, value, cls = '', hint = '', sub = '') {
  return `<div class="perf">
    <div class="perf__label">${label}${hintMark(hint)}</div>
    <div class="perf__value ${cls}">${value || dash}</div>
    ${sub ? `<div class="perf__sub muted">${sub}</div>` : ''}
  </div>`;
}

/** The biggest gain and its opposite, in the same tile shape. */
function perfExtreme(label, entry, hint = '') {
  if (!entry) return perfTile(label, '', '', hint);
  return perfTile(
    label,
    signedUsd(entry.netGain),
    gainClass(entry.netGain),
    hint,
    `${esc(entry.currency)}, ${fmtDate(entry.date)} &middot; ${pct(entry.pct)} annualized`,
  );
}

function summaryCard(title, body, note = '') {
  return `<section class="card">
    <div class="card__head"><h3 class="card__title">${title}</h3>${
      note ? `<span class="muted">${note}</span>` : ''
    }</div>
    <div class="card__body">${body}</div>
  </section>`;
}

function currencyTable(rows) {
  if (rows.length === 0) return `<p class="muted">Nothing borrowed yet.</p>`;
  // Borrowed is shown in dollars so the rows can be compared, with the native
  // total beneath it: unlike the totals above, a native figure means something
  // here, because the table is grouped by the currency it is denominated in.
  return `<table class="table table--flush">
    <thead>
      <tr>
        ${hintHead('Currency', TIPS.cur.currency)}${hintHead('Closed', TIPS.cur.closed)}
        ${hintHead('Open', TIPS.cur.open)}${hintHead('Borrowed', TIPS.cur.borrowed)}
        ${hintHead('Net gain', TIPS.cur.netGain)}${hintHead('Avg annualized', TIPS.cur.avgPct)}
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td data-label="Currency"><span class="row__asset">${coin(r.currency)}<span>${esc(r.currency)}</span>${
          r.missingFx ? ` ${RATE_MISSING}` : ''
        }</span></td>
        <td data-label="Closed" class="num">${r.closed || dash}</td>
        <td data-label="Open" class="num">${r.open || dash}</td>
        <td data-label="Borrowed" class="num">${
          isNum(r.borrowed)
            ? `${usd(r.borrowed)}${
                isNum(r.borrowedNative) && !isUsdPegged(r.currency)
                  ? `<small class="fx-note">${money(r.borrowedNative, r.currency)}</small>`
                  : ''
              }`
            : dash
        }</td>
        <td data-label="Net gain" class="num ${gainClass(r.netGain)}">${signedUsd(r.netGain) || dash}</td>
        <td data-label="Avg annualized" class="num ${gainClass(r.netGain)}">${pct(r.avgPct) || dash}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`;
}

function monthTable(rows) {
  if (rows.length === 0) return `<p class="muted">No trades have been closed yet.</p>`;
  const peak = Math.max(...rows.map((r) => Math.abs(r.netGain)), 1);
  return `<table class="table table--flush">
    <thead>
      <tr>
        ${hintHead('Month', TIPS.month.month)}${hintHead('Trades', TIPS.month.trades)}
        ${hintHead('Net gain', TIPS.month.netGain)}${hintHead('Share', TIPS.month.share, 'bar-col')}
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td data-label="Month">${r.label}</td>
        <td data-label="Trades" class="num">${r.trades}</td>
        <td data-label="Net gain" class="num ${gainClass(r.netGain)}">${signedUsd(r.netGain)}</td>
        <td data-label="Share" class="bar-col">
          <span class="bar"><span class="bar__fill ${r.netGain >= 0 ? 'bar__fill--pos' : 'bar__fill--neg'}"
            style="width:${Math.max((Math.abs(r.netGain) / peak) * 100, 2)}%"></span></span>
        </td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`;
}

/**
 * Best and worst are ranked on the money made, not on the annualized rate: a
 * two day trade can post 800% on a small gain and would otherwise always win.
 * The label says so, because showing the rate on the same line made it look
 * like the rate was what the ranking was on.
 *
 * When every trade made money "worst" is misleading too, so it says smallest.
 */
function extremeCard(label, entry, hint = '', cls = '') {
  const kv = `kv${cls ? ` ${cls}` : ''}`;
  if (!entry) return `<div class="${kv}"><dt>${label}</dt><dd>${dash}</dd></div>`;
  return `<div class="${kv}">
    <dt>${label}${hintMark(hint)}</dt>
    <dd>
      <span class="${gainClass(entry.netGain)}">${signedUsd(entry.netGain)}</span>
      <span class="muted">${esc(entry.currency)}, ${fmtDate(entry.date)} &middot; ${pct(entry.pct)} annualized</span>
    </dd>
  </div>`;
}

/**
 * Says so out loud when some trades have no exchange rate yet, rather than
 * quietly leaving them out of the totals. The button asks the server to go and
 * look the missing rates up, which is the other half of letting a trade save
 * with the network unplugged.
 *
 * It also offers itself for a trade saved before the ECB had published, whose
 * rate is the day before's standing in until the real one is asked for. That
 * is not an omission from the totals, so it is said quietly and only while the
 * real rate could still arrive, but the button was the only thing that asks
 * and it used to appear only when something was missing outright.
 */
function fxBanner(count, provisional = 0) {
  if (!count && !provisional) return '';
  const noun = count === 1 ? 'trade has' : 'trades have';
  const message = count
    ? `${count} ${noun} no exchange rate yet, so ${
        count === 1 ? 'it is' : 'they are'
      } left out of the totals below.`
    : `${provisional} recent ${
        provisional === 1 ? 'trade is' : 'trades are'
      } converted at the rate published the day before. The ECB may have published since.`;
  return `<section class="card ${count ? 'card--warn' : ''}">
    <div class="card__body fx-banner">
      <span>${message}</span>
      <button class="btn btn--sm btn--primary" type="button" id="fetch-rates">Fetch rates</button>
    </div>
  </section>`;
}

function renderSummary() {
  const mount = document.getElementById('summary-mount');

  if (state.trades.length === 0) {
    mount.innerHTML = `<section class="card"><div class="empty">
      <h3>Nothing to summarize yet</h3>
      <p>Add a trade and the totals will build up here.</p>
    </div></section>`;
    return;
  }

  const r = summaryReport(state.trades);
  const valuedAny = r.valuedCount > 0;

  mount.innerHTML = `
    ${fxBanner(r.missingFx, r.provisionalFx)}
    ${summaryCard(
      'Performance',
      `<div class="perf-grid">
        ${perfTile('Interest paid', valuedAny ? usd(r.interestPaid) : '', '', TIPS.interestPaid)}
        ${
          // Not gated on a closed trade, unlike every other tile here. This one
          // counts open trades too - the tooltip says so, and the Borrowed
          // column below and the Open positions tile above both state the same
          // money - so on a ledger with nothing repaid yet it was the only
          // place on the screen calling that figure unknown. Shown whenever
          // some trade contributed to it; zero means no trade has a rate.
          perfTile(
            'Total borrowed',
            r.totalBorrowed > 0 ? usd(r.totalBorrowed) : '',
            '',
            TIPS.totalBorrowed,
          )
        }
        ${perfTile(
          'Win rate',
          valuedAny ? pct(r.winRate, 0) : '',
          '',
          TIPS.winRate,
          valuedAny ? `${r.wins} up, ${r.losses} down` : '',
        )}
        ${perfTile(
          'Average hold',
          r.avgHoldDays === null ? '' : `${r.avgHoldDays.toFixed(1)} days`,
          '',
          TIPS.avgHold,
        )}
        ${perfExtreme('Biggest gain', r.best, TIPS.best)}
        ${perfExtreme(r.worst && r.worst.netGain >= 0 ? 'Smallest gain' : 'Biggest loss', r.worst, TIPS.worst)}
      </div>`,
      valuedAny
        ? `${r.closedCount} closed of ${r.tradeCount}`
        : r.closedCount > 0
          ? `${r.closedCount} closed of ${r.tradeCount}, none with a rate yet`
          : 'no closed trades yet',
    )}
    ${summaryCard('By currency', currencyTable(r.byCurrency))}
    ${summaryCard('By month closed', monthTable(r.byMonth))}
    <p class="summary__foot muted">
      Every figure is in US dollars. Amounts in a currency other than the dollar are
      converted at the European Central Bank reference rate published for the day of
      each transaction, so a loan taken and repaid months apart is converted twice.
    </p>
  `;
}

function renderStats() {
  const s = summarize(state.trades);
  const tiles = [
    {
      // Not "$0" when no closed trade has a rate yet. Those trades made a real
      // gain that simply is not known in dollars, and this tile shows on the
      // Trades view too, where the Summary's banner is not there to explain it.
      label: 'Realized net gain',
      value: isNum(s.netGain) ? signedUsd(s.netGain) : s.missingFx ? RATE_MISSING : '-',
      cls: gainClass(s.netGain),
    },
    { label: 'Blended annualized', value: isNum(s.avgPct) ? pct(s.avgPct) : '-', cls: gainClass(s.avgPct) },
    { label: 'Closed trades', value: String(s.closedCount) },
    {
      label: 'Open positions',
      // The chip, not a quietly short total: the count includes every open
      // trade while the dollars can only include the ones with a rate.
      value: s.openCount
        ? `${s.openCount} (${usd(s.deployed)})${s.deployedMissingFx ? ` ${RATE_MISSING}` : ''}`
        : '0',
    },
  ];
  document.getElementById('stats').innerHTML = tiles
    .map(
      (t) => `<div class="stat">
        <div class="stat__label">${t.label}</div>
        <div class="stat__value ${t.cls || ''}">${t.value}</div>
      </div>`,
    )
    .join('');
}

/* ------------------------------------------------------------ alerts view */

const ALERT_DIRECTION = { above: 'rises to', below: 'falls to' };

/**
 * One alert.
 *
 * Deliberately not `class="row"` carrying a `data-trade`: the handler that
 * opens a trade's stages matches any `.row` outside a button, so a row here
 * wearing those would silently expand a trade on the other view.
 */
function alertLogRow(a) {
  const t = state.trades.find((x) => x.id === a.tradeId);
  const trade = t
    ? `<span class="row__asset">${coin(t.borrow_currency)}<span class="row__stack">
         <span>Trade #${t.id}</span><small>${fmtDate(t.borrow_date)}</small></span></span>`
    : `Trade #${a.tradeId}`;

  // Derived from the error rather than from the status, because the case that
  // matters most is not a status of its own: a FIRED alert whose message
  // Telegram refused reached its goal and was never sent.
  //
  // Under the pill rather than beside it, the same way the fired price sits
  // under the fired date. Side by side it made Status the widest column in the
  // table, and the table then ran past the right edge of a tablet held upright
  // - taking the Delete button with it, which is the only control in here.
  const notSent = a.lastError
    ? `<span class="cell-note"><span class="chip chip--warn"
         data-tip="${esc(a.lastError)}">not sent</span></span>`
    : '';

  const when = a.status === 'armed' ? dash : fmtDate(localDay(a.firedAt));
  const under =
    a.status === 'armed'
      ? ''
      : `<small class="cell-note">${esc(localTime(a.firedAt))}${
          isNum(a.firedPrice) ? ` &middot; ${usd(a.firedPrice)}` : ''
        }</small>`;

  const status = esc(String(a.status).toUpperCase());

  return `<tr>
    <td data-label="Trade">${trade}</td>
    <td data-label="Goal" class="num">${usd(a.goalPrice)}</td>
    <td data-label="Direction">${ALERT_DIRECTION[a.direction] || esc(a.direction)}</td>
    <td data-label="Status"><span class="cell-stack"><span class="pill pill--${status}">${status}</span>${notSent}</span></td>
    <td data-label="Set" class="num">${fmtDate(localDay(a.createdAt))}</td>
    <td data-label="Fired at" class="num"><span class="cell-stack">${when}${under}</span></td>
    <td data-label="" class="num alerts-table__act">
      <button class="btn btn--ghost btn--sm btn--danger" type="button"
        data-alert-delete="${a.id}" aria-label="Delete this alert">Delete</button>
    </td>
  </tr>`;
}

function renderAlerts() {
  const mount = document.getElementById('alerts-mount');
  const all = document.getElementById('delete-all-alerts');
  all.hidden = true;

  if (state.alertLog === null) {
    mount.innerHTML = state.alertLogError
      ? `<div class="empty"><h3>Could not load the alerts</h3><p>${esc(state.alertLogError)}</p></div>`
      : `<div class="empty"><h3>Loading alerts</h3></div>`;
    return;
  }

  if (state.alertLog.length === 0) {
    mount.innerHTML = `<div class="empty">
      <h3>No alerts yet</h3>
      <p>Set a goal price from the bell on a trade that is still holding ETH.
         Every alert is kept here, including the ones already sent.</p>
    </div>`;
    return;
  }

  all.hidden = false;

  const total = state.alertLog.length;
  const page = clampPage(total, 'alerts');
  const start = (page - 1) * PAGE_SIZE;

  // `table--flush`, not a plain `table`: below 760px the mobile card labels are
  // drawn by `.table--flush tbody td::before` and by nothing else, so a plain
  // table silently loses every one of them.
  mount.innerHTML = `<table class="table table--flush alerts-table">
    <thead><tr>
      ${hintHead('Trade', TIPS.alerts.trade)}
      ${hintHead('Goal', TIPS.alerts.goal)}
      ${hintHead('Direction', TIPS.alerts.direction)}
      ${hintHead('Status', TIPS.alerts.status)}
      ${hintHead('Set', TIPS.alerts.set)}
      ${hintHead('Fired at', TIPS.alerts.firedAt)}
      <th><span class="sr-only">Delete</span></th>
    </tr></thead>
    <tbody>${state.alertLog.slice(start, start + PAGE_SIZE).map(alertLogRow).join('')}</tbody>
  </table>
  ${pager(total, 'alerts')}`;
}

function render() {
  state.draft = captureDraft();
  renderStats();
  if (state.view === 'summary') renderSummary();
  else if (state.view === 'alerts') renderAlerts();
  else renderTable();
}

/* ------------------------------------------------------------- form submit */

function clearFieldError(form, fieldName) {
  const wrap = form.querySelector(`[data-field="${fieldName}"]`);
  if (wrap && wrap.classList.contains('is-invalid')) {
    wrap.classList.remove('is-invalid');
    wrap.querySelector('[data-hint]').textContent = '';
  }
}

function showFormError(form, message, fieldName, { focus = true } = {}) {
  form.querySelectorAll('.field.is-invalid').forEach((f) => {
    f.classList.remove('is-invalid');
    f.querySelector('[data-hint]').textContent = '';
  });
  const target = fieldName && form.querySelector(`[data-field="${fieldName}"]`);
  if (target) {
    target.classList.add('is-invalid');
    target.querySelector('[data-hint]').textContent = message;
    form.querySelector('[data-form-error]').textContent = '';
    // Not when the error came from leaving the field: refocusing what the user
    // just tabbed out of traps them there until the value is acceptable.
    if (focus) target.querySelector('input, select')?.focus();
  } else {
    form.querySelector('[data-form-error]').textContent = message;
  }
}

/**
 * Check every field before anything is sent. Without this the only validation
 * was the server's, so a blank form made a round trip just to be told the
 * first thing it disliked.
 */
function validateForm(form, trade = {}) {
  const data = payloadOf(form);
  for (const [name, raw] of Object.entries(data)) {
    if (name === 'borrow_currency' || name === 'notes') continue;
    // The merged trade lets a field be judged against its siblings, such as a
    // sale that cannot exceed the ETH bought.
    const context = { ...trade, ...Object.fromEntries(
      Object.entries(data)
        .filter(([k]) => k !== name)
        .map(([k, v]) => [k, k.endsWith('_date') ? v : parseAmount(v)]),
    ) };
    const error = validateField(name, raw, context);
    if (error) {
      showFormError(form, error, name);
      return false;
    }
  }
  form.querySelector('[data-form-error]').textContent = '';
  return true;
}

function payloadOf(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = v;
  return out;
}

/**
 * Neither form disabled its button while a request was in flight, so a double
 * click on Create trade posted the same borrow twice and the duplicate then
 * double counted in every total. Returns null when a submit is already running.
 */
let submitting = false;

function beginSubmit(form) {
  if (submitting) return null;
  submitting = true;
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  return () => {
    submitting = false;
    if (btn) btn.disabled = false;
  };
}

async function submitStage(form) {
  const id = Number(form.dataset.trade);
  const stage = form.dataset.stageForm;
  const trade = state.trades.find((t) => t.id === id) || {};
  if (!validateForm(form, trade)) return;
  const done = beginSubmit(form);
  if (!done) return;
  try {
    const updated = await api(`/api/trades/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payloadOf(form)),
    });
    state.trades = state.trades.map((t) => (t.id === id ? withoutDerived(updated) : t));
    writeSeq += 1;
    state.editing = null;
    state.draft = null;
    render();
    state.draft = null;
    toast(`${STAGES.find((s) => s.key === stage).name} saved.`);
  } catch (err) {
    showFormError(form, err.message, err.field);
  } finally {
    done();
  }
}

async function submitBorrow(form) {
  if (!validateForm(form)) return;
  const done = beginSubmit(form);
  if (!done) return;
  try {
    const created = await api('/api/trades', {
      method: 'POST',
      body: JSON.stringify(payloadOf(form)),
    });
    await loadTrades();
    state.creating = false;
    state.openId = created.id;
    state.editing = null;
    // Go to wherever the new trade landed, so the row that just opened is on
    // screen whatever the table is sorted by.
    state.page = pageOfTrade(created.id);
    document.getElementById('new-trade-card').hidden = true;
    render();
    toast('Trade created. Add the ETH purchase next.');
  } catch (err) {
    showFormError(form, err.message, err.field);
  } finally {
    done();
  }
}

/* ----------------------------------------------------------- alert window */

/*
 * The window that sets a goal price.
 *
 * It lives in the page shell rather than inside the card that opens it. The
 * trades table is rebuilt from scratch on every render, and a render can be
 * triggered by a save in another tab landing while this is open; anything
 * inside that table would vanish mid-sentence. The toast has sat outside it
 * for the same reason since the beginning.
 */
const alertDialog = () => document.getElementById('alert-dialog');

function alertDialogBody(t, d, a) {
  const c = t.borrow_currency;
  const cfg = state.alertConfig;
  const goal = a ? String(a.goalPrice) : '';

  // The figures the goal is being judged against, in the same order and the
  // same words the card behind the window uses.
  const rows = [
    ['Trade amount', money(t.buy_amount, c)],
    ['Trade date', fmtDate(t.buy_date)],
    ['ETH purchase price', isNum(d.buyPriceUsd) ? usd(d.buyPriceUsd) : RATE_MISSING],
    ['ETH now', isNum(state.ethPrice?.price) ? usd(state.ethPrice.price) : '<span class="muted">not known yet</span>'],
  ]
    .map(([k, v]) => `<div class="stage__row"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  // Which way the alert reads is settled against ETH's current price, and with
  // neither that nor a purchase price to compare against it can only read
  // upward. Rare, and worth saying rather than leaving to be discovered.
  const noBasis =
    !isNum(state.ethPrice?.price) && !isNum(d.buyPriceUsd)
      ? `<p class="modal__note">The ETH price could not be fetched, so this will alert when ETH
         <strong>rises</strong> to the goal.</p>`
      : '';

  const note = cfg?.configured
    ? `<p class="modal__note">We will send this to
        <strong>${esc(cfg.chatName)}</strong> on Telegram once, when ETH reaches this price.
        It will read:</p>`
    : `<p class="modal__note"><span class="chip chip--warn">not connected</span>
        ${esc(cfg?.reason || 'Nothing is configured to send an alert.')}
        The goal is still saved, and will be sent once config.env is filled in.</p>`;

  const remove = a
    ? `<button class="btn btn--sm btn--danger modal__remove" type="button"
         data-alert-delete="${a.id}">Remove alert</button>`
    : '';

  return `<div class="modal__head">
      <h3 class="modal__title" id="alert-dialog-title">Price alert</h3>
    </div>
    <div class="modal__body">
      <dl class="stage__rows modal__rows">${rows}</dl>
      <form data-alert-form="${t.id}" novalidate>
        ${field({
          name: 'goal_price',
          label: 'ETH goal price',
          type: 'number',
          value: goal,
          prefix: '$',
          placeholder: '3000',
          autofocus: true,
        })}
        ${noBasis}
        ${note}
        <p class="modal__preview" data-alert-preview hidden></p>
        <div class="form__actions">
          ${remove}
          <span class="form__error" data-form-error></span>
          <button class="btn btn--ghost btn--sm" type="button" data-close-alert>Cancel</button>
          <button class="btn btn--primary btn--sm" type="submit">Save alert</button>
        </div>
      </form>
    </div>`;
}

/**
 * Both figures this window turns on - what ETH costs and whether the alert has
 * already fired - were fetched once when the page loaded and never again. A
 * tab left open for an afternoon offered a goal to set against a morning
 * price, and went on calling a fired alert armed until it was reloaded. So the
 * window asks first, and asks for a price fetched now rather than a cached
 * one.
 *
 * Refused answers are ignored on purpose: a window opened against slightly old
 * figures is better than a bell that does nothing because the server is down.
 * Asked for before the markup is built rather than after, because rewriting it
 * underneath someone would take away whatever they had begun to type.
 */
async function openAlertDialog(id) {
  await loadAlerts({ refresh: true }).catch(() => {});
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;

  // The card behind the window may have been saying the wrong thing too.
  render();

  const dlg = alertDialog();
  // Deliberately not touching `state.editing`. Escape closes a dialog by
  // itself, and the page's own Escape handler collapses an open stage form, so
  // claiming to be editing would make one key do two things.
  dlg.innerHTML = alertDialogBody(t, derive(t), alertFor(id));
  dlg.showModal();
  const input = dlg.querySelector('input[name="goal_price"]');
  input?.focus();
  input?.select();
  refreshAlertPreview(id);
}

function closeAlertDialog() {
  const dlg = alertDialog();
  if (dlg?.open) dlg.close();
  // Emptied here rather than left to the `close` event, for the reason given
  // in `settleConfirm`: that event cannot be relied on, and leaning on it left
  // the goal somebody had typed sitting in the document after the window shut.
  if (dlg) dlg.innerHTML = '';
}

/**
 * The message as it will arrive, built by the server so that what is shown
 * here and what is sent cannot drift apart. Debounced, because it is rebuilt
 * as the price is typed.
 */
let previewTimer;
let previewSeq = 0;

function refreshAlertPreview(id, { delay = 0 } = {}) {
  clearTimeout(previewTimer);
  // Clearing the timer only stops a request that has not left yet. One already
  // on the wire arrives regardless, and `dlg.open` is true again by then if
  // the window has been closed and reopened on another trade, so the check
  // that used to guard this let one trade's figures be shown under another
  // trade's heading. Only the newest request may write.
  const seq = ++previewSeq;

  previewTimer = setTimeout(async () => {
    const dlg = alertDialog();
    const slot = dlg?.querySelector('[data-alert-preview]');
    const goal = dlg?.querySelector('input[name="goal_price"]')?.value ?? '';
    if (!slot) return;
    if (goal.trim() === '') {
      slot.hidden = true;
      return;
    }
    try {
      const { text } = await api(`/api/trades/${id}/alert/preview?goal=${encodeURIComponent(goal)}`);
      if (seq !== previewSeq || !dlg.open) return;
      // Re-read the slot: the window may have been rebuilt while this was away.
      const live = dlg.querySelector('[data-alert-preview]');
      if (!live) return;
      live.textContent = text || '';
      live.hidden = !text;
    } catch (err) {
      if (seq === previewSeq) slot.hidden = true;
    }
  }, delay);
}

async function submitAlert(form) {
  const id = Number(form.dataset.alertForm);
  if (!validateForm(form)) return;
  const done = beginSubmit(form);
  if (!done) return;
  try {
    const alert = await api(`/api/trades/${id}/alert`, {
      method: 'PUT',
      body: JSON.stringify({ goal_price: form.querySelector('input[name="goal_price"]').value }),
    });
    state.alerts = { ...state.alerts, [id]: alert };
    // The save replaces whatever armed alert was on this trade and adds this
    // one, which is exactly what this does. Same reasoning as the map above:
    // the write answers with what it stored, so there is no second reply that
    // can arrive late and undo it.
    if (state.alertLog) {
      state.alertLog = [
        alert,
        ...state.alertLog.filter((a) => !(a.tradeId === id && a.status === 'armed')),
      ];
    }
    alertWriteSeq += 1;
    // Closed before the toast, which would otherwise be painted over: a
    // dialog renders in the browser's top layer, above everything.
    closeAlertDialog();
    render();
    toast(`Alert set for ${usd(alert.goalPrice)}.`);
  } catch (err) {
    showFormError(form, err.message, err.field);
  } finally {
    done();
  }
}

/**
 * Delete one alert, by its own id. Called from the table and from the button
 * inside the alert window, which is why it closes that window too - a no-op
 * when it was not open.
 */
async function removeAlert(id) {
  const ok = await confirmDialog({
    title: 'Delete this alert?',
    body: 'It goes from the Alerts list as well. If it is still armed, nothing will be sent for it.',
  });
  if (!ok) return;

  try {
    await api(`/api/alerts/${id}`, { method: 'DELETE' });
  } catch (err) {
    // A 404 is the state we were after: it is already gone. Anything else -
    // a server that is not answering above all - is a delete that did not
    // happen, and saying it was removed would leave an armed alert behind.
    if (err.status !== 404) {
      // No status at all means `fetch` itself threw and the request never got
      // a reply, so the raw "Failed to fetch" would be both unhelpful and
      // ambiguous about whether the alert is still there. It is.
      toast(err.status ? err.message : 'Could not reach the server, so the alert is still set.');
      return;
    }
  }

  // Both collections, since the same alert can appear in each: the map the bell
  // reads, keyed by trade, and the log the Alerts table renders.
  state.alerts = Object.fromEntries(Object.entries(state.alerts).filter(([, a]) => a.id !== id));
  if (state.alertLog) state.alertLog = state.alertLog.filter((a) => a.id !== id);
  alertWriteSeq += 1;

  closeAlertDialog();
  render();
  toast('Alert removed.');
}

/**
 * Every alert, armed ones included. The sentence names how many are still
 * being watched, because those are the ones whose deletion has a consequence
 * beyond the list.
 */
async function deleteAllAlerts() {
  const total = state.alertLog?.length ?? 0;
  if (total === 0) return;
  const armed = state.alertLog.filter((a) => a.status === 'armed').length;

  const ok = await confirmDialog({
    title: `Delete all ${total} alert${total === 1 ? '' : 's'}?`,
    body:
      armed > 0
        ? `This clears the whole list, including <strong>${armed}</strong> still armed and waiting.
           Those stop being watched and nothing will be sent for them. It cannot be undone.`
        : 'This clears the whole list. It cannot be undone.',
    confirmLabel: 'Delete all',
  });
  if (!ok) return;

  try {
    const { deleted } = await api('/api/alerts', { method: 'DELETE' });
    state.alerts = {};
    state.alertLog = [];
    state.alertsPage = 1;
    alertWriteSeq += 1;
    render();
    toast(`${deleted} alert${deleted === 1 ? '' : 's'} deleted.`);
  } catch (err) {
    toast(err.status ? err.message : 'Could not reach the server, so nothing was deleted.');
  }
}

/* ----------------------------------------------------------- confirmation */

/*
 * A second dialog rather than a mode of the alert window.
 *
 * A delete can be confirmed from inside that window, and a dialog cannot be
 * opened on top of itself; rewriting its markup would destroy the form and the
 * goal already typed into it. Two dialogs stack in the top layer, which is the
 * right picture anyway.
 */
let confirmResolve = null;

const confirmEl = () => document.getElementById('confirm-dialog');

/**
 * Ask, and answer true or false. Everything that is not yes - Cancel, Escape,
 * the backdrop, a second question arriving on top of this one - is no.
 *
 * `body` is HTML the caller builds, so anything dynamic in it is escaped there.
 */
function confirmDialog({ title, body, confirmLabel = 'Delete', danger = true }) {
  const dlg = confirmEl();
  settleConfirm(false); // never leave an earlier promise pending
  dlg.innerHTML = `<div class="modal__head">
      <h3 class="modal__title" id="confirm-dialog-title">${esc(title)}</h3>
    </div>
    <div class="modal__body">
      <p class="modal__note modal__note--lead">${body}</p>
      <div class="form__actions">
        <span class="form__error"></span>
        <button class="btn btn--ghost btn--sm" type="button" data-confirm="no">Cancel</button>
        <button class="btn btn--sm ${danger ? 'btn--danger' : 'btn--primary'}" type="button"
          data-confirm="yes">${esc(confirmLabel)}</button>
      </div>
    </div>`;
  dlg.showModal();
  // Cancel takes the focus, so Enter on a window that appeared under someone's
  // hands does not delete anything.
  dlg.querySelector('[data-confirm="no"]')?.focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(answer) {
  const resolve = confirmResolve;
  // Cleared before close(), in case the `close` listener runs and lands back
  // in here; with the slot already empty that second pass does nothing.
  confirmResolve = null;
  const dlg = confirmEl();
  if (dlg?.open) dlg.close();
  // Emptied here rather than left to the `close` event. That event is queued
  // rather than fired, and an engine may not dispatch it at all for a close()
  // from script - so a window that leans on it for cleanup simply keeps its
  // markup, and with it whatever was typed into the last one.
  if (dlg) dlg.innerHTML = '';
  resolve?.(answer);
}

/* ------------------------------------------------------------------ toast */

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

/* ------------------------------------------------------------------ views */

const VIEWS = ['trades', 'summary', 'alerts'];

function viewFromHash() {
  const name = (location.hash || '').replace(/^#/, '');
  return VIEWS.includes(name) ? name : 'trades';
}

/**
 * Swap the visible view and move the nav underline with it. The hero band of
 * tiles belongs to both views, so only the panels below it change.
 */
function setView(view, { updateHash = true } = {}) {
  state.view = VIEWS.includes(view) ? view : 'trades';

  for (const name of VIEWS) {
    document.getElementById(`view-${name}`).hidden = name !== state.view;
  }
  for (const link of document.querySelectorAll('.nav__link')) {
    link.classList.toggle('is-active', link.dataset.view === state.view);
  }

  if (updateHash && viewFromHash() !== state.view) {
    history.replaceState(null, '', `#${state.view}`);
  }

  render();

  // Asked for on every visit, not only the first. An alert can fire while this
  // tab sits open, and a table that goes on calling it ARMED until a reload is
  // worse than one request against a local file.
  if (state.view === 'alerts') loadAlertLog().then(render);
}

/* ------------------------------------------------------------------ theme */

const SUN = `<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>`;
const MOON = `<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>`;

/**
 * `persist` is off at boot, where this runs only to draw the toggle's glyph:
 * the head script has already set the theme, and nobody has chosen anything.
 *
 * Writing the key there recorded a choice that was never made. The landing
 * page reads the same key and follows the system only while it is empty, so
 * one visit to the ledger left that page stuck in light on a dark machine,
 * with a toggle the visitor had never touched.
 */
function applyTheme(theme, { persist = true } = {}) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-icon').innerHTML = theme === 'dark' ? SUN : MOON;
  if (!persist) return;
  try {
    localStorage.setItem('myaave-theme', theme);
  } catch (e) {
    /* private browsing, the toggle simply will not persist */
  }
}

/* ------------------------------------------------------------------ events */

function wire() {
  for (const link of document.querySelectorAll('.nav__link')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      setView(link.dataset.view);
    });
  }
  window.addEventListener('hashchange', () => setView(viewFromHash(), { updateHash: false }));

  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const card = document.getElementById('new-trade-card');
  const borrowForm = document.getElementById('borrow-form');

  document.getElementById('delete-all-alerts').addEventListener('click', deleteAllAlerts);

  document.getElementById('new-trade').addEventListener('click', () => {
    state.creating = !state.creating;
    card.hidden = !state.creating;
    if (state.creating) {
      borrowForm.innerHTML = borrowFields() + actions('Create trade', 'data-close-new');
      refreshHints(borrowForm, {}, 'borrow');
      borrowForm.querySelector('input')?.focus();
    }
  });

  borrowForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitBorrow(borrowForm);
  });

  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-new]')) {
      state.creating = false;
      card.hidden = true;
      return;
    }

    const edit = e.target.closest('[data-edit-stage]');
    if (edit) {
      state.editing = { id: Number(edit.dataset.trade), stage: edit.dataset.editStage };
      state.openId = Number(edit.dataset.trade);
      render();
      return;
    }

    const bell = e.target.closest('[data-alert-trade]');
    if (bell) {
      openAlertDialog(Number(bell.dataset.alertTrade));
      return;
    }

    if (e.target.closest('[data-close-alert]')) {
      closeAlertDialog();
      return;
    }

    const del = e.target.closest('[data-alert-delete]');
    if (del) {
      removeAlert(Number(del.dataset.alertDelete));
      return;
    }

    if (e.target.closest('[data-cancel-stage]')) {
      state.editing = null;
      render();
      state.draft = null;
      return;
    }

    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      applySort(sortBtn.dataset.sort);
      return;
    }

    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn && !pageBtn.disabled) {
      const scope = pageBtn.dataset.pageScope || 'trades';
      const to = Number(pageBtn.dataset.page);
      if (Number.isFinite(to) && to !== pageOf(scope)) {
        setPage(scope, to);
        // Same reasoning as a sort change: an open editor may belong to a row
        // that is no longer on screen. Only the trades table has one.
        if (scope === 'trades') state.editing = null;
        render();
        document.getElementById(PAGERS[scope].mount)?.scrollIntoView({ block: 'start' });
      }
      return;
    }

    const dirBtn = e.target.closest('[data-sort-dir]');
    if (dirBtn) {
      applySort(state.sort.key);
      return;
    }

    if (e.target.closest('#fetch-rates')) {
      const btn = e.target.closest('#fetch-rates');
      btn.disabled = true;
      btn.textContent = 'Fetching...';
      // With `refresh` the run also asks again about a rate that stood in for
      // one the ECB had not published yet. Nothing in the interface ever sent
      // it, so a stand-in was permanent however many times this was pressed,
      // and the server's whole replacement path was unreachable.
      api('/api/fx/backfill', { method: 'POST', body: JSON.stringify({ refresh: true }) })
        .then(async (out) => {
          await loadTrades();
          render();
          // A run now stops at a time budget, so say when there is more to do
          // rather than letting the banner sit there looking stuck.
          const more = out.timedOut ? ' Press again for the rest.' : '';
          if (out.filled > 0) {
            toast(`Filled in ${out.filled} exchange rate${out.filled === 1 ? '' : 's'}.${more}`);
          } else if (out.offline) toast('Rate lookups are switched off.');
          else if (out.lastError) toast(out.lastError + more);
          // A run that reached the service and found nothing to change is not a
          // failure. It used to report one, because no rate filled in was read
          // as no rate fetched.
          else if (out.stillMissing > 0) toast(`No rate has been published yet for ${out.stillMissing === 1 ? 'that date' : 'those dates'}.`);
          else toast('Every rate is up to date.');
        })
        .catch((err) => {
          // The re-render that would have replaced this button never happened,
          // so put it back rather than leaving it disabled for good.
          btn.disabled = false;
          btn.textContent = 'Fetch rates';
          toast(err.message || 'Could not reach the server.');
        });
      return;
    }

    const delTrade = e.target.closest('[data-delete]');
    if (delTrade) {
      const id = Number(delTrade.dataset.delete);
      confirmDeleteTrade(id);
      return;
    }

    const row = e.target.closest('.row');
    if (row && !e.target.closest('button')) {
      const id = Number(row.dataset.trade);
      state.openId = state.openId === id ? null : id;
      state.editing = null;
      render();
    }
  });

  async function confirmDeleteTrade(id) {
    const ok = await confirmDialog({
      title: 'Delete this trade?',
      body: 'Its whole history goes with it, alerts included. This cannot be undone.',
    });
    if (ok) {
      api(`/api/trades/${id}`, { method: 'DELETE' })
        .then(() => {
          state.trades = state.trades.filter((t) => t.id !== id);
          writeSeq += 1;
          state.openId = null;
          state.editing = null;
          // The trade's alerts went with it, so both collections lose them.
          state.alerts = Object.fromEntries(
            Object.entries(state.alerts).filter(([tradeId]) => Number(tradeId) !== id),
          );
          if (state.alertLog) state.alertLog = state.alertLog.filter((a) => a.tradeId !== id);
          alertWriteSeq += 1;
          render();
          toast('Trade deleted.');
        })
        .catch((err) => toast(err.message || 'Could not delete that trade.'));
    }
  }

  document.body.addEventListener('keydown', (e) => {
    const row = e.target.closest('.row');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      row.click();
    }
    if (e.key === 'Escape' && state.editing) {
      state.editing = null;
      render();
    }
  });

  // The mobile stand-in for the column headers, which are hidden in card mode.
  document.body.addEventListener('change', (e) => {
    const select = e.target.closest('[data-sort-select]');
    if (!select) return;
    if (select.value !== state.sort.key) {
      state.sort = { key: select.value, dir: state.sort.dir };
      saveSort();
      state.editing = null;
      state.page = 1;
      render();
    }
  });

  // Runs for every field in every form, including the new trade card.
  document.body.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.matches('input, select')) return;

    // Keep a typed amount to digits and a single decimal point, preserving the
    // caret. Pasting "12,000" now leaves "12000" rather than an empty field.
    if (input.dataset.numeric === '1') {
      const cleaned = sanitizeNumeric(input.value, { pasted: WHOLE_VALUE_INPUT.has(e.inputType) });
      if (cleaned !== input.value) {
        const caret = input.selectionStart - (input.value.length - cleaned.length);
        input.value = cleaned;
        try {
          input.setSelectionRange(Math.max(caret, 0), Math.max(caret, 0));
        } catch (err) {
          /* a detached or non text input has no selection to restore */
        }
      }
    }

    const form = input.closest('form');
    if (!form) return;

    // An error that has been addressed should stop shouting immediately. This
    // has to happen before the hints are recomputed, because clearing an error
    // empties the same slot the hint is written into.
    if (input.name) clearFieldError(form, input.name);
    form.querySelector('[data-form-error]').textContent = '';

    if (input.name === 'borrow_currency') {
      const unit = form.querySelector('[data-field="borrow_amount"] .control__suffix');
      if (unit) unit.textContent = input.value;
    }

    const stageForm = input.closest('[data-stage-form]');
    if (!stageForm) {
      if (form.id === 'borrow-form') refreshHints(form, {}, 'borrow');
      return;
    }
    if (input.name === 'repay_amount' && e.isTrusted) delete input.dataset.auto;
    const trade = state.trades.find((t) => t.id === Number(stageForm.dataset.trade));
    refreshHints(stageForm, trade, stageForm.dataset.stageForm);
  });

  // Flag a bad value as soon as the user leaves the field, rather than at submit.
  document.body.addEventListener(
    'blur',
    (e) => {
      const input = e.target;
      if (!input.matches('input[name]')) return;
      const form = input.closest('form');
      if (!form || input.value.trim() === '') return;
      const stageForm = input.closest('[data-stage-form]');
      const trade = stageForm
        ? state.trades.find((t) => t.id === Number(stageForm.dataset.trade)) || {}
        : {};
      const error = validateField(input.name, input.value, trade);
      if (error) showFormError(form, error, input.name, { focus: false });
    },
    true,
  );

  document.body.addEventListener('submit', (e) => {
    const alertForm = e.target.closest('[data-alert-form]');
    if (alertForm) {
      e.preventDefault();
      submitAlert(alertForm);
      return;
    }
    const form = e.target.closest('[data-stage-form]');
    if (!form) return;
    e.preventDefault();
    submitStage(form);
  });

  const dlg = document.getElementById('alert-dialog');

  // A click on the backdrop lands on the dialog element itself rather than on
  // anything inside it, which is the only way to tell the two apart.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeAlertDialog();
  });

  // A second line of defence for a close that did not come through
  // `closeAlertDialog` - the form submitting, say. Not the only one, because
  // this event is not dispatched everywhere.
  dlg.addEventListener('close', () => {
    if (!dlg.open) dlg.innerHTML = '';
  });

  // Escape closes a modal dialog by itself in a browser, but only while the
  // focus is inside it, and the page's own Escape handler is listening on the
  // body for the stage editor. Closing it here makes the key do one thing
  // wherever the focus happens to be.
  //
  // Stopped as well as prevented, as the confirmation below is. The bell sits
  // on the Bought ETH card while another stage on the same trade is being
  // edited - the two cards are side by side - so Escape closed this window and
  // then went on to the body, where it threw away the half filled form behind
  // it and whatever had been typed into it.
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAlertDialog();
  });

  const confirmDlg = document.getElementById('confirm-dialog');

  confirmDlg.addEventListener('click', (e) => {
    if (e.target === confirmDlg) return settleConfirm(false); // the backdrop
    const btn = e.target.closest('[data-confirm]');
    if (btn) settleConfirm(btn.dataset.confirm === 'yes');
  });

  confirmDlg.addEventListener('close', () => {
    // `close()` queues this rather than firing it, so by the time it runs the
    // dialog may already have been reopened for a second question - which is
    // what two clicks on Delete in one tick does. Clearing then wiped the
    // window that was on screen and closed it again, leaving no confirmation
    // at all and nothing to say why.
    if (confirmDlg.open) return;
    confirmDlg.innerHTML = '';
    settleConfirm(false);
  });

  confirmDlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // Stopped as well as prevented, unlike the alert window above: the body's
    // own Escape handler collapses an open stage form, and a confirmation
    // raised over the table must not close the editor behind it.
    e.stopPropagation();
    settleConfirm(false);
  });

  // The message is rebuilt as the goal is typed, a beat behind the keystrokes.
  dlg.addEventListener('input', (e) => {
    const form = e.target.closest('[data-alert-form]');
    if (form && e.target.name === 'goal_price') {
      refreshAlertPreview(Number(form.dataset.alertForm), { delay: 350 });
    }
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  applyTheme(document.documentElement.dataset.theme || 'light', { persist: false });
  wire();
  try {
    const { version } = await api('/api/version');
    document.getElementById('version').textContent = `v${version}`;
  } catch (e) {
    /* keep the fallback already in the markup */
  }
  // Alerts ride alongside the ledger rather than gating it: the trades are
  // worth showing even when the alert subsystem cannot be reached, and asking
  // for both at once means one render rather than two.
  const alerts = loadAlerts().catch(() => {});

  try {
    await loadTrades();
  } catch (err) {
    document.getElementById('table-mount').innerHTML = `<div class="empty">
      <h3>Could not reach the server</h3>
      <p>Check that it is still running, then reload this page.</p>
    </div>`;
    renderStats();
    return;
  }

  await alerts;
  setView(viewFromHash(), { updateHash: false });
}

boot();
