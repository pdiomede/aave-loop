#!/usr/bin/env node
/**
 * Checks for lib/statement.js: the one-page PDF behind the Statement button on
 * Stats. `npm run check` runs them after the input checks.
 *
 * The file is the very one the browser runs (it is served from
 * /lib/statement.js), so a statement built here is the one a click downloads.
 * The PDF is written by hand, so the first checks are that it is one: every
 * cross-reference offset lands on its object, the stream is the length it
 * says, and there is one page. The rest read the text the page sets - every
 * string is a literal `(...) Tj` - against figures worked out by hand.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statsYear } from '../lib/calc.js';
import { LOGO } from '../lib/logo.js';
import { logoFromPng } from './make-logo.mjs';
import { statementPdf, statementFileName, pdfString, closedTrades } from '../lib/statement.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}\n  ${err.message.split('\n').join('\n  ')}`);
    process.exitCode = 1;
  }
}

const AS_OF = '2026-10-07';
// latin1, a byte to a character: a spread of every byte as arguments would
// overflow the call stack on a large enough file.
const text = (bytes) => new TextDecoder('latin1').decode(bytes);
const build = (trades, year = '2026', asOf = AS_OF) =>
  text(statementPdf(trades.filter((t) => statsYear(t, asOf) === year), year, asOf));
// A string the page sets, as it appears in the content stream.
const shows = (pdf, s) => pdf.includes(`${pdfString(s)} Tj`);

// A dollar loan bought and sold the same way: borrowed and spent `loan` on
// 4 ETH, sold for `proceeds`, repaid the principal at 0% on the day it sold.
let nextId = 1;
const trade = ({ loan, proceeds, buyGas, sellGas, month = '03', currency = 'USDT', open = false, ...over }) => ({
  id: nextId++,
  borrow_currency: currency,
  borrow_date: `2026-${month}-01`,
  borrow_amount: loan,
  borrow_apr: 0,
  borrow_gas_usd: 0,
  buy_date: `2026-${month}-01`,
  buy_amount: loan,
  buy_eth: 4,
  buy_gas_usd: buyGas,
  ...(open
    ? {}
    : {
        sell_date: `2026-${month}-11`,
        sell_amount: proceeds,
        sell_eth: 4,
        sell_gas_usd: sellGas,
        repay_date: `2026-${month}-11`,
        repay_amount: loan,
        repay_gas_usd: 0,
      }),
  ...over,
});

/* ------------------------------------------------------------- the module */

check('lib/statement.js imports calc.js and the logo, nothing else', () => {
  const src = readFileSync(new URL('../lib/statement.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./calc.js', './logo.js']);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  const logo = readFileSync(new URL('../lib/logo.js', import.meta.url), 'utf8');
  assert.doesNotMatch(logo, /^\s*import\s/m, 'the logo is data alone');
});

check('lib/logo.js is the logo the app shows, not an older copy', () => {
  const png = readFileSync(new URL('../public/AaveLoop_logo_96.png', import.meta.url));
  assert.deepEqual(LOGO, logoFromPng(png), 'run node scripts/make-logo.mjs');
});

check('the logo is drawn, clipped round, from its image object', () => {
  const pdf = build([trade({ loan: 1000, proceeds: 1100, buyGas: 1, sellGas: 1 })]);
  assert.match(pdf, /\/XObject << \/Logo 8 0 R >>/);
  assert.match(pdf, /8 0 obj\n<< \/Type \/XObject \/Subtype \/Image \/Width 96 \/Height 96 /);
  assert.match(pdf, /\/DecodeParms \[null << \/Predictor 15 \/Colors 3 \/BitsPerComponent 8 \/Columns 96 >>\]/);
  assert.match(pdf, /q [^Q]* W n 22 0 0 22 36 [\d.]+ cm \/Logo Do Q/);
});

check('the file name carries the year', () => {
  assert.equal(statementFileName('2026'), 'aave-loop-statement-2026.pdf');
  assert.equal(statementFileName('../x'), 'aave-loop-statement-all.pdf');
});

/* --------------------------------------------------------------- the file */

const sample = [
  trade({ loan: 10000, proceeds: 11000, buyGas: 2, sellGas: 3 }),
  trade({ loan: 5000, proceeds: 4800, buyGas: 1, sellGas: 1 }),
];

check('a well-formed PDF: offsets, stream length, trailer, one page', () => {
  const pdf = build(sample);
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.endsWith('%%EOF\n'));
  assert.match(pdf, /^[\x0a\x20-\x7e]*$/, 'ASCII only, so a character is a byte');

  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.ok(pdf.startsWith('xref\n', startxref), 'startxref points at the table');
  const table = pdf.slice(startxref).split('\n');
  const [, count] = table[1].split(' ').map(Number);
  assert.equal(count, 10, 'eight fixed objects and the site link');
  for (let n = 1; n < count; n += 1) {
    const offset = Number(table[2 + n].slice(0, 10));
    assert.ok(pdf.startsWith(`${n} 0 obj\n`, offset), `object ${n} at ${offset}`);
  }
  assert.match(pdf, new RegExp(`/Size ${count} /Root 1 0 R`));

  for (const [, length, stream] of pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
    assert.equal(stream.length, Number(length), 'every stream is the length it says');
  }

  assert.match(pdf, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1 >>/);
  assert.equal(pdf.match(/\/Type \/Page\b(?!s)/g).length, 1);
});

check('strings are escaped and set in WinAnsi', () => {
  assert.equal(pdfString('a(b)c\\'), '(a\\(b\\)c\\\\)');
  assert.equal(pdfString('€ 5 · x'), '(\\200 5 \\267 x)');
  // Not a byte the font would map to some other letter.
  assert.equal(pdfString('café \u{1F600}'), '(caf? ?)');
});

