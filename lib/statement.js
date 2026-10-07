/**
 * A year tab on Stats as a one-page PDF, for the Statement button.
 *
 * Pure and synchronous like `lib/csv.js`, and served to the browser from
 * /lib/statement.js exactly as Node imports it, so the file can be checked from
 * the command line against the figures the page shows. It imports calc.js and
 * nothing else: the PDF is written by hand rather than by a library, because
 * nothing here is built or bundled and the production Content-Security-Policy
 * would not let the page load one from a CDN anyway.
 *
 * Every figure comes from `summaryReport`, the call the Stats view itself
 * makes over the same trades on the same `asOf`, so the statement and the cards
 * cannot describe different things. Where a card decides what to print - a
 * dash, a "no rate" chip, a label that flips to "loss" - the same decision is
 * made here, and the comments beside the card in public/app.js say why.
 *
 * The whole file is ASCII. Text is set in the standard Helvetica pair, which
 * every reader has and nothing embeds, in WinAnsiEncoding; a character outside
 * plain ASCII is written as an octal escape inside its string. So the string
 * length is the byte length, and the cross-reference offsets are simply
 * `String.length`.
 */
import { isUsdPegged, summaryReport, todayISO } from './calc.js';

/* ------------------------------------------------------------- formatting */

// The page's own formatters, as plain text. `format.js` has a set too, but it
// is server-only and never served, and public/app.js's build HTML. The rules
// are theirs: a figure nobody measured is a dash, and sign and colour come from
// the figure as printed, so -0.004 is `$0.00` with no minus and no red.

const DASH = '-';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const printsZero = (v, dp) => Number(Math.abs(v).toFixed(dp)) === 0;
const amount = (v, dp = 2) =>
  Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const usd = (v) => (isNum(v) ? `${v < 0 && !printsZero(v, 2) ? '-' : ''}$${amount(v)}` : '');
const signedUsd = (v) => (isNum(v) ? `${printsZero(v, 2) ? '' : v < 0 ? '-' : '+'}$${amount(v)}` : '');
const pct = (v) => (isNum(v) ? `${v < 0 && !printsZero(v, 2) ? '-' : ''}${Math.abs(v).toFixed(2)}%` : '');
const signedPct = (v) => (isNum(v) ? `${printsZero(v, 2) ? '' : v < 0 ? '-' : '+'}${Math.abs(v).toFixed(2)}%` : '');
const tone = (v) => (!isNum(v) ? '' : printsZero(v, 2) ? 'flat' : v >= 0 ? 'pos' : 'neg');

function fmtDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? '?'} ${y}`;
}

/* --------------------------------------------------------------- the font */

// Advance widths in thousandths of an em, from Adobe's AFM files for the two
// standard fonts, for ASCII 32 to 126. They are what lets a figure be set flush
// right and a long line be wrapped; a reader draws the glyphs itself.
// prettier-ignore
const WIDTHS = {
  F1: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  F2: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};

// The few characters beyond ASCII that this page writes, at their WinAnsi
// codes. Anything else becomes `?` rather than a wrong glyph: a currency name or
// a date arrives from the database, and a byte the font maps to some other
// letter would print a word that was never typed.
const WIN_ANSI = { '€': [0o200, 556], '·': [0o267, 278], '–': [0o226, 556], '—': [0o227, 1000] };

function glyphs(text) {
  return [...String(text)].map((ch) => {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) return { ch, code: c };
    if (WIN_ANSI[ch]) return { ch, code: WIN_ANSI[ch][0] };
    return { ch: '?', code: 63 };
  });
}

function textWidth(text, font, size) {
  let w = 0;
  for (const { ch, code } of glyphs(text)) {
    w += code <= 126 ? WIDTHS[font][code - 32] : WIN_ANSI[ch][1];
  }
  return (w * size) / 1000;
}

/** A PDF string literal: `\ ( )` escaped, anything past ASCII as octal. */
export function pdfString(text) {
  let out = '';
  for (const { code } of glyphs(text)) {
    if (code === 92 || code === 40 || code === 41) out += `\\${String.fromCharCode(code)}`;
    else if (code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `(${out})`;
}

function wrap(text, font, size, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, font, size) > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/* --------------------------------------------------------------- the page */

// A4 portrait, in points. y is measured from the top in everything below and
// turned over only when an operator is written.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;

// The light theme's tokens from public/styles.css: a statement is for paper.
const COLOR = {
  text: [0x0b, 0x0b, 0x0b],
  muted: [0x6e, 0x76, 0x81],
  faint: [0x9a, 0xa0, 0xaa],
  sunken: [0xf4, 0xf4, 0xf5],
  surface: [0xff, 0xff, 0xff],
  hairline: [0xe3, 0xe4, 0xe7],
  accent: [0x6b, 0x66, 0xff],
  pos: [0x1c, 0x7c, 0x54],
  neg: [0xc0, 0x36, 0x2c],
  flat: [0x6e, 0x76, 0x81],
  warn: [0x9a, 0x67, 0x00],
  warnSoft: [0xf3, 0xec, 0xdc],
  barTrack: [0xec, 0xed, 0xef],
};

// Each coin's brand colour, standing in for its icon.
const COIN_COLOR = {
  USDC: [0x27, 0x75, 0xca],
  USDT: [0x26, 0xa1, 0x7b],
  DAI: [0xf5, 0xac, 0x37],
  GHO: [0x9b, 0x8a, 0xf2],
  EURC: [0x2f, 0x6f, 0xdb],
};

const rgb = ([r, g, b]) => `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`;
const f = (v) => Number(v.toFixed(2)).toString();

class Canvas {
  constructor() {
    this.ops = [];
    this.lowest = 0;
  }

  // Everything drawn is measured against the bottom margin. Overflowing it
  // throws rather than clipping, because a statement that has quietly lost its
  // last rows still looks complete.
  reach(y) {
    this.lowest = Math.max(this.lowest, y);
    if (y > PAGE_H - MARGIN + 0.01) {
      throw new Error(`statement runs past one page (${f(y)}pt of ${f(PAGE_H - MARGIN)}pt)`);
    }
  }

  text(x, y, str, { font = 'F1', size = 9, color = COLOR.text, align = 'left' } = {}) {
    const s = String(str);
    if (!s) return 0;
    const w = textWidth(s, font, size);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.reach(y + size * 0.25);
    this.ops.push(`BT /${font} ${f(size)} Tf ${rgb(color)} rg ${f(left)} ${f(PAGE_H - y)} Td ${pdfString(s)} Tj ET`);
    return w;
  }

  rect(x, y, w, h, { fill = null, stroke = null, radius = 0, lineWidth = 0.6 } = {}) {
    this.reach(y + h);
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    const style = `${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${f(lineWidth)} w ` : ''}`;
    const r = Math.min(radius, w / 2, h / 2);
    const X = x;
    const Y = PAGE_H - y - h;
    if (r <= 0) {
      this.ops.push(`${style}${f(X)} ${f(Y)} ${f(w)} ${f(h)} re ${op}`);
      return;
    }
    // Four quarter circles, each a cubic with the usual 0.5523 handle.
    const k = r * 0.5523;
    this.ops.push(
      `${style}${f(X + r)} ${f(Y)} m ${f(X + w - r)} ${f(Y)} l ` +
        `${f(X + w - r + k)} ${f(Y)} ${f(X + w)} ${f(Y + r - k)} ${f(X + w)} ${f(Y + r)} c ` +
        `${f(X + w)} ${f(Y + h - r)} l ${f(X + w)} ${f(Y + h - r + k)} ${f(X + w - r + k)} ${f(Y + h)} ${f(X + w - r)} ${f(Y + h)} c ` +
        `${f(X + r)} ${f(Y + h)} l ${f(X + r - k)} ${f(Y + h)} ${f(X)} ${f(Y + h - r + k)} ${f(X)} ${f(Y + h - r)} c ` +
        `${f(X)} ${f(Y + r)} l ${f(X)} ${f(Y + r - k)} ${f(X + r - k)} ${f(Y)} ${f(X + r)} ${f(Y)} c h ${op}`,
    );
  }

  line(x1, y, x2, color = COLOR.hairline, width = 0.6) {
    this.reach(y);
    this.ops.push(`${rgb(color)} RG ${f(width)} w ${f(x1)} ${f(PAGE_H - y)} m ${f(x2)} ${f(PAGE_H - y)} l S`);
  }

  dot(cx, cy, r, color) {
    this.rect(cx - r, cy - r, r * 2, r * 2, { fill: color, radius: r });
  }

  /** The "no rate" chip, the one the page draws beside a partial total. */
  chip(x, y, size = 7.5) {
    const label = 'no rate';
    const w = textWidth(label, 'F2', size) + 8;
    this.rect(x, y - size - 1.5, w, size + 5, { fill: COLOR.warnSoft, radius: 3 });
    this.text(x + 4, y, label, { font: 'F2', size, color: COLOR.warn });
    return w;
  }
}

