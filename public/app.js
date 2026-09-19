import {
  derive,
  summarize,
  summaryReport,
  accruedInterest,
  annualizedPct,
  daysBetween,
  todayISO,
  CURRENCIES,
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
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
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
};

function coin(currency) {
  const art = COIN_ART[currency];
  return art
    ? `<img class="coin coin--art" src="${art}" alt="${esc(currency)}" width="26" height="26" />`
    : `<span class="coin coin--${esc(currency)}">${esc(currency)}</span>`;
}

const ethMark = `<img class="eth-mark" src="/eth.svg" alt="" width="15" height="15" />`;

/* ------------------------------------------------------------------ state */

const state = {
  view: 'trades',
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

async function loadTrades() {
  state.trades = await api('/api/trades');
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
    control = `<div class="${cls}">
      ${prefix ? `<span class="control__prefix">${esc(prefix)}</span>` : ''}
      <input id="${id}" name="${name}" type="${type}" value="${esc(value)}"
        ${type === 'number' ? `step="${step}" inputmode="decimal"` : ''}
        placeholder="${esc(placeholder)}" ${autofocus ? 'autofocus' : ''}
        ${auto ? 'data-auto="1"' : ''} autocomplete="off" />
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

function borrowFields(t = {}) {
  return `<div class="grid">
    ${field({ name: 'borrow_date', label: 'Borrow date', type: 'date', value: t.borrow_date || todayISO(), autofocus: true })}
    ${field({ name: 'borrow_amount', label: 'Amount borrowed', type: 'number', value: t.borrow_amount ?? '', prefix: '$', placeholder: '25000' })}
    ${field({ name: 'borrow_currency', label: 'Stablecoin', value: t.borrow_currency || 'USDC', options: CURRENCIES })}
    ${field({ name: 'borrow_apr', label: 'Borrow APR', type: 'number', value: t.borrow_apr ?? '', suffix: '%', placeholder: '4.27' })}
  </div>`;
}

function buyFields(t) {
  return `<div class="grid">
    ${field({ name: 'buy_date', label: 'Purchase date', type: 'date', value: t.buy_date || t.borrow_date, autofocus: true })}
    ${field({ name: 'buy_amount', label: 'Amount spent', type: 'number', value: t.buy_amount ?? t.borrow_amount, prefix: '$' })}
    ${field({ name: 'buy_eth', label: 'ETH purchased', type: 'number', value: t.buy_eth ?? '', suffix: 'ETH', placeholder: '8.0773' })}
  </div>`;
}

function sellFields(t) {
  return `<div class="grid">
    ${field({ name: 'sell_date', label: 'Sale date', type: 'date', value: t.sell_date || todayISO(), autofocus: true })}
    ${field({ name: 'sell_eth', label: 'ETH sold', type: 'number', value: t.sell_eth ?? t.buy_eth ?? '', suffix: 'ETH' })}
    ${field({ name: 'sell_amount', label: 'Amount received', type: 'number', value: t.sell_amount ?? '', prefix: '$', placeholder: '26811' })}
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
      prefix: '$',
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
  const n = (v) => {
    const x = Number(String(v ?? '').replace(/[,\s$%]/g, ''));
    return Number.isFinite(x) && x !== 0 ? x : null;
  };
  const merged = {
    ...trade,
    ...Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, k.endsWith('_date') || k === 'borrow_currency' ? v || null : n(v)]),
    ),
  };
  const d = derive(merged);
  const set = (name, html) => {
    const el = form.querySelector(`[data-hint="${name}"]`);
    if (el) el.innerHTML = html;
  };

  if (stage === 'borrow') {
    const days = daysBetween(merged.borrow_date, todayISO());
    set('borrow_apr', isNum(merged.borrow_amount) && isNum(merged.borrow_apr)
      ? `About <strong>${usd((merged.borrow_amount * merged.borrow_apr) / 100 / 365, 2)}</strong> of interest per day`
      : '');
    set('borrow_date', isNum(days) && days > 0 ? `${days} day${days === 1 ? '' : 's'} ago` : '');
  }

  if (stage === 'buy') {
    set('buy_eth', isNum(d.buyPrice) ? `ETH price <strong>${usd(d.buyPrice)}</strong>` : '');
  }

  if (stage === 'sell') {
    set('sell_amount', isNum(d.sellPrice)
      ? `ETH price <strong>${usd(d.sellPrice)}</strong>${isNum(d.grossGain) ? `, gross ${signedUsd(d.grossGain)}` : ''}`
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

    const days = daysBetween(merged.borrow_date, merged.repay_date);
    const interest = accruedInterest(merged.borrow_amount, merged.borrow_apr, days);
    set('repay_date', isNum(days)
      ? `${days} day${days === 1 ? '' : 's'} of loan${isNum(interest) ? `, interest ${usd(interest, 2)}` : ''}`
      : '');

    const net = isNum(merged.sell_amount) && isNum(merged.repay_amount)
      ? merged.sell_amount - merged.repay_amount
      : null;
    const p = annualizedPct(net, merged.borrow_amount, days);
    set('repay_amount', isNum(net)
      ? `Net gain <strong class="${gainClass(net)}">${signedUsd(net)}</strong>${isNum(p) ? `, <strong>${pct(p)}</strong> annualized` : ''}`
      : isNum(d.suggestedRepay)
        ? `Suggested ${usd(d.suggestedRepay, 2)} from the APR`
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

  switch (stage) {
    case 'borrow':
      return (
        row('Date', fmtDate(t.borrow_date)) +
        row('Amount', `${usd(t.borrow_amount)} ${t.borrow_currency}`) +
        row('APR', pct(t.borrow_apr)) +
        row(d.stages.repaid ? 'Loan length' : 'Running for', isNum(d.days) ? `${d.days} days` : '')
      );
    case 'buy':
      return (
        row('Date', fmtDate(t.buy_date)) +
        row('Spent', usd(t.buy_amount)) +
        row('Bought', eth(t.buy_eth)) +
        row('ETH price', usd(d.buyPrice))
      );
    case 'sell':
      return (
        row('Date', fmtDate(t.sell_date)) +
        row('Sold', eth(t.sell_eth)) +
        row('Received', usd(t.sell_amount)) +
        row('ETH price', usd(d.sellPrice)) +
        (d.isPartialSale ? row('Cost of ETH sold', usd(d.costOfSoldEth)) : '') +
        (d.isPartialSale ? row('Still held', eth(d.retainedEth)) : '') +
        row('Gross gain', signedUsd(d.grossGain), gainClass(d.grossGain))
      );
    case 'repay':
      return (
        row('Date', fmtDate(t.repay_date)) +
        row('Repaid', usd(t.repay_amount, 2)) +
        row('Interest', usd(d.accruedInterest, 2)) +
        row('Net gain', signedUsd(d.netGain), gainClass(d.netGain)) +
        row('Annualized', pct(d.pct), gainClass(d.netGain))
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

  const gain = isNum(d.netGain) ? d.netGain : d.projectedNetGain;
  const gainCell = isNum(gain)
    ? `<span class="${gainClass(gain)}">${signedUsd(gain)}</span>${isNum(d.netGain) ? '' : ' <span class="chip">est</span>'}`
    : '<span class="muted">-</span>';

  return `
  <tr class="row ${isOpen ? 'is-open' : ''}" data-trade="${t.id}" tabindex="0">
    <td data-label="Trade">
      <div class="row__asset">
        <span class="caret"></span>
        ${coin(t.borrow_currency)}
        <span class="row__stack">
          <span>${usd(t.borrow_amount)}</span>
          <small>${fmtDate(t.borrow_date)}</small>
        </span>
      </div>
    </td>
    <td data-label="ETH" class="num">${
      isNum(t.buy_eth)
        ? `<span class="eth-cell">${ethMark}${ethQty(t.buy_eth)}</span>`
        : '<span class="muted">-</span>'
    }</td>
    <td data-label="Buy price" class="num">${isNum(d.buyPrice) ? usd(d.buyPrice) : '<span class="muted">-</span>'}</td>
    <td data-label="Sell price" class="num">${isNum(d.sellPrice) ? usd(d.sellPrice) : '<span class="muted">-</span>'}</td>
    <td data-label="Days" class="num">${isNum(d.days) ? d.days : ''}</td>
    <td data-label="Net gain" class="num">${gainCell}</td>
    <td data-label="Annualized" class="num">${isNum(d.pct) ? `<span class="${gainClass(d.netGain)}">${pct(d.pct)}</span>` : '<span class="muted">-</span>'}</td>
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
    const trade = state.trades.find((t) => t.id === Number(openForm.dataset.trade));
    refreshHints(openForm, trade, openForm.dataset.stageForm);
    openForm.querySelector('input, select')?.focus();
  }
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
  return `<table class="table table--flush">
    <thead>
      <tr><th>Stablecoin</th><th>Closed</th><th>Open</th><th>Borrowed</th><th>Net gain</th><th>Avg annualized</th></tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td data-label="Stablecoin"><span class="row__asset">${coin(r.currency)}<span>${esc(r.currency)}</span></span></td>
        <td data-label="Closed" class="num">${r.closed}</td>
        <td data-label="Open" class="num">${r.open || dash}</td>
        <td data-label="Borrowed" class="num">${r.borrowed ? usd(r.borrowed) : dash}</td>
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
  const closedAny = r.closedCount > 0;

  mount.innerHTML = `
    ${summaryCard(
      'Performance',
      `<div class="kv-grid">
        ${statRow('Realized net gain', signedUsd(r.netGain), gainClass(r.netGain))}
        ${statRow('Average annualized', pct(r.avgPct), gainClass(r.avgPct))}
        ${statRow('Interest paid', closedAny ? usd(r.interestPaid) : '')}
        ${statRow(
          'Win rate',
          closedAny ? `${pct(r.winRate, 0)} <span class="muted">(${r.wins} up, ${r.losses} down)</span>` : '',
        )}
        ${statRow('Total borrowed', closedAny ? usd(r.totalBorrowed) : '')}
        ${statRow('Average hold', r.avgHoldDays === null ? '' : `${r.avgHoldDays.toFixed(1)} days`)}
        ${extremeCard('Best trade', r.best)}
        ${extremeCard('Worst trade', r.worst)}
      </div>`,
      closedAny ? `${r.closedCount} closed of ${r.tradeCount}` : 'no closed trades yet',
    )}
    ${summaryCard('By stablecoin', currencyTable(r.byCurrency))}
    ${summaryCard('By month closed', monthTable(r.byMonth))}
  `;
}

function renderStats() {
  const s = summarize(state.trades);
  const tiles = [
    { label: 'Realized net gain', value: signedUsd(s.netGain) || '$0', cls: gainClass(s.netGain) },
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
  renderStats();
  if (state.view === 'summary') renderSummary();
  else renderTable();
}

/* ------------------------------------------------------------- form submit */

function showFormError(form, message, fieldName) {
  form.querySelectorAll('.field.is-invalid').forEach((f) => f.classList.remove('is-invalid'));
  const target = fieldName && form.querySelector(`[data-field="${fieldName}"]`);
  if (target) {
    target.classList.add('is-invalid');
    target.querySelector('[data-hint]').textContent = message;
    form.querySelector('[data-form-error]').textContent = '';
  } else {
    form.querySelector('[data-form-error]').textContent = message;
  }
}

function payloadOf(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = v;
  return out;
}

async function submitStage(form) {
  const id = Number(form.dataset.trade);
  const stage = form.dataset.stageForm;
  try {
    const updated = await api(`/api/trades/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payloadOf(form)),
    });
    state.trades = state.trades.map((t) => (t.id === id ? updated : t));
    state.editing = null;
    render();
    toast(`${STAGES.find((s) => s.key === stage).name} saved.`);
  } catch (err) {
    showFormError(form, err.message, err.field);
  }
}

async function submitBorrow(form) {
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

  borrowForm.addEventListener('input', () => refreshHints(borrowForm, {}, 'borrow'));
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

  // Stage forms are recreated on every render, so listen at the document level.
  document.body.addEventListener('input', (e) => {
    const form = e.target.closest('[data-stage-form]');
    if (!form) return;
    if (e.target.name === 'repay_amount' && e.isTrusted) delete e.target.dataset.auto;
    const trade = state.trades.find((t) => t.id === Number(form.dataset.trade));
    refreshHints(form, trade, form.dataset.stageForm);
  });

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
