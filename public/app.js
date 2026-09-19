import {
  derive,
  summarize,
  summaryReport,
  accruedInterest,
  annualizedPct,
  daysBetween,
  todayISO,
  parseAmount,
  normaliseAmountText,
  CURRENCIES,
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

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const gainClass = (v) => (!isNum(v) ? '' : v >= 0 ? 'pos' : 'neg');

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
function fxNote(usdValue, leg) {
  if (!isNum(usdValue)) return RATE_MISSING;
  const at = leg && isNum(leg.rate) ? ` <span class="fx-note__rate">at ${leg.rate.toFixed(4)}${
    leg.date ? ` on ${fmtDate(leg.date)}` : ''
  }</span>` : '';
  return `${usd(usdValue)}${at}`;
}

function signedFxNote(usdValue, leg) {
  if (!isNum(usdValue)) return RATE_MISSING;
  const at = leg && isNum(leg.rate) ? ` <span class="fx-note__rate">at ${leg.rate.toFixed(4)}</span>` : '';
  return `${signedUsd(usdValue)}${at}`;
}

const RATE_MISSING =
  '<span class="chip chip--warn" title="No exchange rate for this date yet. Use Fetch rates on the Summary.">no rate</span>';

const ethMark = `<img class="eth-mark" src="/eth.svg" alt="" width="15" height="15" />`;

/* ------------------------------------------------------------------ state */

const state = {
  view: 'trades',
  draft: null,
  trades: [],
  openId: null,
  editing: null, // { id, stage }
  creating: false,
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
    throw err;
  }
  return body;
}

// The server's `derived` block is a snapshot taken when the request was served.
// A tab left open across midnight kept showing the day count and the accrued
// interest from page load, so drop it and recompute from the shared module.
const withoutDerived = ({ derived, ...row }) => row;