/**
 * A figure on a tile: its text, its colour, and whether a "no rate" chip
 * follows it. An empty text is a dash.
 */
function figure(text, cls = '', noRate = false) {
  return { text: text || (noRate ? '' : DASH), cls, noRate };
}

/** The value as large as it fits in `maxW`, down to a floor. */
function fitSize(text, font, size, maxW, floor = 9) {
  let s = size;
  while (s > floor && textWidth(text, font, s) > maxW) s -= 0.5;
  return s;
}

function drawFigure(c, x, y, fig, size, maxW) {
  const chipW = fig.noRate ? textWidth('no rate', 'F2', 7.5) + 12 : 0;
  const s = fitSize(fig.text, 'F2', size, maxW - chipW);
  const w = c.text(x, y, fig.text, { font: 'F2', size: s, color: COLOR[fig.cls] ?? COLOR.text });
  if (fig.noRate) c.chip(x + w + (w ? 5 : 0), y - (s - 7.5) / 2);
}

/** A card: a sunken panel with its title, an optional note, and a rule. */
function card(c, y, title, height, note = '') {
  c.rect(MARGIN, y, CONTENT_W, height, { fill: COLOR.sunken, radius: 7 });
  c.text(MARGIN + 14, y + 19, title, { font: 'F2', size: 10.5 });
  if (note) c.text(MARGIN + CONTENT_W - 14, y + 19, note, { size: 8.5, color: COLOR.muted, align: 'right' });
  c.line(MARGIN, y + 28, MARGIN + CONTENT_W, COLOR.hairline);
  return y + 28;
}

/* ------------------------------------------------------------- the content */

// The labels that flip, as `bestLabel` / `worstLabel` in public/app.js: on a
// year that lost money the second of a pair is a loss, and the card says so.
function bestLabel(entry, key, unit) {
  const v = entry ? entry[key] : null;
  return isNum(v) && v < 0 && !printsZero(v, 2) ? `Smallest loss in ${unit}` : `Biggest gain in ${unit}`;
}

function worstLabel(entry, key, unit) {
  const v = entry ? entry[key] : null;
  return isNum(v) && v < 0 && !printsZero(v, 2) ? `Biggest loss in ${unit}` : `Smallest gain in ${unit}`;
}

function extremeTile(label, entry, by) {
  if (!entry) return { label, fig: figure('') };
  const rate = isNum(entry.pct) ? `${signedPct(entry.pct)} annualized` : '';
  const money = isNum(entry.netGain) ? signedUsd(entry.netGain) : '';
  const headline = by === 'pct' ? entry.pct : entry.netGain;
  return {
    label,
    fig: figure(by === 'pct' ? signedPct(entry.pct) : signedUsd(entry.netGain), tone(headline)),
    sub: [`${entry.currency}, ${fmtDate(entry.date)}`, by === 'pct' ? money : rate].filter(Boolean).join(' · '),
  };
}

