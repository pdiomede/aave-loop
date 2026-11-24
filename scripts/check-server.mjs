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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ethroundtrip-check-'));

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
const mock = { price: 3000, btc: 90000, wbtc: 89900, asked: 0, tg: [], sent: [], sentTo: [], updates: [], fx: { rate: 1.1 } };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/coins/markets')) {
      mock.asked += 1;
      // Every coin, whatever was asked, as CoinGecko answers a list of ids;
      // a null `btc` or `wbtc` leaves that coin out of the answer.
      const coins = [{ id: 'ethereum', current_price: mock.price }];
      if (mock.btc !== null) coins.push({ id: 'bitcoin', current_price: mock.btc });
      if (mock.wbtc !== null) coins.push({ id: 'wrapped-bitcoin', current_price: mock.wbtc });
      return res.end(JSON.stringify(coins));
    }
    if (req.url.includes('/getUpdates')) {
      return res.end(JSON.stringify({ ok: true, result: mock.updates.splice(0) }));
    }
    if (req.url.includes('/getMe')) return res.end('{"ok":true,"result":{"username":"TestBot"}}');
    if (req.url.includes('/sendMessage')) {
      const [status = 200, description = ''] = mock.tg.shift() ?? [];
      // [200, 'html']: a captive portal's page, not Telegram's answer.
      if (status === 200 && description === 'html') {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<html><body>Sign in to the network</body></html>');
      }
      if (status === 200) {
        mock.sent.push(JSON.parse(body).text);
        mock.sentTo.push(String(JSON.parse(body).chat_id ?? ''));
        return res.end('{"ok":true,"result":{}}');
      }
      res.statusCode = status;
      return res.end(JSON.stringify({ ok: false, error_code: status, description }));
    }
    // The rate service (Frankfurter), for the exchange-rate checks. A day is
    // answered with the business day on or before it, as the ECB does; `fx`
    // bends that: `stale` dates every one-day answer on that day, `rangeEnd`
    // stops a range there, `holiday` is a weekday with no rate of its own and
    // `html` answers with a portal's page.
    const fxAsk = req.url.match(/^\/(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?\?/);
    if (fxAsk) {
      if (mock.fx.html) {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<html><body>Sign in to the network</body></html>');
      }
      const published = (iso) => {
        const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
        return wd !== 0 && wd !== 6 && iso !== mock.fx.holiday;
      };
      const back = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      if (!fxAsk[2]) {
        let d = fxAsk[1];
        while (!published(d)) d = back(d);
        const date = mock.fx.stale ?? d;
        return res.end(JSON.stringify({ base: 'EUR', date, rates: { USD: mock.fx.rate } }));
      }
      const rates = {};
      for (let d = fxAsk[2]; d >= fxAsk[1]; d = back(d)) {
        if (published(d) && (!mock.fx.rangeEnd || d <= mock.fx.rangeEnd)) rates[d] = { USD: mock.fx.rate };
      }
      return res.end(JSON.stringify({ base: 'EUR', rates }));
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
  // The old MYAAVE_* names are still read when a new one is unset (env.js), so
  // any the developer's shell exports are blanked here, or they would leak in.
  ...Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith('MYAAVE_')).map((k) => [k, ''])),
  ETHROUNDTRIP_CONFIG: path.join(tmp, 'none.env'),
  // No fixed price unless a check sets one: an exported one decided which
  // market a goal was watched against.
  ETHROUNDTRIP_ETH_PRICE: '',
  ETHROUNDTRIP_BTC_PRICE: '',
  ETHROUNDTRIP_TELEGRAM_URL: MOCK,
  ETHROUNDTRIP_ETH_URL: MOCK,
  ETHROUNDTRIP_FX_OFFLINE: '1',
  ETHROUNDTRIP_BOT_OFF: '1',
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
    ETHROUNDTRIP_DB: path.join(tmp, 'api.db'),
    ETHROUNDTRIP_ETH_OFFLINE: '1',
    ETHROUNDTRIP_ETH_PRICE: '3000',
    ETHROUNDTRIP_BTC_PRICE: '90000',
    ETHROUNDTRIP_WBTC_PRICE: '89000',
    ETHROUNDTRIP_ALERT_POLL_MS: '3600000',
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

