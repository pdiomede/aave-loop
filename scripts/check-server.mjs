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
import { spawn, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
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
// `updates` is what the next getUpdates hands the bot; `sentTo` the chat
// each sent message went to, beside its text in `sent`.
const mock = { price: 3000, tg: [], sent: [], sentTo: [], updates: [] };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/coins/markets')) {
      return res.end(JSON.stringify([{ id: 'ethereum', current_price: mock.price }]));
    }
    if (req.url.includes('/getUpdates')) {
      return res.end(JSON.stringify({ ok: true, result: mock.updates.splice(0) }));
    }
    if (req.url.includes('/getMe')) return res.end('{"ok":true,"result":{"username":"TestBot"}}');
    if (req.url.includes('/sendMessage')) {
      const [status = 200, description = ''] = mock.tg.shift() ?? [];
      if (status === 200) {
        mock.sent.push(JSON.parse(body).text);
        mock.sentTo.push(String(JSON.parse(body).chat_id ?? ''));
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
  platform: 'aave',
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

await check('a new trade must say where it was run, Aave or Ether.fi, by id in any case', async () => {
  const { platform, ...none } = borrow();
  const missing = await api('POST', '/api/trades', none);
  assert.equal(missing.status, 400);
  assert.equal(missing.data.field, 'platform');
  const other = await api('POST', '/api/trades', borrow({ platform: 'uniswap' }));
  assert.equal(other.status, 400);
  assert.equal(other.data.field, 'platform');
  assert.equal(t1.platform, 'aave');
  const upper = await api('POST', '/api/trades', borrow({ platform: ' ETHERFI ' }));
  assert.equal(upper.status, 201);
  assert.equal(upper.data.platform, 'etherfi');
  await api('DELETE', `/api/trades/${upper.data.id}`);
});

await check('a platform can be changed but not cleared, and a trade without one still edits', async () => {
  const cleared = await api('PATCH', `/api/trades/${t1.id}`, { platform: '' });
  assert.equal(cleared.status, 400);
  assert.equal(cleared.data.field, 'platform');
  const moved = await api('PATCH', `/api/trades/${t1.id}`, { platform: 'etherfi' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.platform, 'etherfi');
  assert.equal((await api('PATCH', `/api/trades/${t1.id}`, { platform: 'aave' })).data.platform, 'aave');

  // A trade from before the field existed, written straight to the file.
  const db = new Database(path.join(tmp, 'api.db'));
  const now = new Date().toISOString();
  const old = db.prepare(`INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr,
    created_at, updated_at) VALUES ('2026-08-01', 1000, 'USDC', 4, ?, ?)`).run(now, now).lastInsertRowid;
  db.close();
  const edited = await api('PATCH', `/api/trades/${old}`, { borrow_apr: '5' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.platform, null);
  await api('DELETE', `/api/trades/${old}`);
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

await check('an id that is not plain digits reaches no row', async () => {
  const alertId = (await api('GET', '/api/alerts/log')).data.alerts[0].id;
  for (const id of [`0x${t2.id.toString(16)}`, `${t2.id}e0`, `${t2.id}.0`]) {
    assert.equal((await api('PATCH', `/api/trades/${id}`, { notes: 'x' })).status, 404, id);
    assert.equal((await api('PUT', `/api/trades/${id}/alert`, { goal_price: '4000' })).status, 404, id);
    assert.equal((await api('GET', `/api/trades/${id}/alert/preview?goal=4000`)).status, 404, id);
    assert.equal((await api('DELETE', `/api/trades/${id}`)).status, 404, id);
  }
  assert.equal((await api('DELETE', `/api/alerts/${alertId}.0`)).status, 404);
  assert.equal((await api('GET', '/api/alerts/log')).data.alerts.length, 1);
  assert.ok((await api('GET', '/api/trades')).data.some((t) => t.id === t2.id && t.notes == null));
});

await check('the alert preview is empty on a trade holding no ETH, as its save is refused', async () => {
  assert.equal((await api('PUT', `/api/trades/${t1.id}/alert`, { goal_price: '4000' })).status, 400);
  assert.equal((await api('GET', `/api/trades/${t1.id}/alert/preview?goal=4000`)).data.text, null);
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

await check('Delete all deletes only up to the newest alert the page showed', async () => {
  // Two holding trades, a goal on each; the page saw only the first.
  const held = async () => {
    const t = (await api('POST', '/api/trades', borrow({ borrow_date: today }))).data;
    await api('PATCH', `/api/trades/${t.id}`, { buy_date: today, buy_amount: '30000', buy_eth: '10', buy_gas_usd: '3' });
    return t;
  };
  const [a, b] = [await held(), await held()];
  const first = (await api('PUT', `/api/trades/${a.id}/alert`, { goal_price: '3500' })).data;
  await api('PUT', `/api/trades/${b.id}/alert`, { goal_price: '3600' });
  const firstId = first.id ?? first.alert?.id;
  assert.equal((await api('DELETE', '/api/alerts?through=abc')).status, 400);
  assert.equal((await api('DELETE', '/api/alerts?through=007')).status, 400);
  const r = await api('DELETE', `/api/alerts?through=${firstId}`);
  assert.equal(r.data.deleted, 1, 'only the one shown');
  const left = (await api('GET', '/api/alerts/log')).data.alerts;
  assert.deepEqual(left.map((x) => x.tradeId), [b.id], 'the goal set since is still there');
  assert.equal((await api('DELETE', '/api/alerts')).data.deleted, 1, 'no bound: everything');
  for (const t of [a, b]) await api('DELETE', `/api/trades/${t.id}`);
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

await check('/holding names each trade\'s platform, and a dash where none was recorded', async () => {
  const row = (id, platform) => ({ id, platform, borrow_date: today, borrow_amount: 1000, borrow_currency: 'USDT',
    borrow_apr: 0, borrow_gas_usd: 0, buy_date: today, buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0 });
  const lines = holdingText([row(1, 'aave'), row(22, 'etherfi'), row(3, null)], 1100, {})
    .split('<pre>')[1].split('\n');
  // Padded to the widest name, so the ETH column still lines up.
  assert.match(lines[0], /^#1   Aave      1\.0000 ETH/);
  assert.match(lines[1], /^#22  Ether\.fi  1\.0000 ETH/);
  assert.match(lines[2], /^#3   -         1\.0000 ETH/);
});

await check('a trade repaid with no full sale is not held: its alert closes and /holding leaves it out', async () => {
  // A row from before the API refused repaid-without-sold. `derive` calls it
  // CLOSED; the SQL used to call it held.
  const { closeUnwatched } = await import('../alerts.js');
  const { holdingMessage } = await import('../report.js');
  const now = new Date().toISOString();
  const id = prepare(`
    INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, buy_date, buy_amount, buy_eth,
                        buy_gas_usd, repay_date, repay_amount, platform, created_at, updated_at)
    VALUES ('2026-05-01', 30000, 'USDC', 4, '2026-05-01', 30000, 10, 3, '2026-07-01', 30200, 'aave', @now, @now)
  `).run({ now }).lastInsertRowid;
  const alert = prepare(`
    INSERT INTO alerts (trade_id, goal_price, direction, status, created_at, updated_at)
    VALUES (?, 3500, 'up', 'armed', @now, @now)
  `).run(id, { now }).lastInsertRowid;
  closeUnwatched();
  assert.notEqual(prepare('SELECT status FROM alerts WHERE id = ?').get(alert).status, 'armed');
  assert.doesNotMatch(await holdingMessage(), new RegExp(`#${id}\\b`));
});

await check('/holding says when it is valued at an old price, as /price does', async () => {
  const row = { id: 1, platform: 'aave', borrow_date: today, borrow_amount: 1000, borrow_currency: 'USDT',
    borrow_apr: 0, borrow_gas_usd: 0, buy_date: today, buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0 };
  assert.match(holdingText([row], 1100, {}, { ageMs: 2 * 3_600_000 }), /At the price last fetched .+ ago\./);
  assert.doesNotMatch(holdingText([row], 1100, {}, { ageMs: 1000 }), /last fetched/);
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

/* --------------------------------------------------------- set-platform */

await check('set-platform: a dry run writes nothing, --apply sets Aave on the rest and keeps a set one', async () => {
  const file = path.join(tmp, 'platform.db');
  const runIt = (...args) =>
    execFileSync(process.execPath, ['scripts/set-platform.mjs', ...args], {
      cwd: root,
      env: { ...process.env, ...isolated, MYAAVE_DB: file },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // Opened once through the script so the table exists, then three trades:
  // two with no platform, one already on Ether.fi.
  runIt();
  const db = new Database(file);
  const now = new Date().toISOString();
  const add = db.prepare(`INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr,
    platform, created_at, updated_at) VALUES ('2026-08-01', 1000, 'USDC', 4, ?, ?, ?)`);
  const [a, b, c] = [null, null, 'etherfi'].map((p) => Number(add.run(p, now, now).lastInsertRowid));
  const platforms = () => db.prepare('SELECT platform FROM trades ORDER BY id').all().map((r) => r.platform);

  assert.match(runIt('--etherfi', String(b)), /Dry run: 2 trades would change/);
  assert.deepEqual(platforms(), [null, null, 'etherfi']);

  assert.throws(() => runIt('--etherfi', '999', '--apply'), /No trade #999/);
  assert.throws(() => runIt('--etherfi', '', '--apply'), /needs a trade id/, 'an empty value is not "none"');
  assert.throws(() => runIt('--etherfi', '007', '--apply'), /not a trade id/);
  assert.deepEqual(platforms(), [null, null, 'etherfi']);

  runIt('--etherfi', String(b), '--apply');
  assert.deepEqual(platforms(), ['aave', 'etherfi', 'etherfi'], `#${a} Aave, #${b} and #${c} Ether.fi`);
  assert.match(runIt('--apply'), /Nothing to change/);
  db.close();
});

await check('a new goal keeps a reached, unsent alert in the log as failed, not deleted', async () => {
  const t = holding();
  const first = saveAlert(t, 2400, 2500);
  // Reached and waiting to go out, as a failed send leaves it.
  prepare("UPDATE alerts SET fired_at = @now, fired_price = 2390, last_error = 'Bad Gateway' WHERE id = @id").run({
    id: first.id,
    now: new Date().toISOString(),
  });
  const second = saveAlert(t, 2300, 2390);
  const old = getAlertById(first.id);
  assert.ok(old, 'still in the log');
  assert.equal(old.status, 'failed');
  assert.equal(old.lastError, 'Bad Gateway. Replaced by a new goal before it was sent.');
  assert.equal(getAlertById(second.id).status, 'armed');
  // A goal never reached is simply replaced, as before.
  const third = saveAlert(t, 2200, 2390);
  assert.equal(getAlertById(second.id), null);
  assert.equal(getAlertById(third.id).status, 'armed');
});

/* ------------------------------------------------------- the alert message */

await check('an alert\'s lines add up to its gain, to the cent', async () => {
  // Worth now, less the dollars spent, the interest and the fees, is the Gain
  // printed under them. Built from raw floats it missed by a cent on about a
  // quarter of trades, so thirty days of loan age are tried, not one.
  const { alertMessage } = await import('../alerts.js');
  const dollars = (s) => Number(s.replace(/[$,+]/g, ''));
  for (let age = 1; age <= 30; age += 1) {
    const day = (n) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
    const t = { id: 1, platform: 'aave', borrow_currency: 'USDC', borrow_date: day(age + 1), borrow_amount: 12345.67,
      borrow_apr: 4.37, buy_date: day(age), buy_amount: 12345.67, buy_eth: 3.7777, buy_gas_usd: 1.005 };
    const text = alertMessage(t, { goal_price: 3450 }, 3450);
    const worth = dollars(text.match(/Worth now: (\$[\d,.]+)/)[1]);
    const [, gain, interest, fees] = text.match(/Gain \(\$\): ([+-]?\$[\d,.]+) after (\$[\d,.]+) interest and (\$[\d,.]+) fees/);
    const sum = Math.round((worth - 12345.67 - dollars(interest) - dollars(fees)) * 100) / 100;
    assert.equal(sum, dollars(gain), `${age} days: ${text.split('\n').slice(-2).join(' | ')}`);
  }
});

/* --------------------------------------------------------------- the bot */

await check('/watch reports go to the chat that asked, or to the group once that chat is not allowed', async () => {
  // The group is -1 (set above); 42 is the owner's private chat.
  process.env.TELEGRAM_OWNER_ID = '42';
  const bot = await import('../bot.js');
  const tick = async () => {
    mock.sent.length = 0;
    mock.sentTo.length = 0;
    await bot.runBotTick();
    return mock.sentTo.slice();
  };
  const due = () =>
    prepare('UPDATE bot_state SET watch_next_at = ? WHERE id = 1').run(new Date(Date.now() - 1000).toISOString());
  const say = (chat, text, id, ageS = 0) =>
    mock.updates.push({ update_id: id, message: { chat: { id: chat }, text, date: Math.floor(Date.now() / 1000) - ageS } });

  // Something held, so reports go out; `holding()` is the sweep's own trade.
  const held = holding();
  say(42, '/watch', 1);
  assert.deepEqual(await tick(), ['42']);
  assert.match(mock.sent[0], /Watching\. The price every .+ here until \/unwatch\./);

  due();
  assert.deepEqual(await tick(), ['42'], 'the report goes where /watch was asked, not to the group');

  // The owner taken out of the config: no position report to a chat the bot
  // no longer answers in. The group gets it, as before the chat was stored.
  process.env.TELEGRAM_OWNER_ID = '';
  due();
  assert.deepEqual(await tick(), ['-1']);

  // Nothing held: the report is skipped, the watch stays on, and it resumes
  // by itself once a trade holds ETH again.
  const stash = prepare("SELECT id FROM trades WHERE repay_date IS NULL").all().map((r) => r.id);
  const shut = prepare("UPDATE trades SET repay_date = borrow_date, repay_amount = borrow_amount WHERE id = ?");
  for (const id of stash) shut.run(id);
  due();
  assert.deepEqual(await tick(), [], 'nothing held, nothing sent');
  assert.equal(prepare('SELECT watch FROM bot_state WHERE id = 1').get().watch, 1, 'still watching');
  prepare('UPDATE trades SET repay_date = NULL, repay_amount = NULL WHERE id = ?').run(held.id);
  due();
  assert.deepEqual(await tick(), ['-1'], 'held again, sent again');

  // Typed while the app was down for a quarter of an hour: still a stop. An
  // old /unwatch was skipped as stale, and the reports went on.
  say(-1, '/unwatch', 2, 900);
  await tick();
  due();
  assert.deepEqual(await tick(), [], 'stopped');
  assert.equal(prepare('SELECT watch_chat FROM bot_state WHERE id = 1').get().watch_chat, null);
});

await check('/holding counts a part-sold trade as holding what it kept, and its move adds up', async () => {
  const { holdingText, holdingMessage } = await import('../report.js');
  // 4 ETH bought, 1 sold, not repaid: the card reads "Still held" 3 ETH.
  const now = new Date().toISOString();
  const id = prepare(`
    INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, buy_date, buy_amount, buy_eth,
                        buy_gas_usd, sell_date, sell_amount, sell_eth, sell_gas_usd, platform, created_at, updated_at)
    VALUES (@d, 10000, 'USDC', 4, @d, 10000, 4, 3, @d, 3000, 1, 2, 'aave', @now, @now)
  `).run({ d: today, now }).lastInsertRowid;
  const text = await holdingMessage();
  assert.match(text, new RegExp(`#${id}\\s+Aave\\s+3\\.0000 ETH`));

  // Two euro positions whose moves print -$1,207.24 and -$1,207.66: the line
  // under the total names their sum as printed, -$2,414.90.
  const eur = (n, amt) => ({ id: n, borrow_currency: 'EURC', platform: 'aave', borrow_amount: amt, borrow_apr: 4,
    borrow_date: today, buy_date: today, buy_amount: amt, buy_eth: 3, buy_gas_usd: 2, borrow_fx: 1.0505, buy_fx: 1.0505 });
  assert.match(holdingText([eur(1, 10002), eur(2, 10005.5)], 3000, { EURC: 1.1712 }), /-\$2,414\.90 of it from the move/);
});

await check('/holding heads its rows with their sum as printed, and fits Telegram however long', async () => {
  const { holdingText } = await import('../report.js');
  const row = (id, eth, over = {}) => ({ id, platform: 'aave', borrow_currency: 'USDC', borrow_amount: 5000,
    borrow_apr: 4, borrow_date: today, buy_date: today, buy_amount: 5000, buy_eth: eth, buy_gas_usd: 2, ...over });
  // 1.23455 and 2.23455 print 1.2346 and 2.2346; summed raw they read 3.4691.
  assert.match(holdingText([row(1, 1.23455), row(2, 2.23455)], 3000, {}), /3\.4692 ETH/);

  // 150 seven-figure euro positions at an hour-old price: every line above the
  // table at its longest. Counted as Telegram counts it, tags out.
  const big = Array.from({ length: 150 }, (_, i) => row(i + 1, 2.5, {
    borrow_currency: 'EURC', borrow_amount: 1234567.89, buy_amount: 1234567.89, borrow_fx: 1.0512, buy_fx: 1.0512 }));
  const text = holdingText(big, 2999.99, { EURC: 1.1712 }, { ageMs: 3 * 3_600_000 });
  const visible = text.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp);/g, '_').length;
  assert.ok(visible <= 4096, `${visible} characters`);
  assert.match(text, /and \d+ more<\/pre>$/);
});

/* ------------------------------------------------------------------ the end */

closeDb();
await new Promise((r) => mockServer.close(r));
fs.rmSync(tmp, { recursive: true, force: true });

if (process.exitCode) warn(`\n${passed} passed, some failed.`);
else say(`ok - ${passed} server checks`);
process.exit(process.exitCode ?? 0);