/** The four overview tiles, as `statTiles` draws them on a year tab. */
function overviewTiles(r, showOpen) {
  const closedNoRate = r.closedCount > r.valuedCount;
  const tiles = [
    { label: 'Realized net gain', fig: figure(signedUsd(r.netGain), tone(r.netGain), closedNoRate) },
    { label: 'Blended annualized', fig: figure(pct(r.avgPct), tone(r.avgPct)) },
    { label: 'Closed trades', fig: figure(String(r.closedCount)) },
  ];
  if (showOpen) {
    tiles.push({
      label: 'Open positions',
      fig: r.openCount
        ? figure(`${r.openCount}${isNum(r.deployed) ? ` (${usd(r.deployed)})` : ''}`, '', r.deployedMissingFx > 0)
        : figure('0'),
    });
  }
  return tiles;
}

/** The Performance card's eight tiles, in the order the page lays them out. */
function performanceTiles(r) {
  const valuedAny = r.valuedCount > 0;
  return [
    { label: 'Interest paid', fig: figure(valuedAny ? usd(r.interestPaid) : '') },
    {
      label: 'Total borrowed',
      fig: figure(r.totalBorrowed > 0 ? usd(r.totalBorrowed) : '', '', r.totalBorrowedMissingFx > 0),
    },
    { label: 'Average hold', fig: figure(r.avgHoldDays === null ? '' : `${r.avgHoldDays.toFixed(1)} days`) },
    {
      label: 'Total fees paid',
      fig: figure(isNum(r.feesPaid) ? usd(r.feesPaid) : ''),
      sub:
        r.feesUnrecorded > 0
          ? `${r.feesUnrecorded} trade${r.feesUnrecorded === 1 ? '' : 's'} with fees not recorded`
          : '',
    },
    extremeTile(bestLabel(r.best, 'netGain', 'USD'), r.best, 'usd'),
    extremeTile(worstLabel(r.worst, 'netGain', 'USD'), r.worst, 'usd'),
    extremeTile(bestLabel(r.bestPct, 'pct', '%'), r.bestPct, 'pct'),
    extremeTile(worstLabel(r.worstPct, 'pct', '%'), r.worstPct, 'pct'),
  ];
}

function performanceNote(r) {
  if (r.valuedCount > 0) return `${r.closedCount} closed of ${r.tradeCount}`;
  if (r.closedCount > 0) return `${r.closedCount} closed of ${r.tradeCount}, none with a rate yet`;
  return 'no closed trades yet';
}

const SCOPE_NOTE = 'Trades count in the year they were repaid.';
const SCOPE_OPEN = ' Trades still open count here, in the current year.';
const FOOT_NOTE =
  'Every figure is in US dollars. Amounts in a currency other than the dollar are converted at the ' +
  'European Central Bank reference rate for the day of each transaction, or for the last business ' +
  'day before it.';