await check('a new trade must say where it was run, Aave, Ether.fi or Morpho, by id in any case', async () => {
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
  const morpho = await api('POST', '/api/trades', borrow({ platform: 'Morpho' }));
  assert.equal(morpho.status, 201);
  assert.equal(morpho.data.platform, 'morpho');
  await api('DELETE', `/api/trades/${morpho.data.id}`);
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

await check('a figure past a trillion is refused, so no total turns null', async () => {
  // 1e307 in cents is Infinity, which JSON writes as null: one such fee made
  // every total in /api/summary null.
  const r = await api('POST', '/api/trades', { ...borrow(), ...buy, buy_gas_usd: 1e307 });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'buy_gas_usd');
  assert.equal((await api('POST', '/api/trades', borrow({ borrow_amount: '2000000000000' }))).status, 400);
});

await check('an amount that prints as 0.00 is refused', async () => {
  // Saved, this was a holding trade bought at $0.00 an ETH.
  const r = await api('POST', '/api/trades', {
    ...borrow({ borrow_amount: '0.004' }),
    buy_date: '2026-09-01',
    buy_amount: '0.004',
    buy_eth: '0.000002',
    buy_gas_usd: '0',
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'borrow_amount');
  const one = await api('POST', '/api/trades', borrow({ borrow_amount: '0.01' }));
  assert.equal(one.status, 201);
  await api('DELETE', `/api/trades/${one.data.id}`);
});

await check('notes are cut at 2000 characters, never inside one', async () => {
  const r = await api('PATCH', `/api/trades/${t1.id}`, { notes: `a${'\u{1F600}'.repeat(2000)}` });
  assert.equal(r.status, 200);
  const chars = Array.from(r.data.notes);
  assert.equal(chars.length, 2000);
  assert.equal(chars.at(-1), '\u{1F600}');
  // A flag is two code points that read as one character: cut by code point,
  // 1999 letters and a flag kept only its first half, a stray letter.
  const flag = await api('PATCH', `/api/trades/${t1.id}`, { notes: `${'a'.repeat(1999)}\u{1F1EE}\u{1F1F9}x` });
  assert.ok(flag.data.notes.endsWith('\u{1F1EE}\u{1F1F9}'), JSON.stringify(flag.data.notes.slice(-4)));
  await api('PATCH', `/api/trades/${t1.id}`, { notes: '' });
});

await check('a quantity that prints as 0.0000 is refused, in its asset\'s places', async () => {
  // 0.00004 ETH for 0.12 USDC saved, and read "Bought 0.0000 ETH".
  const r = await api('POST', '/api/trades', {
    ...borrow(), buy_date: '2026-09-01', buy_amount: '0.12', buy_eth: '0.00004', buy_gas_usd: '0',
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'buy_eth');
  assert.match(r.data.error, /at least 0\.0001/);
  // One satoshi is a quantity of cbBTC.
  const sat = await api('POST', '/api/trades', {
    ...borrow(), asset: 'cbbtc', buy_date: '2026-09-01', buy_amount: '0.01', buy_eth: '0.00000001', buy_gas_usd: '0',
  });
  assert.equal(sat.status, 201);
  await api('DELETE', `/api/trades/${sat.data.id}`);
});

await check('a config.env that cannot be read is named without its path', async () => {
  // Under a regular file, so reading it fails with ENOTDIR. The reason is
  // served to the page, so the absolute path (a home folder, a user name)
  // must stay in the log.
  const file = path.join(tmp, 'not-a-folder');
  fs.writeFileSync(file, '');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "const { telegramConfig } = await import('./config.js'); console.log(telegramConfig().reason)"],
    { cwd: root, env: { ...process.env, ...isolated, ETHROUNDTRIP_CONFIG: path.join(file, 'config.env') }, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString();
  assert.match(out, /config\.env could not be read \(ENOTDIR\)/);
  assert.ok(!out.includes(tmp), out);
});

await check('the settings read ETHROUNDTRIP_*, and the old MYAAVE_* names when a new one is unset', async () => {
  const read = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', "const e = await import('./env.js'); console.log(JSON.stringify({ db: e.setting('DB') ?? null, name: e.settingName('DB'), note: e.oldSettingsNote() }))"],
        { cwd: root, env: { ...process.env, ...isolated, ETHROUNDTRIP_DB: '', ...env }, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString(),
    );
  // An install configured before the rename: only the old name.
  const old = read({ MYAAVE_DB: '/srv/ledger.db' });
  assert.equal(old.db, '/srv/ledger.db');
  assert.equal(old.name, 'MYAAVE_DB');
  assert.match(old.note, /MYAAVE_DB -> ETHROUNDTRIP_DB/);
  // Both: the new name wins. Neither: unset, and nothing to say.
  const both = read({ MYAAVE_DB: '/srv/old.db', ETHROUNDTRIP_DB: '/srv/new.db' });
  assert.equal(both.db, '/srv/new.db');
  // The old one is not read then, and the note says so rather than calling it
  // "still read" - a line left behind mid-rename looked as if it counted.
  assert.match(both.note, /Ignored, as the new name is set: MYAAVE_DB \(ETHROUNDTRIP_DB is used\)/);
  assert.doesNotMatch(both.note, /still read/);
  const none = read({});
  assert.equal(none.db, null);
  assert.equal(none.note, null);
  // Through the app: a config file named by the old setting is the one read.
  const file = path.join(tmp, 'old-name.env');
  fs.writeFileSync(file, 'TELEGRAM_BOT_TOKEN=123456:FAKE\n');
  const reason = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "const { telegramConfig } = await import('./config.js'); console.log(telegramConfig().reason)"],
    { cwd: root, env: { ...process.env, ...isolated, ETHROUNDTRIP_CONFIG: '', MYAAVE_CONFIG: file }, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString().trim();
  assert.equal(reason, 'TELEGRAM_CHAT_ID is missing from old-name.env.');
});

await check('the alert window is told the config file by its own name', async () => {
  // Its "will be sent once ... is filled in" said config.env whatever file
  // ETHROUNDTRIP_CONFIG named. The name only, never the path.
  const r = await api('GET', '/api/alerts');
  assert.equal(r.data.config.file, 'none.env');
});

await check('a config file that cannot be read is said so even with one value exported, and named as it is', async () => {
  const reasonFor = (env) =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "const { telegramConfig } = await import('./config.js'); console.log(telegramConfig().reason)"],
      { cwd: root, env: { ...process.env, ...isolated, ...env }, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
  // Unreadable, with the token exported: this read "TELEGRAM_CHAT_ID is
  // missing from config.env" though the file held it.
  const locked = path.join(tmp, 'locked.env');
  fs.writeFileSync(locked, 'TELEGRAM_CHAT_ID=-100\n');
  fs.chmodSync(locked, 0o000);
  try {
    assert.match(reasonFor({ ETHROUNDTRIP_CONFIG: locked, TELEGRAM_BOT_TOKEN: '123456:FAKE' }), /locked\.env exists but this process cannot read it/);
  } finally {
    fs.chmodSync(locked, 0o600);
  }
  // Named as ETHROUNDTRIP_CONFIG names it, not "config.env".
  const other = path.join(tmp, 'alerts.env');
  fs.writeFileSync(other, 'TELEGRAM_BOT_TOKEN=123456:FAKE\n');
  assert.equal(reasonFor({ ETHROUNDTRIP_CONFIG: other }), 'TELEGRAM_CHAT_ID is missing from alerts.env.');
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

await check('/api/prices gives ETH, BTC and WBTC, a quote each', async () => {
  const r = await api('GET', '/api/prices');
  assert.equal(r.data.prices.ETH.price, 3000);
  assert.equal(r.data.prices.BTC.price, 90000);
  assert.equal(r.data.prices.WBTC.price, 89000);
  assert.ok(r.data.pollMs >= 30_000);
  assert.equal((await api('GET', '/api/alerts')).data.prices.BTC.price, 90000);
});

await check('an alert window drawn for ETH cannot save its goal once the trade is cbBTC', async () => {
  // Opened while the trade held ETH, saved after its asset changed elsewhere:
  // the $3,500 typed as an ETH goal was stored as a BTC one and fired at once.
  const t = (await api('POST', '/api/trades', { ...borrow(), ...buy })).data;
  await api('PATCH', `/api/trades/${t.id}`, { asset: 'cbbtc', buy_eth: '0.3' });
  const stale = await api('PUT', `/api/trades/${t.id}/alert`, { goal_price: '3500', market: 'ETH' });
  assert.equal(stale.status, 400);
  assert.equal(stale.data.field, 'goal_price');
  const preview = await api('GET', `/api/trades/${t.id}/alert/preview?goal=3500&market=ETH`);
  assert.equal(preview.data.text, null);
  const fresh = await api('PUT', `/api/trades/${t.id}/alert`, { goal_price: '120000', market: 'BTC' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.market, 'BTC');
  await api('DELETE', `/api/trades/${t.id}`);
});

await check('editing a purchase does not re-check an old sale when the asset stays', async () => {
  // The Bought form always sends its asset, so a fee edit re-checked a sale
  // saved before the price check existed, and refused with its error.
  const t = (await api('POST', '/api/trades', { ...borrow(), ...buy })).data;
  const db = new Database(path.join(tmp, 'api.db'));
  db.prepare("UPDATE trades SET sell_date = '2026-09-10', sell_amount = 5, sell_eth = 10, sell_gas_usd = 1 WHERE id = ?").run(t.id);
  db.close();
  const fee = await api('PATCH', `/api/trades/${t.id}`, { ...buy, asset: 'eth', buy_gas_usd: '6' });
  assert.equal(fee.status, 200);
  // A change of asset still re-checks it.
  const moved = await api('PATCH', `/api/trades/${t.id}`, { asset: 'cbbtc' });
  assert.equal(moved.status, 400);
  assert.equal(moved.data.field, 'sell_eth');
  await api('DELETE', `/api/trades/${t.id}`);
});

await check('a trade can buy WBTC, valued and alerted at WBTC\'s own price, not BTC\'s', async () => {
  const t = (await api('POST', '/api/trades', borrow({ borrow_date: today, borrow_amount: '10000' }))).data;
  const bought = { buy_date: today, buy_amount: '10000', buy_gas_usd: '1' };
  const bad = await api('PATCH', `/api/trades/${t.id}`, { asset: 'wbtc', ...bought, buy_eth: 'x' });
  assert.equal(bad.data.error, 'WBTC purchased must be a number.');
  const r = await api('PATCH', `/api/trades/${t.id}`, { asset: 'WBTC', ...bought, buy_eth: '0.10000001' });
  assert.equal(r.status, 200);
  assert.equal(r.data.asset, 'wbtc');
  assert.equal(r.data.buy_eth, 0.10000001, 'all 8 places kept');
  // Set against WBTC at the fixed 89,000, not BTC at 90,000.
  const a = (await api('PUT', `/api/trades/${t.id}/alert`, { goal_price: '95000' })).data;
  assert.equal(a.market, 'WBTC');
  assert.equal(a.basisPrice, 89000);
  const text = (await api('GET', `/api/trades/${t.id}/alert/preview?goal=95000`)).data.text;
  assert.match(text, /^WBTC reached your \$95,000\.00 goal\n/);
  assert.match(text, /\nBought: 0\.10000001 WBTC\n/);
  await api('DELETE', `/api/trades/${t.id}`);
});

await check('a trade can buy cbBTC, and its errors and its alert speak cbBTC and BTC', async () => {
  const t = (await api('POST', '/api/trades', borrow({ borrow_date: today, borrow_amount: '10000' }))).data;
  assert.equal(t.asset, 'eth', 'a new trade starts on ETH');
  const bought = { buy_date: today, buy_amount: '10000', buy_gas_usd: '1' };
  assert.equal((await api('PATCH', `/api/trades/${t.id}`, { asset: 'doge' })).data.error, 'Pick an asset.');
  assert.equal((await api('PATCH', `/api/trades/${t.id}`, { asset: '' })).data.error, 'Pick an asset.');
  const bad = await api('PATCH', `/api/trades/${t.id}`, { asset: 'cbbtc', ...bought, buy_eth: 'x' });
  assert.equal(bad.data.error, 'cbBTC purchased must be a number.');
  const slip = await api('PATCH', `/api/trades/${t.id}`, { asset: 'cbbtc', ...bought, buy_eth: '0.001' });
  assert.equal(slip.data.error, 'That is 10,000,000 USDC per cbBTC. Check the amount and the cbBTC.');
  const r = await api('PATCH', `/api/trades/${t.id}`, { asset: 'cbbtc', ...bought, buy_eth: '0.1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.asset, 'cbbtc');
  assert.equal(r.data.derived.buyPriceUsd, 100000, '10,000 for 0.1');

  // Set against BTC at the fixed 90,000, not ETH at 3,000: a rise.
  const a = (await api('PUT', `/api/trades/${t.id}/alert`, { goal_price: '95000' })).data;
  assert.equal(a.direction, 'above');
  assert.equal(a.basisPrice, 90000);
  assert.equal(a.market, 'BTC');
  // At $95,000: 0.1 worth $9,500, less the 10,000 spent and $1 of fees, no
  // interest on a loan opened today.
  const text = (await api('GET', `/api/trades/${t.id}/alert/preview?goal=95000`)).data.text;
  assert.match(text, /^BTC reached your \$95,000\.00 goal\n/);
  assert.match(text, /\nBought: 0\.10000000 cbBTC\n/);
  assert.match(text, /\nWorth now: \$9,500\.00\n/);
  assert.match(text, /Gain \(\$\): -\$501\.00 after \$0\.00 interest and \$1\.00 fees$/);

  // A change of asset ends the goal, which was a BTC price, and not as "not sent".
  assert.equal((await api('PATCH', `/api/trades/${t.id}`, { asset: 'eth' })).status, 200);
  const log = (await api('GET', '/api/alerts/log')).data.alerts.find((x) => x.id === a.id);
  assert.equal(log.status, 'closed');
  assert.equal(log.lastError, null);
  assert.equal(log.market, 'BTC', 'still says what it was set in');
  // The same asset sent again is no change, and leaves a new goal armed.
  const again = (await api('PUT', `/api/trades/${t.id}/alert`, { goal_price: '120000' })).data;
  await api('PATCH', `/api/trades/${t.id}`, { asset: 'eth', buy_gas_usd: '2' });
  assert.equal((await api('GET', '/api/alerts')).data.alerts[t.id]?.id, again.id);
  await api('DELETE', `/api/trades/${t.id}`);
});

server.kill('SIGTERM');
await new Promise((r) => server.once('exit', r));
if (process.exitCode && serverErr) warn(`server stderr:\n${serverErr}`);

/* ---------------------------------------------------------- the alert sweep */

// In this process, so each sweep can be driven by hand. Set before the first
// import of db.js, which opens the file it names.
Object.assign(process.env, isolated, {
  ETHROUNDTRIP_DB: path.join(tmp, 'alerts.db'),
  TELEGRAM_BOT_TOKEN: '1:test',
  TELEGRAM_CHAT_ID: '-1',
  ETHROUNDTRIP_ALERT_POLL_MS: '1000',
});
delete process.env.ETHROUNDTRIP_ETH_OFFLINE;
delete process.env.ETHROUNDTRIP_ETH_PRICE;
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

await check('an answer with no BTC in it does not hold ETH back', async () => {
  prepare(`UPDATE alerts SET status = 'closed' WHERE status = 'armed'`).run();
  const alert = saveAlert(holding(), 2550, 2600); // below: waits for a fall
  mock.btc = null;
  await priceAt(2600);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  // The next ETH price is asked for as usual. Put to sleep for a minute over
  // the missing coin, the sweep went on judging the goal at 2,600.
  mock.sent.length = 0;
  await priceAt(2540);
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'fired');
  assert.match(mock.sent[0] ?? '', /^ETH reached your \$2,550\.00 goal - now \$2,540\.00\n/);
  mock.btc = 90000;
});

await check('a coin left out of the answer is not asked for again by every caller', async () => {
  const { marketPrices } = await import('../prices.js');
  mock.btc = null;
  // Past the window, so both coins are due when the first caller asks.
  await wait(1100);
  mock.asked = 0;
  // Five callers in a row that accept a second-old price.
  for (let i = 0; i < 5; i += 1) await marketPrices({ maxAgeMs: 1000 });
  mock.btc = 90000;
  assert.equal(mock.asked, 1, 'one request, then the absence counts as asked');
});

await check('a cbBTC goal is watched against BTC, not ETH', async () => {
  // Only this goal armed, so nothing else answers the prices below.
  prepare(`UPDATE alerts SET status = 'closed' WHERE status = 'armed'`).run();
  const now = new Date().toISOString();
  const id = prepare(`
    INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, borrow_gas_usd,
                        buy_date, buy_amount, buy_eth, buy_gas_usd, asset, created_at, updated_at)
    VALUES (@d, 10000, 'USDC', 4, 1, @d, 10000, 0.1, 3, 'cbbtc', @now, @now)
  `).run({ d: today, now }).lastInsertRowid;
  const alert = saveAlert(prepare('SELECT * FROM trades WHERE id = ?').get(id), 95000, 90000);
  assert.equal(alert.direction, 'above');
  assert.equal(alert.market, 'BTC');

  // ETH far past the goal moves nothing.
  mock.btc = 90000;
  await priceAt(99000);
  mock.sent.length = 0;
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  assert.equal(mock.sent.length, 0);

  mock.btc = 96000;
  await priceAt(3000);
  await runAlertSweep();
  const a = getAlertById(alert.id);
  assert.equal(a.status, 'fired');
  assert.equal(a.firedPrice, 96000);
  assert.equal(mock.sent.length, 1);
  // Its lines add up to its Gain: 0.1 x 96,000 is $9,600, less the 10,000
  // spent and $4 of fees, no interest today: -$404.00, -4.04% of 10,000.
  assert.match(mock.sent[0], /^BTC reached your \$95,000\.00 goal - now \$96,000\.00\n/);
  assert.match(mock.sent[0], /\nBought: 0\.10000000 cbBTC\n/);
  assert.match(mock.sent[0], /\nWorth now: \$9,600\.00\nGain \(%\): -4\.04%\n/);
  assert.match(mock.sent[0], /Gain \(\$\): -\$404\.00 after \$0\.00 interest and \$4\.00 fees$/);
  prepare('DELETE FROM trades WHERE id = ?').run(id);
});

await check('a WBTC goal is watched against WBTC, not BTC', async () => {
  prepare(`UPDATE alerts SET status = 'closed' WHERE status = 'armed'`).run();
  const now = new Date().toISOString();
  const id = prepare(`
    INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, borrow_gas_usd,
                        buy_date, buy_amount, buy_eth, buy_gas_usd, asset, created_at, updated_at)
    VALUES (@d, 10000, 'USDC', 4, 1, @d, 10000, 0.1, 3, 'wbtc', @now, @now)
  `).run({ d: today, now }).lastInsertRowid;
  const alert = saveAlert(prepare('SELECT * FROM trades WHERE id = ?').get(id), 95000, 90000);
  assert.equal(alert.market, 'WBTC');

  // BTC past the goal moves nothing while WBTC is under it.
  mock.btc = 96000;
  mock.wbtc = 90000;
  await priceAt(3000);
  mock.sent.length = 0;
  await runAlertSweep();
  assert.equal(getAlertById(alert.id).status, 'armed');
  assert.equal(mock.sent.length, 0);

  mock.wbtc = 95500;
  await priceAt(3000);
  await runAlertSweep();
  const a = getAlertById(alert.id);
  assert.equal(a.status, 'fired');
  assert.equal(a.firedPrice, 95500);
  // 0.1 x 95,500 is $9,550, less the 10,000 spent and $4 of fees: -$454.00.
  assert.match(mock.sent[0], /^WBTC reached your \$95,000\.00 goal - now \$95,500\.00\n/);
  assert.match(mock.sent[0], /\nBought: 0\.10000000 WBTC\n/);
  assert.match(mock.sent[0], /Gain \(\$\): -\$454\.00 after \$0\.00 interest and \$4\.00 fees$/);
  prepare('DELETE FROM trades WHERE id = ?').run(id);
  mock.btc = 90000;
  mock.wbtc = 89900;
});

await check('a price of unknown age is not fresh', async () => {
  const { freshPrice } = await import('../alerts.js');
  // `ageOf` answers Infinity for a fetch time ahead of the clock.
  assert.equal(freshPrice({ price: 2400, ageMs: Infinity }), null);
  assert.equal(freshPrice({ price: 2400, ageMs: 0 }), 2400);
});

await check('a goal left armed in the other market from its trade is closed', async () => {
  prepare(`UPDATE alerts SET status = 'closed' WHERE status = 'armed'`).run();
  const t = holding();
  const a = saveAlert(t, 2550, 2600);
  // The trade turned cbBTC while the goal was out being sent, and the failed
  // send put it back to armed: an ETH goal on a BTC position.
  prepare("UPDATE trades SET asset = 'cbbtc' WHERE id = ?").run(t.id);
  await runAlertSweep();
  assert.equal(getAlertById(a.id).status, 'closed');
  prepare('DELETE FROM trades WHERE id = ?').run(t.id);
});

await check('a 200 that is not Telegram\'s answer is retried, not taken as a refusal', async () => {
  const { sendTelegramMessage } = await import('../telegram.js');
  mock.tg.push([200, 'html']);
  const r = await sendTelegramMessage('x');
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
});

await check('an owed alert resent with no fresh price is written at the price its goal was reached at', async () => {
  prepare(`UPDATE alerts SET status = 'closed' WHERE status = 'armed'`).run();
  const a = saveAlert(holding(), 2550, 2600);
  // Reached at 2,540 by an earlier sweep, its send failed; now the service
  // answers nothing usable for ETH, and the last ETH price grows old.
  prepare('UPDATE alerts SET fired_at = ?, fired_price = 2540 WHERE id = ?').run(new Date().toISOString(), a.id);
  mock.price = null;
  await wait(2100);
  mock.sent.length = 0;
  await runAlertSweep();
  mock.price = 3000;
  assert.equal(getAlertById(a.id).status, 'fired');
  assert.match(mock.sent[0] ?? '', /^ETH reached your \$2,550\.00 goal at \$2,540\.00\n/);
  // 4 ETH at 2,540 is $10,160.00; never "now", at a price that is not.
  assert.match(mock.sent[0], /\nWorth then: \$10,160\.00\n/);
  assert.doesNotMatch(mock.sent[0], /now/);
});

// Last of the sweeps: it leaves the poller stopped.
await check('once shutdown begins, the sweep claims nothing more', async () => {
  const { stopAlertPoller } = await import('../alerts.js');
  prepare(`UPDATE alerts SET status = 'closed' WHERE status = 'armed'`).run();
  const a = saveAlert(holding(), 2550, 2600);
  await priceAt(2540);
  stopAlertPoller();
  mock.sent.length = 0;
  await runAlertSweep();
  assert.equal(getAlertById(a.id).status, 'armed', 'not claimed, so not left FIRED and unsent');
  assert.equal(mock.sent.length, 0);
});

/* ------------------------------------------------------------- bot reports */

const { holdingText, helpText } = await import('../report.js');

await check('/price and /watch give ETH and BTC only, and say which could not be had', async () => {
  const { priceText, watchMessage } = await import('../report.js');
  const text = await watchMessage();
  assert.match(text, /^<b>ETH \$[\d,.]+<\/b>/);
  assert.match(text, /\n\n<b>BTC \$[\d,.]+<\/b>/);
  // WBTC values WBTC trades; it is not followed for itself.
  assert.doesNotMatch(text, /WBTC/);
  const one = priceText({ ETH: { price: 3000, ageMs: 0, change24h: 1.25 }, WBTC: { price: 89900, ageMs: 0 } });
  assert.match(one, /^<b>ETH \$3,000\.00<\/b>\n24h \+1\.3%\n\nCould not get the BTC price\./);
  assert.doesNotMatch(one, /WBTC/);
});

await check('/holding values each asset at its own market and totals them apart', async () => {
  const row = (id, asset, qty) => ({ id, asset, platform: 'aave', borrow_currency: 'USDC', borrow_amount: 10000,
    borrow_apr: 4, borrow_date: today, buy_date: today, buy_amount: 10000, buy_eth: qty, buy_gas_usd: 2 });
  const rows = [row(1, 'eth', 4), row(2, 'cbbtc', 0.1)];
  const text = holdingText(rows, { ETH: 3000, BTC: 96000 }, {});
  // A total line each: 4 ETH at 3,000 is $12,000, 0.1 cbBTC at 96,000 $9,600.
  assert.match(text, /^<b>Holding 2 trades<\/b>\n4\.0000 ETH · \$12,000\.00 at \$3,000\.00\n0\.10000000 cbBTC · \$9,600\.00 at \$96,000\.00\n/);
  // Each row at its own price, less $2 of fees and no interest today:
  // +$1,998.00 and -$402.00, summed as printed.
  assert.match(text, /\nUnrealised \+\$1,596\.00 after interest and fees\n/);
  assert.match(text, /#2  Aave  0\.10000000 cbBTC  paid \$100,000\.00/);
  // No BTC price: the cbBTC row is left out for that, not for a rate.
  assert.match(holdingText(rows, { ETH: 3000 }, {}), /Unrealised \+\$1,998\.00 after interest and fees \(1 without a BTC price is not counted\)/);
  assert.match(holdingText([row(2, 'cbbtc', 0.1)], { ETH: 3000 }, {}), /No BTC price right now, so the gain is not known\./);
});

await check('/holding gives a line per platform, adding up to its Unrealised', async () => {
  const row = (id, platform, asset, qty, amt = 10000) => ({ id, platform, asset, borrow_currency: 'USDC', borrow_amount: amt,
    borrow_apr: 4, borrow_date: today, buy_date: today, buy_amount: amt, buy_eth: qty, buy_gas_usd: 2 });
  // At ETH 3,000 and BTC 96,000, less $2 of fees each and no interest today:
  // #1 +$1,998.00 and #3 +$498.00 on Aave, #2 -$402.00 on Morpho, and #4,
  // 0.5 ETH for 1,500, -$2.00 with no platform recorded. +$2,092.00 in all.
  const text = holdingText(
    [row(1, 'aave', 'eth', 4), row(2, 'morpho', 'cbbtc', 0.1), row(3, 'aave', 'eth', 1, 2500), row(4, null, 'eth', 0.5, 1500)],
    { ETH: 3000, BTC: 96000 },
    {},
  );
  assert.match(text, /\nUnrealised \+\$2,092\.00 after interest and fees\nAave: 2 trades · 5\.0000 ETH · \+\$2,496\.00\nMorpho: 1 trade · 0\.10000000 cbBTC · -\$402\.00\nNot recorded: 1 trade · 0\.5000 ETH · -\$2\.00\n\n<pre>/);
  assert.match(text, /#2  Morpho  0\.10000000 cbBTC/);
  // A platform whose gain is not known says nothing rather than $0.00.
  assert.match(holdingText([row(1, 'aave', 'eth', 4), row(2, 'morpho', 'cbbtc', 0.1)], { ETH: 3000 }, {}), /\nMorpho: 1 trade · 0\.10000000 cbBTC\n/);
  // One platform: its line would repeat the totals, so there is none.
  assert.doesNotMatch(holdingText([row(1, 'aave', 'eth', 4), row(3, 'aave', 'eth', 1, 2500)], { ETH: 3000 }, {}), /Aave: /);
});

await check('a price of unknown age, or an old one under /summary, is said to be so', async () => {
  const { priceText, summaryText } = await import('../report.js');
  const { summarize } = await import('../lib/calc.js');
  const row = { id: 1, asset: 'eth', platform: 'aave', borrow_currency: 'USDC', borrow_amount: 10000, borrow_apr: 4,
    borrow_date: today, buy_date: today, buy_amount: 10000, buy_eth: 4, buy_gas_usd: 2 };
  // Infinity is `ageOf`'s "fetched ahead of the clock": unknown, not fresh.
  assert.match(priceText({ ETH: { price: 3000, ageMs: Infinity } }), /\n<i>Last fetched at an unknown time\.<\/i>/);
  assert.match(holdingText([row], { ETH: 3000 }, {}, { ages: { ETH: Infinity } }), /\n<i>At the price last fetched at an unknown time\.<\/i>/);
  const held = [{ asset: 'eth', ticker: 'ETH', market: 'ETH', total: 4, price: 3000, ageMs: 3 * 3_600_000 }];
  assert.match(summaryText(summarize([]), held), /<\/pre>\n<i>At the price last fetched 3 hours ago\.<\/i>$/);
  assert.doesNotMatch(summaryText(summarize([]), [{ ...held[0], ageMs: 1000 }]), /last fetched/);
});

await check('/holding names both absences when neither row has a gain', async () => {
  const row = (id, asset, qty, over = {}) => ({ id, asset, platform: 'aave', borrow_currency: 'USDC', borrow_amount: 10000,
    borrow_apr: 4, borrow_date: today, buy_date: today, buy_amount: 10000, buy_eth: qty, buy_gas_usd: 2, ...over });
  // A euro ETH row with no rate yet, and a cbBTC row with no BTC price.
  const text = holdingText([row(1, 'eth', 4, { borrow_currency: 'EURC' }), row(2, 'cbbtc', 0.1)], { ETH: 3000 }, {});
  assert.match(text, /\nThe gain is not known: 1 without an exchange rate, 1 without a BTC price\.\n/);
});

await check('/summary says what is held of each asset, valued at its own market', async () => {
  const { summaryText } = await import('../report.js');
  const { summarize } = await import('../lib/calc.js');
  const text = summaryText(summarize([]), [
    { asset: 'eth', ticker: 'ETH', market: 'ETH', total: 4, price: 3000 },
    { asset: 'cbbtc', ticker: 'cbBTC', market: 'BTC', total: 0.1, price: null },
  ]);
  assert.match(text, /\nETH held: +4\.0000 ETH \(\$12,000\.00\)\n/);
  assert.match(text, /\ncbBTC held: +0\.10000000 cbBTC<\/pre>$/);
  assert.doesNotMatch(summaryText(summarize([])), /held:/, 'nothing held, no line');
});

await check('/holding leaves out the euro move when a purchase rate is missing', async () => {
  // Two EURC positions of 10,000 on 4 ETH; only the first has its rate.
  const base = { borrow_date: today, borrow_amount: 10000, borrow_currency: 'EURC', borrow_apr: 0,
    buy_date: today, buy_amount: 10000, buy_eth: 4, buy_gas_usd: 0, borrow_gas_usd: 0, borrow_fx: 1.05 };
  const both = holdingText([{ ...base, id: 1, buy_fx: 1.05 }, { ...base, id: 2 }], { ETH: 3000 }, { EURC: 1.17 });
  assert.doesNotMatch(both, /move since purchase/);
  const one = holdingText([{ ...base, id: 1, buy_fx: 1.05 }], { ETH: 3000 }, { EURC: 1.17 });
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
  const text = holdingText([row(1), row(2), row(3)], { ETH: 1100 }, {});
  assert.equal(text.match(/\+\$96\.71/g)?.length, 3);
  assert.match(text, /Unrealised \+\$290\.13 /);
});

await check('/holding names each trade\'s platform, and a dash where none was recorded', async () => {
  const row = (id, platform) => ({ id, platform, borrow_date: today, borrow_amount: 1000, borrow_currency: 'USDT',
    borrow_apr: 0, borrow_gas_usd: 0, buy_date: today, buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0 });
  const lines = holdingText([row(1, 'aave'), row(22, 'etherfi'), row(3, null)], { ETH: 1100 }, {})
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
  assert.match(holdingText([row], { ETH: 1100 }, {}, { ages: { ETH: 2 * 3_600_000 } }), /At the price last fetched .+ ago\./);
  assert.doesNotMatch(holdingText([row], { ETH: 1100 }, {}, { ages: { ETH: 1000 } }), /last fetched/);
  // At the age the alert window calls stale (`freshPrice`: two refreshes,
  // ten minutes with the default poll, two seconds with this process's one),
  // not one alert poll: a price between the two was "not recent" in the
  // window and printed as current by /holding. And under a minute it says so,
  // not "0 minutes ago".
  assert.doesNotMatch(holdingText([row], { ETH: 1100 }, {}, { ages: { ETH: 1500 } }), /last fetched/);
  assert.match(holdingText([row], { ETH: 1100 }, {}, { ages: { ETH: 2500 } }), /At the price last fetched less than a minute ago\./);
});

await check('/holding names a missing ETH price as "an ETH price"', async () => {
  const row = { id: 1, platform: 'aave', borrow_date: today, borrow_amount: 1000, borrow_currency: 'USDT',
    borrow_apr: 0, borrow_gas_usd: 0, buy_date: today, buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0 };
  const btc = { ...row, id: 2, asset: 'cbbtc', buy_eth: 0.01, buy_amount: 1000 };
  const text = holdingText([row, btc], { BTC: 100000 }, {});
  assert.match(text, /1 without an ETH price/);
  assert.doesNotMatch(text, /without a ETH/);
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

/* ------------------------------------------------------- exchange rates */

// fx.js against a database of its own, in a child, with the rate service
// mocked. Spawned, not run with execFileSync: the mock answers from this
// process's event loop, which a synchronous child would block.
let fxDbs = 0;
function fxChild(body) {
  const env = {
    ...process.env,
    ...isolated,
    ETHROUNDTRIP_DB: path.join(tmp, `fx-${(fxDbs += 1)}.db`),
    ETHROUNDTRIP_FX_OFFLINE: '0',
    ETHROUNDTRIP_FX_URL: MOCK,
  };
  const code = `const { db, prepare } = await import('./db.js');\nconst fx = await import('./fx.js');\n${body}\nprocess.exit(0);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (status) => (status === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(err || `exit ${status}`))));
  });
}
const isoShift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
// A Wednesday two to three weeks back: well past the four days a stand-in is
// marked provisional, and with business days on both sides.
let fxDay = isoShift(today, -14);
while (new Date(`${fxDay}T00:00:00Z`).getUTCDay() !== 3) fxDay = isoShift(fxDay, -1);

await check('a stand-in rate is replaced past four days old, once the real one can be had', async () => {
  // Saved on a euro day before the ECB published, with the day before's rate,
  // and no refresh got through for longer than four days: the stand-in stayed
  // for good, its marker gone, while the real rate was there to be had.
  mock.fx = { rate: 1.1 };
  const r = await fxChild(`
    const now = new Date().toISOString();
    prepare("INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, platform, borrow_fx, borrow_fx_date, fx_source, created_at, updated_at) VALUES (?, 1000, 'EURC', 4, 'aave', 1.05, ?, 'ecb', ?, ?)")
      .run('${fxDay}', '${isoShift(fxDay, -1)}', now, now);
    prepare("INSERT INTO fx_rates (base, quote, date, rate, rate_date, source, fetched_at) VALUES ('EUR', 'USD', ?, 1.05, ?, 'ecb', ?)")
      .run('${fxDay}', '${isoShift(fxDay, -1)}', '${fxDay}T08:00:00.000Z');
    const first = await fx.refreshRatesNow();
    const row = prepare('SELECT borrow_fx, borrow_fx_date FROM trades').get();
    const again = await fx.refreshRatesNow();
    console.log(JSON.stringify({ filled: first?.filled ?? null, row, again }));
  `);
  assert.deepEqual(r.row, { borrow_fx: 1.1, borrow_fx_date: fxDay });
  assert.equal(r.filled, 1);
  // Settled: nothing left to ask about, so the list stays finite.
  assert.equal(r.again, null);
});

await check('a rate cached more than six days before its day is asked about again', async () => {
  // 2.1.7 kept a lagging mirror's answers: a rate from two weeks before the
  // day, cached and stored as final, was served for good after the upgrade.
  mock.fx = { rate: 1.1 };
  const r = await fxChild(`
    const now = new Date().toISOString();
    const old = '${isoShift(fxDay, -13)}';
    prepare("INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, platform, borrow_fx, borrow_fx_date, fx_source, created_at, updated_at) VALUES (?, 1000, 'EURC', 4, 'aave', 1.05, ?, 'ecb', ?, ?)")
      .run('${fxDay}', old, now, now);
    // Fetched ten days after its day, as 2.1.7 would have settled it.
    prepare("INSERT INTO fx_rates (base, quote, date, rate, rate_date, source, fetched_at) VALUES ('EUR', 'USD', ?, 1.05, ?, 'ecb', ?)")
      .run('${fxDay}', old, '${isoShift(fxDay, 10)}T12:00:00.000Z');
    const filled = (await fx.refreshRatesNow())?.filled ?? null;
    const row = prepare('SELECT borrow_fx, borrow_fx_date FROM trades').get();
    console.log(JSON.stringify({ filled, row }));
  `);
  assert.equal(r.filled, 1);
  assert.deepEqual(r.row, { borrow_fx: 1.1, borrow_fx_date: fxDay });
});

await check('a holiday stand-in is asked about once past the window, then settles', async () => {
  mock.fx = { rate: 1.1, holiday: fxDay };
  const r = await fxChild(`
    const now = new Date().toISOString();
    prepare("INSERT INTO trades (borrow_date, borrow_amount, borrow_currency, borrow_apr, platform, borrow_fx, borrow_fx_date, fx_source, created_at, updated_at) VALUES (?, 1000, 'EURC', 4, 'aave', 1.1, ?, 'ecb', ?, ?)")
      .run('${fxDay}', '${isoShift(fxDay, -1)}', now, now);
    prepare("INSERT INTO fx_rates (base, quote, date, rate, rate_date, source, fetched_at) VALUES ('EUR', 'USD', ?, 1.1, ?, 'ecb', ?)")
      .run('${fxDay}', '${isoShift(fxDay, -1)}', '${fxDay}T08:00:00.000Z');
    const first = await fx.refreshRatesNow();
    const again = await fx.refreshRatesNow();
    const row = prepare('SELECT borrow_fx_date FROM trades').get();
    console.log(JSON.stringify({ asked: first !== null, again, row }));
  `);
  assert.equal(r.asked, true);
  assert.equal(r.again, null);
  assert.equal(r.row.borrow_fx_date, isoShift(fxDay, -1));
});

await check('a rate from more than six days before its day is no answer', async () => {
  // A mirror that had fallen behind answered a weekday with a rate from two
  // weeks before, and it was stored as final; a range that stopped early
  // carried its last rate over every later day.
  mock.fx = { rate: 1.1, stale: isoShift(fxDay, -13) };
  const one = await fxChild(`
    const hit = await fx.resolveRate('EURC', '${fxDay}');
    console.log(JSON.stringify({ hit, cached: fx.cachedRate('EURC', '${fxDay}'), error: fx.fxStatus().lastError }));
  `);
  assert.equal(one.hit, null);
  assert.equal(one.cached, null);
  assert.match(one.error, /too long before/);

  mock.fx = { rate: 1.1, rangeEnd: isoShift(fxDay, -7) };
  const span = await fxChild(`
    const out = await fx.resolveRange('EURC', '${isoShift(fxDay, -10)}', '${fxDay}');
    console.log(JSON.stringify(Object.fromEntries(out)));
  `);
  assert.equal(span[fxDay], undefined);
  assert.equal(span[isoShift(fxDay, -7)].rateDate, isoShift(fxDay, -7));
  assert.equal(span[isoShift(fxDay, -1)].rateDate, isoShift(fxDay, -7));
});

await check('a rate service answering with a web page is reported in words, not with the page', async () => {
  mock.fx = { rate: 1.1, html: true };
  const r = await fxChild(`
    const hit = await fx.resolveRate('EURC', '${fxDay}');
    console.log(JSON.stringify({ hit, error: fx.fxStatus().lastError }));
  `);
  assert.equal(r.hit, null);
  assert.equal(r.error, 'The rate service did not answer with rates.');
  mock.fx = { rate: 1.1 };
});

await check('set-platform refuses a ledger that does not exist, and creates none', async () => {
  // Run without the service's ETHROUNDTRIP_DB, or with a typo in it, it made
  // an empty ledger there and said "Nothing to change.".
  const missing = path.join(tmp, 'nope', 'ledgr.db');
  const runIt = (...args) =>
    execFileSync(process.execPath, ['scripts/set-platform.mjs', ...args], {
      cwd: root,
      env: { ...process.env, ...isolated, ETHROUNDTRIP_DB: missing },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // --help answers, and opens nothing.
  assert.match(runIt('--help'), /Usage/);
  let failed = null;
  try {
    runIt();
  } catch (err) {
    failed = err;
  }
  assert.ok(failed, 'a dry run on a missing ledger should exit non-zero');
  assert.match(String(failed.stderr), /No database at .*ledgr\.db/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
});

await check('a new ledger is private: its folder 700, its file 600', async () => {
  // A fresh install made data/ 755 and the ledger 644, readable by any
  // account on the host.
  const file = path.join(tmp, 'fresh', 'data', 'ledger.db');
  execFileSync(process.execPath, ['--input-type=module', '-e', "const { closeDb } = await import('./db.js'); closeDb();"], {
    cwd: root,
    env: { ...process.env, ...isolated, ETHROUNDTRIP_DB: file },
    stdio: 'ignore',
  });
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

await check('set-platform: a dry run writes nothing, --apply sets Aave on the rest and keeps a set one', async () => {
  const file = path.join(tmp, 'platform.db');
  const runIt = (...args) =>
    execFileSync(process.execPath, ['scripts/set-platform.mjs', ...args], {
      cwd: root,
      env: { ...process.env, ...isolated, ETHROUNDTRIP_DB: file },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // Made through db.js, as the server makes one, then three trades: two with
  // no platform, one already on Ether.fi. (The script itself opens only a
  // ledger that exists.)
  execFileSync(process.execPath, ['--input-type=module', '-e', "const { closeDb } = await import('./db.js'); closeDb();"], {
    cwd: root,
    env: { ...process.env, ...isolated, ETHROUNDTRIP_DB: file },
    stdio: 'ignore',
  });
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
  assert.match(mock.sent[0], /Watching\. The prices every .+ here until \/unwatch\./);

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
  assert.match(holdingText([eur(1, 10002), eur(2, 10005.5)], { ETH: 3000 }, { EURC: 1.1712 }), /-\$2,414\.90 of it from the move/);
});

await check('/holding heads its rows with their sum as printed, and fits Telegram however long', async () => {
  const { holdingText } = await import('../report.js');
  const row = (id, eth, over = {}) => ({ id, platform: 'aave', borrow_currency: 'USDC', borrow_amount: 5000,
    borrow_apr: 4, borrow_date: today, buy_date: today, buy_amount: 5000, buy_eth: eth, buy_gas_usd: 2, ...over });
  // 1.23455 and 2.23455 print 1.2346 and 2.2346; summed raw they read 3.4691.
  assert.match(holdingText([row(1, 1.23455), row(2, 2.23455)], { ETH: 3000 }, {}), /3\.4692 ETH/);

  // 150 seven-figure euro positions at an hour-old price: every line above the
  // table at its longest. Counted as Telegram counts it, tags out.
  const big = Array.from({ length: 150 }, (_, i) => row(i + 1, 2.5, {
    borrow_currency: 'EURC', borrow_amount: 1234567.89, buy_amount: 1234567.89, borrow_fx: 1.0512, buy_fx: 1.0512 }));
  const text = holdingText(big, { ETH: 2999.99 }, { EURC: 1.1712 }, { ages: { ETH: 3 * 3_600_000 } });
  const visible = text.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp);/g, '_').length;
  assert.ok(visible <= 4096, `${visible} characters`);
  assert.match(text, /and \d+ more<\/pre>$/);
});

await check('/unwatch past the ten-command limit of a batch still stops the reports', async () => {
  const bot = await import('../bot.js');
  const date = Math.floor(Date.now() / 1000);
  const say = (id, text) => mock.updates.push({ update_id: id, message: { chat: { id: -1 }, text, date } });
  say(5000, '/watch');
  await bot.runBotTick();
  assert.equal(prepare('SELECT watch FROM bot_state WHERE id = 1').get().watch, 1);
  // Ten commands and then the stop, in one batch: the stop is the eleventh.
  for (let i = 1; i <= 10; i += 1) say(5000 + i, '/price');
  say(5011, '/unwatch');
  mock.sent.length = 0;
  await bot.runBotTick();
  assert.equal(prepare('SELECT watch FROM bot_state WHERE id = 1').get().watch, 0);
  assert.match(mock.sent.at(-1) ?? '', /^Stopped\./);
});

/* ------------------------------------------------------------------ the end */

closeDb();
await new Promise((r) => mockServer.close(r));
fs.rmSync(tmp, { recursive: true, force: true });

if (process.exitCode) warn(`\n${passed} passed, some failed.`);
else say(`ok - ${passed} server checks`);
process.exit(process.exitCode ?? 0);