async function loadTrades() {
  state.trades = (await api('/api/trades')).map(withoutDerived);
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

const FIELD_LABELS = {
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

const AMOUNT_FIELDS = ['borrow_amount', 'buy_amount', 'sell_amount', 'repay_amount', 'buy_eth', 'sell_eth'];

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
    if (name === 'buy_date') return after('borrow_date', 'borrow');
    if (name === 'sell_date') return after('buy_date', 'purchase') || after('borrow_date', 'borrow');
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

  if (name === 'sell_eth' && isNum(trade.buy_eth) && value > trade.buy_eth * 1.0001) {
    return `You only bought ${ethQty(trade.buy_eth)} ETH.`;
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
  const d = derive(merged);
  const set = (name, html) => {
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
        row('ETH price', isNum(d.buyPriceUsd) ? usd(d.buyPriceUsd) : RATE_MISSING)
      );
    case 'sell':
      return (
        row('Date', fmtDate(t.sell_date)) +
        row2('Received', money(t.sell_amount, c), fxNote(d.sellUsd, d.fx.sell)) +
        row('Sold', eth(t.sell_eth)) +
        row('ETH price', isNum(d.sellPriceUsd) ? usd(d.sellPriceUsd) : RATE_MISSING) +
        (d.isPartialSale ? row2('Cost of ETH sold', money(d.costOfSoldEth, c), fxNote(d.costOfSoldEthUsd, d.fx.buy)) : '') +
        (d.isPartialSale ? row('Still held', eth(d.retainedEth)) : '') +
        row2('Gross gain', signedMoney(d.grossGain, c), signedFxNote(d.grossGainUsd, d.fx.sell), gainClass(d.grossGain))
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
          isNum(d.loanCostUsd)
            ? `${usd(d.loanCostUsd)}${
                isNum(d.principalFxUsd)
                  ? ` <span class="fx-note__rate">interest ${usd(d.interestPaidUsd)}, currency ${signedUsd(d.principalFxUsd)}</span>`
                  : ''
              }`
            : RATE_MISSING,
        ) +
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

function tradeRow(t, index) {
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
    <td data-label="Trade">
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
            <span class="detail__note">Trade #${index} of ${state.trades.length}, added ${fmtDate((t.created_at || '').slice(0, 10))}.</span>
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

  mount.innerHTML = `<table class="table">
    <thead>
      <tr>
        <th>Trade</th><th>ETH</th><th>Buy price</th><th>Sell price</th>
        <th>Days</th><th>Net gain</th><th>Annualized</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${state.trades.map((t, i) => tradeRow(t, state.trades.length - i)).join('')}
    </tbody>
  </table>`;

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

function statRow(label, value, cls = '') {
  return `<div class="kv">
    <dt>${label}</dt>
    <dd class="${cls}">${value || dash}</dd>
  </div>`;
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
      <tr><th>Currency</th><th>Closed</th><th>Open</th><th>Borrowed</th><th>Net gain</th><th>Avg annualized</th></tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td data-label="Currency"><span class="row__asset">${coin(r.currency)}<span>${esc(r.currency)}</span>${
          r.missingFx ? ` ${RATE_MISSING}` : ''
        }</span></td>
        <td data-label="Closed" class="num">${r.closed}</td>
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
      <tr><th>Month</th><th>Trades</th><th>Net gain</th><th class="bar-col">Share</th></tr>
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

function extremeCard(label, entry) {
  if (!entry) return statRow(label, '');
  return `<div class="kv">
    <dt>${label}</dt>
    <dd>
      <span class="${gainClass(entry.netGain)}">${signedUsd(entry.netGain)}</span>
      <span class="muted">${esc(entry.currency)}, ${fmtDate(entry.date)}, ${pct(entry.pct)}</span>
    </dd>
  </div>`;
}

/**
 * Says so out loud when some trades have no exchange rate yet, rather than
 * quietly leaving them out of the totals. The button asks the server to go and
 * look the missing rates up, which is the other half of letting a trade save
 * with the network unplugged.
 */
function fxBanner(count) {
  if (!count) return '';
  const noun = count === 1 ? 'trade has' : 'trades have';
  return `<section class="card card--warn">
    <div class="card__body fx-banner">
      <span>${count} ${noun} no exchange rate yet, so ${
        count === 1 ? 'it is' : 'they are'
      } left out of the totals below.</span>
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
    ${fxBanner(r.missingFx)}
    ${summaryCard(
      'Performance',
      `<div class="kv-grid">
        ${statRow('Realized net gain', signedUsd(r.netGain), gainClass(r.netGain))}
        ${statRow('Average annualized', pct(r.avgPct), gainClass(r.avgPct))}
        ${statRow('Interest paid', valuedAny ? usd(r.interestPaid) : '')}
        ${
          isNum(r.currencyEffect) && Math.abs(r.currencyEffect) >= 0.005
            ? statRow('Of which currency', signedUsd(r.currencyEffect), gainClass(r.currencyEffect))
            : ''
        }
        ${statRow(
          'Win rate',
          valuedAny ? `${pct(r.winRate, 0)} <span class="muted">(${r.wins} up, ${r.losses} down)</span>` : '',
        )}
        ${statRow('Total borrowed', valuedAny ? usd(r.totalBorrowed) : '')}
        ${statRow('Average hold', r.avgHoldDays === null ? '' : `${r.avgHoldDays.toFixed(1)} days`)}
        ${extremeCard('Best trade', r.best)}
        ${extremeCard('Worst trade', r.worst)}
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
    { label: 'Average annualized', value: isNum(s.avgPct) ? pct(s.avgPct) : '-', cls: gainClass(s.avgPct) },
    { label: 'Closed trades', value: String(s.closedCount) },
    { label: 'Open positions', value: s.openCount ? `${s.openCount} (${usd(s.deployed)})` : '0' },
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

function render() {
  state.draft = captureDraft();
  renderStats();
  if (state.view === 'summary') renderSummary();
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
    document.getElementById('new-trade-card').hidden = true;
    render();
    toast('Trade created. Add the ETH purchase next.');
  } catch (err) {
    showFormError(form, err.message, err.field);
  } finally {
    done();
  }
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

const VIEWS = ['trades', 'summary'];

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
}

/* ------------------------------------------------------------------ theme */

const SUN = `<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>`;
const MOON = `<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>`;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-icon').innerHTML = theme === 'dark' ? SUN : MOON;
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

    if (e.target.closest('[data-cancel-stage]')) {
      state.editing = null;
      render();
      state.draft = null;
      return;
    }

    if (e.target.closest('#fetch-rates')) {
      const btn = e.target.closest('#fetch-rates');
      btn.disabled = true;
      btn.textContent = 'Fetching...';
      api('/api/fx/backfill', { method: 'POST', body: JSON.stringify({ refresh: false }) })
        .then(async (out) => {
          await loadTrades();
          render();
          // A run now stops at a time budget, so say when there is more to do
          // rather than letting the banner sit there looking stuck.
          const more = out.timedOut ? ' Press again for the rest.' : '';
          if (out.filled > 0) {
            toast(`Filled in ${out.filled} exchange rate${out.filled === 1 ? '' : 's'}.${more}`);
          } else if (out.offline) toast('Rate lookups are switched off.');
          else toast((out.lastError || 'No rates could be fetched just now.') + more);
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

    const del = e.target.closest('[data-delete]');
    if (del) {
      const id = Number(del.dataset.delete);
      if (!confirm('Delete this trade and its whole history? This cannot be undone.')) return;
      api(`/api/trades/${id}`, { method: 'DELETE' })
        .then(() => {
          state.trades = state.trades.filter((t) => t.id !== id);
          state.openId = null;
          state.editing = null;
          render();
          toast('Trade deleted.');
        })
        .catch((err) => toast(err.message || 'Could not delete that trade.'));
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

  // Runs for every field in every form, including the new trade card.
  document.body.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.matches('input, select')) return;

    // Keep a typed amount to digits and a single decimal point, preserving the
    // caret. Pasting "12,000" now leaves "12000" rather than an empty field.
    if (input.dataset.numeric === '1') {
      const cleaned = sanitizeNumeric(input.value, { pasted: e.inputType === 'insertFromPaste' });
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
    const form = e.target.closest('[data-stage-form]');
    if (!form) return;
    e.preventDefault();
    submitStage(form);
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  applyTheme(document.documentElement.dataset.theme || 'light');
  wire();
  try {
    const { version } = await api('/api/version');
    document.getElementById('version').textContent = `v${version}`;
  } catch (e) {
    /* keep the fallback already in the markup */
  }
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
  setView(viewFromHash(), { updateHash: false });
}

boot();