function draw(c, r, year, asOf, version) {
  const current = asOf.slice(0, 4);
  const right = MARGIN + CONTENT_W;
  let y = MARGIN;

  // --- header
  c.text(MARGIN, y + 10, 'Aave Loop', { font: 'F2', size: 10, color: COLOR.accent });
  c.text(MARGIN, y + 34, `${year} statement`, { font: 'F2', size: 22 });
  c.text(right, y + 10, `As of ${fmtDate(asOf)}`, { size: 9, color: COLOR.muted, align: 'right' });
  if (version) c.text(right, y + 23, version, { size: 9, color: COLOR.faint, align: 'right' });
  y += 46;

  for (const line of wrap(`${SCOPE_NOTE}${year === current ? SCOPE_OPEN : ''}`, 'F1', 8.5, CONTENT_W)) {
    c.text(MARGIN, y + 8.5, line, { size: 8.5, color: COLOR.muted });
    y += 12;
  }
  // Scoped to the year, unlike the page's banner: the banner sits above a
  // button that fetches every year's rates, and this sits above one year.
  if (r.missingFx > 0) {
    const n = r.missingFx;
    const msg =
      `${n} trade${n === 1 ? ' has' : 's have'} no exchange rate yet, so ` +
      `${n === 1 ? 'its result is' : 'their results are'} left out of the totals below.`;
    c.text(MARGIN, y + 8.5, msg, { font: 'F2', size: 8.5, color: COLOR.warn });
    y += 12;
  }
  y += 8;

  // --- overview
  const ov = overviewTiles(r, year === current);
  y = card(c, y, `${year} overview`, 76);
  const ovW = (CONTENT_W - 28) / 4;
  ov.forEach((t, i) => {
    const x = MARGIN + 14 + i * ovW;
    c.text(x, y + 16, t.label, { size: 8.5, color: COLOR.muted });
    drawFigure(c, x, y + 37, t.fig, 17, ovW - 10);
  });
  y += 48 + 10;

  // --- performance
  const perf = performanceTiles(r);
  const tileH = 56;
  const gap = 8;
  y = card(c, y, 'Performance', 28 + 14 + tileH * 2 + gap + 14, performanceNote(r));
  y += 14;
  const tileW = (CONTENT_W - 28 - gap * 3) / 4;
  perf.forEach((t, i) => {
    const x = MARGIN + 14 + (i % 4) * (tileW + gap);
    const ty = y + Math.floor(i / 4) * (tileH + gap);
    c.rect(x, ty, tileW, tileH, { fill: COLOR.surface, stroke: COLOR.hairline, radius: 5 });
    c.text(x + 9, ty + 14, t.label, { size: 7.5, color: COLOR.muted });
    drawFigure(c, x + 9, ty + 31, t.fig, 13, tileW - 18);
    wrap(t.sub ?? '', 'F1', 6.8, tileW - 18)
      .slice(0, 2)
      .forEach((line, j) => c.text(x + 9, ty + 42 + j * 8, line, { size: 6.8, color: COLOR.muted }));
  });
  y += tileH * 2 + gap + 14 + 10;

  // --- by currency
  const rows = r.byCurrency;
  const curRowH = 17;
  const curBody = rows.length ? 18 + rows.reduce((h, row) => h + curRowH + (nativeLine(row) ? 7 : 0), 0) : 22;
  y = card(c, y, 'By currency', 28 + curBody + 8);
  const cx = MARGIN + 14;
  const cw = CONTENT_W - 28;
  // Right edges of the numeric columns, as fractions of the table.
  const curCols = [
    ['Closed', 0.36],
    ['Open', 0.46],
    ['Borrowed', 0.65],
    ['Net gain', 0.81],
    ['Avg annualized', 1],
  ];
  if (!rows.length) {
    c.text(cx, y + 15, 'Nothing borrowed yet.', { size: 8.5, color: COLOR.muted });
  } else {
    c.text(cx, y + 13, 'CURRENCY', { font: 'F2', size: 6.8, color: COLOR.muted });
    for (const [label, at] of curCols) {
      c.text(cx + cw * at, y + 13, label.toUpperCase(), { font: 'F2', size: 6.8, color: COLOR.muted, align: 'right' });
    }
    let ry = y + 18;
    rows.forEach((row, i) => {
      const native = nativeLine(row);
      const h = curRowH + (native ? 7 : 0);
      if (i > 0) c.line(cx, ry, cx + cw);
      const base = ry + 11.5;
      c.dot(cx + 4, base - 3, 4, COIN_COLOR[row.currency] ?? COLOR.faint);
      const nameW = c.text(cx + 13, base, row.currency, { size: 8.5 });
      if (row.missingFx) c.chip(cx + 13 + nameW + 5, base - 0.5, 6.5);
      const cell = (at, text, cls = '') =>
        c.text(cx + cw * at, base, text || DASH, { size: 8.5, color: COLOR[cls] ?? COLOR.text, align: 'right' });
      cell(0.36, row.closed ? String(row.closed) : '');
      cell(0.46, row.open ? String(row.open) : '');
      cell(0.65, usd(row.borrowed));
      if (native) c.text(cx + cw * 0.65, base + 8.5, native, { size: 6.8, color: COLOR.muted, align: 'right' });
      cell(0.81, signedUsd(row.netGain), tone(row.netGain));
      cell(1, pct(row.avgPct), tone(row.avgPct));
      ry += h;
    });
  }
  y += curBody + 8 + 10;

  // --- by month closed
  const months = r.byMonth;
  const monthRowH = 14.5;
  const monthBody = months.length ? 18 + months.length * monthRowH : 22;
  y = card(c, y, 'By month closed', 28 + monthBody + 8);
  if (!months.length) {
    c.text(cx, y + 15, 'No trades have been closed yet.', { size: 8.5, color: COLOR.muted });
  } else {
    c.text(cx, y + 13, 'MONTH', { font: 'F2', size: 6.8, color: COLOR.muted });
    c.text(cx + cw * 0.3, y + 13, 'TRADES', { font: 'F2', size: 6.8, color: COLOR.muted, align: 'right' });
    c.text(cx + cw * 0.5, y + 13, 'NET GAIN', { font: 'F2', size: 6.8, color: COLOR.muted, align: 'right' });
    c.text(cx + cw, y + 13, 'SHARE', { font: 'F2', size: 6.8, color: COLOR.muted, align: 'right' });
    // The largest month fills its bar, and a month printed $0.00 sets no
    // scale - the rule `monthTable` keeps on the page.
    const peak = Math.max(...months.map((m) => (printsZero(m.netGain, 2) ? 0 : Math.abs(m.netGain)))) || 1;
    const barX = cx + cw * 0.55;
    const barW = cw * 0.45;
    let ry = y + 18;
    months.forEach((m, i) => {
      if (i > 0) c.line(cx, ry, cx + cw);
      const base = ry + 10;
      c.text(cx, base, m.label, { size: 8.5 });
      c.text(cx + cw * 0.3, base, String(m.trades), { size: 8.5, align: 'right' });
      const cls = tone(m.netGain);
      c.text(cx + cw * 0.5, base, signedUsd(m.netGain), { size: 8.5, color: COLOR[cls] ?? COLOR.text, align: 'right' });
      c.rect(barX, base - 5, barW, 4, { fill: COLOR.barTrack, radius: 2 });
      const share = Math.max(Math.abs(m.netGain) / peak, 0.02);
      c.rect(barX, base - 5, barW * share, 4, { fill: COLOR[cls] ?? COLOR.faint, radius: 2 });
      ry += monthRowH;
    });
  }
  y += monthBody + 8 + 10;

  // --- foot
  for (const line of wrap(FOOT_NOTE, 'F1', 7.5, CONTENT_W)) {
    c.text(MARGIN, y + 7.5, line, { size: 7.5, color: COLOR.muted });
    y += 10;
  }
}