/* ------------------------------------------------------------ the figures */

check('hand-worked year: totals, extremes, month, version', () => {
  const pdf = build(sample);
  // +1,000 less 5 of gas, and -200 less 2: +995 and -202, +793 between them.
  assert.ok(shows(pdf, '2026 statement'));
  assert.ok(shows(pdf, '1 Jan \u2013 7 Oct 2026'), 'the period, to the day it was drawn');
  assert.ok(!/\(v\d+\.\d+\.\d+\) Tj/.test(pdf), 'no version on the statement');
  assert.ok(!pdf.includes('Trades count in the year'), 'no scope note');
  assert.ok(shows(pdf, '+$793.00'), 'realized net gain');
  assert.ok(shows(pdf, '$15,000.00'), 'total borrowed');
  assert.ok(shows(pdf, '$7.00'), 'total fees paid');
  assert.ok(shows(pdf, '10.0 days'), 'average hold');
  assert.ok(shows(pdf, 'Biggest gain in USD') && shows(pdf, '+$995.00'));
  assert.ok(shows(pdf, 'Biggest loss in USD') && shows(pdf, '-$202.00'));
  assert.ok(shows(pdf, '2 closed trades'));
  assert.ok(shows(pdf, 'Mar 2026'), 'month row');
  assert.ok(shows(pdf, 'USDT'), 'currency row');
});

check('a closing statement: open trades are left out of every figure', () => {
  // Open, and in a currency of its own, so any trace of it would show.
  const held = trade({ loan: 8000, buyGas: 2, month: '09', open: true, currency: 'GHO' });
  const unrated = trade({ loan: 9000, buyGas: 2, month: '10', open: true, currency: 'EURC' });
  const pdf = build([...sample, held, unrated]);
  assert.equal(pdf, build(sample), 'the same file as without them');
  assert.ok(!shows(pdf, 'Open positions') && !shows(pdf, 'OPEN') && !shows(pdf, 'GHO'));
  assert.ok(shows(pdf, '$15,000.00'), 'total borrowed is the closed trades\' alone');
  assert.ok(!pdf.includes('no exchange rate yet'), 'an open trade without a rate is not warned about');
  assert.deepEqual(closedTrades([...sample, held]).map((t) => t.id), sample.map((t) => t.id));
});

check('the period: the year to date, or the whole of a past year', () => {
  assert.ok(shows(build(sample), 'Closed trades, year to date'));
  const later = build(sample, '2026', '2027-02-01');
  assert.ok(shows(later, '1 Jan \u2013 31 Dec 2026'));
  assert.ok(shows(later, 'Closed trades'));
  assert.ok(!shows(later, 'Closed trades, year to date'));
});

check('the header names the site and links to it', () => {
  const pdf = build(sample);
  assert.ok(shows(pdf, 'Aave Loop') && shows(pdf, ' :: aaveloop.com'));
  assert.match(pdf, /\/Annots \[9 0 R\]/);
  assert.match(pdf, /\/Subtype \/Link \/Rect \[[\d. ]+\] \/Border \[0 0 0\] \/A << \/S \/URI \/URI \(https:\/\/aaveloop\.com\) >>/);
});

check('a figure that prints as zero carries no minus, and is not called a loss', () => {
  // Gross +0.996 less a dollar of gas: -0.004, which prints $0.00.
  const flat = trade({ loan: 1000, proceeds: 1000.996, buyGas: 0.5, sellGas: 0.5 });
  const pdf = build([flat]);
  assert.ok(shows(pdf, '$0.00'));
  assert.ok(!pdf.includes('(-$0.00)'));
  assert.ok(!shows(pdf, 'Biggest loss in USD'));
  assert.ok(shows(pdf, 'Smallest gain in USD'));
});

check('a closed euro trade with no rate is "no rate", not $0.00', () => {
  const pdf = build([trade({ loan: 9000, proceeds: 9500, buyGas: 1, sellGas: 1, currency: 'EURC' })]);
  assert.ok(shows(pdf, 'no rate'));
  assert.ok(shows(pdf, '1 trade has no exchange rate yet, so its result is left out of the totals below.'));
  assert.ok(!shows(pdf, '$0.00'), 'nothing measured is printed as zero');
  assert.ok(shows(pdf, '-'), 'a dash where the rate is missing');
  assert.ok(shows(pdf, '1 closed trade, none with a rate yet'));
});

check('a full year - twelve months, every coin, a warning - still fits one page', () => {
  const coins = ['USDT', 'EURC', 'DAI', 'USDC', 'GHO'];
  const year = Array.from({ length: 12 }, (_, i) => {
    const currency = coins[i % coins.length];
    const fx = currency === 'EURC' ? { borrow_fx: 1.1, buy_fx: 1.1, sell_fx: 1.11, repay_fx: 1.12 } : {};
    return trade({
      loan: 123456.78 + i,
      proceeds: 123456.78 + (i % 3 === 0 ? -9876.54 : 98765.43),
      buyGas: 12.34,
      sellGas: 5.67,
      month: String(i + 1).padStart(2, '0'),
      currency,
      ...fx,
    });
  });
  // Closed without a rate, so the warning line and every chip are drawn.
  year.push(trade({ loan: 50000, proceeds: 52000, buyGas: 1, sellGas: 1, month: '09', currency: 'EURC' }));
  const pdf = build(year);
  assert.equal(pdf.match(/\/Type \/Page\b(?!s)/g).length, 1);
  for (const m of ['Jan 2026', 'Jun 2026', 'Dec 2026']) assert.ok(shows(pdf, m), m);
  for (const c of coins) assert.ok(shows(pdf, c), c);
});

if (process.exitCode) console.error(`\n${passed} passed, some failed.`);
else console.log(`ok - ${passed} statement checks`);
