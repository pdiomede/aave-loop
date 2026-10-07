#!/usr/bin/env node
/**
 * Checks for the server, the alert sweep and the bot's reports. `npm run check`
 * runs them after scripts/check-calc.mjs.
 *
 * The arithmetic has its own checks. These cover what only shows when the
 * pieces run: the rules the API enforces on a write, the message an alert
 * sends, and what the sweep does with each way a send can fail. Every one was
 * a bug found by hand and fixed in 1.5.0, and nothing else would notice it
 * coming back.
 *
 * Nothing here touches the network or data/myaave.db. The server runs as a
 * child process on a free port against a database in a temporary directory,
 * and Telegram and the price service are a mock on loopback. Expected values
 * are written out from the inputs, as in check-calc.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaveloop-check-'));

// Written straight to the streams: the sweep below runs in this process, and
// its own log lines are silenced so a passing run prints one line.
const say = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    warn(`FAIL ${name}\n  ${String(err.message).split('\n').join('\n  ')}`);
    process.exitCode = 1;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------- mocks */

// Telegram and CoinGecko in one loopback server. `mock.tg` is a queue of
// answers to sendMessage, [status, description]; empty means 200.
const mock = { price: 3000, tg: [], sent: [] };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/coins/markets')) {
      return res.end(JSON.stringify([{ id: 'ethereum', current_price: mock.price }]));
    }
    if (req.url.includes('/sendMessage')) {
      const [status = 200, description = ''] = mock.tg.shift() ?? [];
      if (status === 200) {
        mock.sent.push(JSON.parse(body).text);
        return res.end('{"ok":true,"result":{}}');
      }
      res.statusCode = status;
      return res.end(JSON.stringify({ ok: false, error_code: status, description }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mockServer.address().port}`;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// Nothing from the developer's own setup may leak in: no real token, no fixed
// price, no other config file.
const isolated = {
  MYAAVE_CONFIG: path.join(tmp, 'none.env'),
  MYAAVE_TELEGRAM_URL: MOCK,
  MYAAVE_ETH_URL: MOCK,
  MYAAVE_FX_OFFLINE: '1',
  MYAAVE_BOT_OFF: '1',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  TELEGRAM_OWNER_ID: '',
};

/* ----------------------------------------------------------------- the API */

const port = await freePort();
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    ...isolated,
    PORT: String(port),
    MYAAVE_DB: path.join(tmp, 'api.db'),
    MYAAVE_ETH_OFFLINE: '1',
    MYAAVE_ETH_PRICE: '3000',
    MYAAVE_ALERT_POLL_MS: '3600000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));

const BASE = `http://localhost:${port}`;
async function api(method, url, body, { json = true } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: json ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, type: res.headers.get('content-type') || '', data };
}

for (let i = 0; i < 50; i += 1) {
  try {
    if ((await fetch(`${BASE}/api/version`)).ok) break;
  } catch {
    /* not listening yet */
  }
  await wait(100);
}

const { todayISO } = await import('../lib/calc.js');
const { fmtDate } = await import('../format.js');
const today = todayISO();
const borrow = (over = {}) => ({
  borrow_date: '2026-09-01',
  borrow_amount: '30000',
  borrow_currency: 'USDC',
  borrow_apr: '4',
  ...over,
});
const buy = { buy_date: '2026-09-01', buy_amount: '30000', buy_eth: '10', buy_gas_usd: '3' };

await check('a write without a JSON content type is refused', async () => {
  const r = await api('POST', '/api/trades', borrow(), { json: false });
  assert.equal(r.status, 415);
});

const t1 = (await api('POST', '/api/trades', borrow())).data;

await check('a borrow with no gas fee is saved, its fee not recorded', async () => {
  assert.equal(typeof t1.id, 'number');
  assert.equal(t1.borrow_gas_usd, null);
  assert.deepEqual(t1.derived.feesMissing, ['borrow']);
});

await check('a purchase must say what its swap cost, and 0 is a cost', async () => {
  const { buy_gas_usd, ...noFee } = buy;
  const refused = await api('PATCH', `/api/trades/${t1.id}`, noFee);
  assert.equal(refused.status, 400);
  assert.equal(refused.data.field, 'buy_gas_usd');
  const zero = await api('PATCH', `/api/trades/${t1.id}`, { ...buy, buy_gas_usd: '0' });
  assert.equal(zero.status, 200);
});

await check('an ETH price outside $1 to $1,000,000 is refused', async () => {
  // 30,000 for 80,773 ETH is $0.37 an ETH: 8.0773 typed without its point.
  const r = await api('PATCH', `/api/trades/${t1.id}`, { ...buy, buy_eth: '80773' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'buy_eth');
});

await check('a sale may run 10% over the purchase for Aave interest, not past it', async () => {
  const sale = { sell_date: '2026-09-20', sell_amount: '33000', sell_gas_usd: '4' };
  const over = await api('PATCH', `/api/trades/${t1.id}`, { ...sale, sell_eth: '11.5' });
  assert.equal(over.status, 400);
  assert.equal(over.data.field, 'sell_eth');
  const interest = await api('PATCH', `/api/trades/${t1.id}`, { ...sale, sell_eth: '10.03' });
  assert.equal(interest.status, 200);
  assert.equal(interest.data.derived.status, 'SOLD');
});

await check('a repayment below the principal is refused', async () => {
  const r = await api('PATCH', `/api/trades/${t1.id}`, { repay_date: '2026-09-20', repay_amount: '29000' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'repay_amount');
});

await check('an exchange rate in a request is refused', async () => {
  const r = await api('PATCH', `/api/trades/${t1.id}`, { buy_fx: '2' });
  assert.equal(r.status, 400);
});

await check('amounts typed with a decimal comma read as written', async () => {
  const r = await api('POST', '/api/trades', borrow({ borrow_amount: '32.000,00', borrow_gas_usd: '3,20' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.borrow_amount, 32000);
  assert.equal(r.data.borrow_gas_usd, 3.2);
  assert.equal((await api('POST', '/api/trades', borrow({ borrow_amount: '1e5' }))).status, 400);
});

// 10,000 USDC borrowed today and spent on 4 ETH, $1 + $3 of fees: an open
// position to set goals on.
const t2 = (await api('POST', '/api/trades', borrow({ borrow_date: today, borrow_amount: '10000', borrow_gas_usd: '1' }))).data;
await api('PATCH', `/api/trades/${t2.id}`, { buy_date: today, buy_amount: '10000', buy_eth: '4', buy_gas_usd: '3' });

await check('an alert goal under $1 is refused, and its preview is empty', async () => {
  const r = await api('PUT', `/api/trades/${t2.id}/alert`, { goal_price: '0.5' });
  assert.equal(r.status, 400);
  assert.equal((await api('GET', `/api/trades/${t2.id}/alert/preview?goal=0.5`)).data.text, null);
});

await check('the alert preview reads as the Telegram message will', async () => {
  // At $2,550: 4 ETH worth $10,200, less the $10,000 spent and $4 of fees,
  // no interest on a loan opened today: +$196, +1.96% of the $10,000 spent.
  const r = await api('GET', `/api/trades/${t2.id}/alert/preview?goal=2550`);
  assert.equal(
    r.data.text,
    [
      'ETH reached your $2,550.00 goal',
      '',
      `Trade #${t2.id}: borrowed 10,000.00 USDC on ${fmtDate(today)}`,
      'Bought: 4.0000 ETH',
      'Purchase price: $2,500.00',
      '',
      'Worth now: $10,200.00',
      'Gain (%): +1.96%',
      'Gain ($): +$196.00 after $0.00 interest and $4.00 fees',
    ].join('\n'),
  );
});

await check('DELETE /api/alerts/ with a trailing slash deletes nothing', async () => {
  assert.equal((await api('PUT', `/api/trades/${t2.id}/alert`, { goal_price: '4000' })).status, 200);
  assert.equal((await api('DELETE', '/api/alerts/')).status, 404);
  assert.equal((await api('GET', '/api/alerts/log')).data.alerts.length, 1);
});

await check('an unknown /API path answers JSON, in any case', async () => {
  const r = await api('GET', '/API/nope');
  assert.equal(r.status, 404);
  assert.match(r.type, /json/);
});

await check('deleting a trade takes its alerts with it', async () => {
  assert.equal((await api('DELETE', `/api/trades/${t2.id}`)).status, 204);
  assert.equal((await api('GET', '/api/alerts/log')).data.alerts.length, 0);
});

server.kill('SIGTERM');
await new Promise((r) => server.once('exit', r));
if (process.exitCode && serverErr) warn(`server stderr:\n${serverErr}`);

/* ---------------------------------------------------------- the alert sweep */

// In this process, so each sweep can be driven by hand. Set before the first
// import of db.js, which opens the file it names.
Object.assign(process.env, isolated, {
  MYAAVE_DB: path.join(tmp, 'alerts.db'),
  TELEGRAM_BOT_TOKEN: '1:test',
  TELEGRAM_CHAT_ID: '-1',
  MYAAVE_ALERT_POLL_MS: '1000',
});
delete process.env.MYAAVE_ETH_OFFLINE;
delete process.env.MYAAVE_ETH_PRICE;
console.log = () => {};
console.error = () => {};
console.warn = () => {};

const { prepare, closeDb } = await import('../db.js');
const { saveAlert, runAlertSweep, getAlertById } = await import('../alerts.js');

// A HOLDING trade bought at $2,500 an ETH, borrowed today.
const holding = () => {
  const now = new Date().toISOString();
  const id = prepare(`
    INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, borrow_gas_usd,
                        buy_date, buy_amount, buy_eth, buy_gas_usd, created_at, updated_at)
    VALUES (@d, 10000, 'USDC', 4, 1, @d, 10000, 4, 3, @now, @now)
  `).run({ d: today, now }).lastInsertRowid;
  return prepare('SELECT * FROM trades WHERE id = ?').get(id);
};
const attemptsOf = (id) => prepare('SELECT attempts FROM alerts WHERE id = ?').get(id).attempts;

// The sweep takes a price up to a poll interval old, so a new one needs that
// long to be asked for.
const priceAt = async (p) => {
  mock.price = p;
  await wait(1100);
};

await check('a send that fails is retried, even after ETH has moved back past the goal', async () => {
  const alert = saveAlert(holding(), 2550, 2600); // below: waits for a fall
  assert.equal(alert.direction, 'below');
  await priceAt(2540);
  mock.tg.push([500, 'Internal Server Error']);
  await runAlertSweep();
  let a = getAlertById(alert.id);
  assert.equal(a.status, 'armed');
  assert.equal(attemptsOf(alert.id), 1);
  assert.equal(a.firedPrice, 2540);
  await priceAt(2600);
  mock.sent.length = 0;
  await runAlertSweep();
  a = getAlertById(alert.id);
  assert.equal(a.status, 'fired');
  assert.equal(a.firedPrice, 2540, 'the price that triggered it is kept');
  assert.equal(mock.sent.length, 1);
  assert.match(mock.sent[0], /^ETH reached your \$2,550\.00 goal - now \$2,600\.00\n/);
});

await check('three failed sends give up, and nothing more is sent', async () => {
  const alert = saveAlert(holding(), 2550, 2600);
  await priceAt(2540);
  mock.tg.push([500, 'x'], [502, 'x'], [503, 'x']);
  for (let i = 0; i < 3; i += 1) await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'failed');
  assert.equal(attemptsOf(alert.id), 3);
  mock.sent.length = 0;
  await runAlertSweep();
  assert.equal(mock.sent.length, 0);
});

await check('a rate limit is retried, not taken as a refusal', async () => {
  // 429 is the one failure certain to pass on its own (see telegram.js).
  const alert = saveAlert(holding(), 2550, 2600);
  await priceAt(2540);
  mock.tg.push([429, 'Too Many Requests: retry after 5']);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  assert.equal(attemptsOf(alert.id), 1);
  // Delivered on the next sweep, so it does not linger into the checks below.
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'fired');
});

await check('a Telegram setup error keeps the alert waiting, and it goes once fixed', async () => {
  const alert = saveAlert(holding(), 2550, 2600);
  await priceAt(2540);
  mock.tg.push([401, 'Unauthorized']);
  await runAlertSweep();
  let a = getAlertById(alert.id);
  assert.equal(a.status, 'armed');
  assert.equal(a.lastError, 'Unauthorized');
  assert.equal(attemptsOf(alert.id), 0, 'not counted towards the three tries');
  mock.tg.push([403, 'Forbidden: bot was kicked from the group chat']);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  // A token pasted with its "bot" prefix: Telegram answers 404.
  mock.tg.push([404, 'Not Found']);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  // In the group, but its admins have not let it post.
  mock.tg.push([400, 'Bad Request: not enough rights to send text messages to the chat']);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  assert.equal(attemptsOf(alert.id), 0);
  await priceAt(2600);
  mock.sent.length = 0;
  await runAlertSweep();
  a = getAlertById(alert.id);
  assert.equal(a.status, 'fired');
  assert.equal(a.lastError, null);
  assert.equal(mock.sent.length, 1);
});

await check('a refusal of the message itself is final', async () => {
  const alert = saveAlert(holding(), 2550, 2600);
  await priceAt(2540);
  mock.tg.push([400, 'Bad Request: message is too long']);
  await runAlertSweep();
  const a = getAlertById(alert.id);
  assert.equal(a.status, 'fired');
  assert.match(a.lastError, /too long/);
  mock.sent.length = 0;
  await runAlertSweep();
  assert.equal(mock.sent.length, 0);
});

await check('an alert waiting on its send closes when the trade sells', async () => {
  const trade = holding();
  const alert = saveAlert(trade, 2550, 2600);
  await priceAt(2540);
  mock.tg.push([401, 'Unauthorized']);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  prepare(`UPDATE trades SET sell_date = @d, sell_amount = 10400, sell_eth = 4, sell_gas_usd = 1 WHERE id = @id`).run({
    d: today,
    id: trade.id,
  });
  mock.sent.length = 0;
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'closed');
  assert.equal(mock.sent.length, 0);
});

/* ------------------------------------------------------------- bot reports */

const { holdingText, helpText } = await import('../report.js');

await check('/holding leaves out the euro move when a purchase rate is missing', async () => {
  // Two EURC positions of 10,000 on 4 ETH; only the first has its rate.
  const base = { borrow_date: today, borrow_amount: 10000, borrow_currency: 'EURC', borrow_apr: 0,
    buy_date: today, buy_amount: 10000, buy_eth: 4, buy_gas_usd: 0, borrow_gas_usd: 0, borrow_fx: 1.05 };
  const both = holdingText([{ ...base, id: 1, buy_fx: 1.05 }, { ...base, id: 2 }], 3000, { EURC: 1.17 });
  assert.doesNotMatch(both, /move since purchase/);
  const one = holdingText([{ ...base, id: 1, buy_fx: 1.05 }], 3000, { EURC: 1.17 });
  // 10,000 EURC from 1.05 to 1.17 is -$1,200.00 on the position.
  assert.match(one, /-\$1,200\.00 of it from the move since purchase/);
});

await check('/holding: the Unrealised total is the sum of the rows as printed', async () => {
  // Three USDT positions, 1,000 on 1 ETH at 4% for 30 days: 3.2877 of
  // interest, so each is up 96.7123 at $1,100 and prints +$96.71. The total
  // is the rows' sum, 3 x 96.71 = 290.13, not the raw 290.137 printed .14.
  const from = new Date(Date.parse(today) - 30 * 86_400_000).toISOString().slice(0, 10);
  const row = (id) => ({ id, borrow_date: from, borrow_amount: 1000, borrow_currency: 'USDT', borrow_apr: 4,
    borrow_gas_usd: 0, buy_date: from, buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0 });
  const text = holdingText([row(1), row(2), row(3)], 1100, {});
  assert.equal(text.match(/\+\$96\.71/g)?.length, 3);
  assert.match(text, /Unrealised \+\$290\.13 /);
});

await check('/help says what /holding lists: trades still holding ETH', async () => {
  // Not "open positions": /summary counts a sold, unrepaid trade as open, and
  // /holding does not list it.
  assert.match(helpText(), /\/holding - trades still holding ETH/);
  assert.doesNotMatch(helpText(), /open positions/);
});

await check('/help names the watch interval it is given', async () => {
  assert.match(helpText(), /every 20 minutes/);
  assert.match(helpText('90 seconds'), /every 90 seconds/);
});

/* ------------------------------------------------------------------ the end */

closeDb();
await new Promise((r) => mockServer.close(r));
fs.rmSync(tmp, { recursive: true, force: true });

if (process.exitCode) warn(`\n${passed} passed, some failed.`);
else say(`ok - ${passed} server checks`);
process.exit(process.exitCode ?? 0);