/** The native total under Borrowed, for a coin that is not a dollar. */
function nativeLine(row) {
  return isNum(row.borrowed) && isNum(row.borrowedNative) && !isUsdPegged(row.currency)
    ? `${row.borrowedNative < 0 ? '-' : ''}${amount(row.borrowedNative)} ${row.currency}`
    : '';
}

/* ------------------------------------------------------------- the file */

function pdfFile(content, title, producer) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(PAGE_W)} ${f(PAGE_H)}] ` +
      '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfString(title)} /Producer ${pdfString(producer)} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/**
 * The statement for one year tab, as the bytes of a PDF.
 *
 * `trades` are the tab's trades - the caller filters them with `statsYear`,
 * the way the Stats view does - and `asOf` the day the tab was drawn. The text
 * is ASCII throughout (see the top of the file), so each character is a byte.
 */
export function statementPdf(trades, year, asOf = todayISO(), { version = '' } = {}) {
  const r = summaryReport(trades, asOf);
  const c = new Canvas();
  draw(c, r, String(year), asOf, version);
  const text = pdfFile(c.ops.join('\n'), `Aave Loop statement ${year}`, `Aave Loop${version ? ` ${version}` : ''}`);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** The file name for a year: aave-loop-statement-2026.pdf. */
export function statementFileName(year) {
  return `aave-loop-statement-${/^\d{4}$/.test(String(year)) ? year : 'all'}.pdf`;
}

// Exported for the checks, which measure what fits.
export const STATEMENT_PAGE = { width: PAGE_W, height: PAGE_H, margin: MARGIN };
