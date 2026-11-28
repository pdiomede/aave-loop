# ETH Roundtrip

Track leveraged trade cycles: borrow a stablecoin, buy an asset, sell it, repay the loan, and see what the round trip really earned.

- **Platforms:** Aave, Ether.fi, Morpho; on Solana, Jupiter and Kamino.
- **Assets:** ETH, cbBTC (valued at BTC's price), WBTC, SOL, PSOL.
- **Sides:** each trade is marked Long or Short (a label for now: every figure is worked out as a long).
- **Borrowed in:** USDC, USDT, DAI, GHO or EURC. Every total is in US dollars, to the cent.

A local web app on SQLite: no account, no wallet connection. Release notes in [CHANGELOG.md](CHANGELOG.md), licence [MIT](LICENSE.md).

## Run

```bash
./runETHRoundTrip.sh
```

Opens on http://localhost:3000 (Node 18+). If the port is taken it moves to the next free one; `--kill` stops the other program instead, `--port N` picks one.

| Command | Does |
| --- | --- |
| `./resetDatabase.sh` | empties the ledger, after a backup to `data/backups` |
| `./backupDatabase.sh` | backs up while the server runs (`--help` for the cron line) |
| `node scripts/set-platform.mjs --etherfi <id> --apply` | fills in the platform on old trades (dry run without `--apply`) |
| `node scripts/set-side.mjs --apply` | marks every trade with no side as Long (dry run without `--apply`) |
| `node scripts/audit-hashes.mjs` | checks stored transaction hashes against their trades |
| `npm run check` | runs the offline test suites |

## A trade, stage by stage

| Stage | You enter | Status |
| --- | --- | --- |
| Borrow | platform, long or short, date, coin, amount, APR, gas (optional) | `OPEN` |
| Buy | asset, date, amount spent and received, swap costs | `HOLDING` |
| Sell | date, amount sold and received, swap costs | `SOLD` |
| Repay | date, amount repaid, gas (optional) | `CLOSED` |

Fees are in dollars, and swap costs are required. A blank optional fee reads *not recorded*, never $0.00. On Solana platforms gas is not asked for.

## The views

- **Trades:** a tab per year (every year a trade was active in, then All) above the history table, each trade's side marked by a green up (Long) or red down (Short) arrow before its coin. Expand a row to edit its stages. The chips beside History (All, Closed, Open, Holding) filter it; Open includes trades sold but not yet repaid.
- **Stats:** performance overall and per platform, split by platform, asset, wallet, currency, month and long or short, with a tab per year. **Export CSV** and a one-page **Statement** PDF of the year's closed trades.
- **Alerts:** every price alert and when it fired.
- **Wallets:** your addresses on Ethereum, Base, Arbitrum, Optimism or Solana. **Onchain Data** groups trades by wallet and finds each stage's transaction (see below).
- **The four tiles above Trades' history** follow its year (they show on Trades only; Stats has its own overview, with the same Est. gain): a past year as it stood on 31 Dec, its gains counted in the year they were repaid and its open positions valued at that day's prices. **Open positions** is what open trades would make if closed today (or on 31 Dec, for a past year). The table shows the same figure tagged `est`.

## The math

| Figure | Formula |
| --- | --- |
| Gross gain | `sell_amount - buy_amount * (sell_qty / buy_qty)` |
| Interest | `borrow_amount * apr% * days / 365` |
| Net gain | `gross_gain - interest - fees` |
| Annualized | `net_gain_usd / borrow_usd * 365 / days` |
| Estimate, holding | `qty * price_now - (buy_amount + interest) * rate_today - fees` |

A partial sale counts only the cost of what was sold. Every figure is rounded to the cent as printed, so each card adds up line by line.

## Exchange rates

A EURC stage converts at the European Central Bank's rate for its own day (through Frankfurter), so the euro's move between borrow and repay shows in the loan cost, which can be negative. A weekend uses Friday's rate; a day not yet published uses the day before's, marked provisional, until the real one arrives. Missing rates are looked up every hour, or at once with **Fetch rates** on Stats. Only estimates use today's rate.

## Price alerts and the Telegram bot

While a trade holds its asset, the bell on its **Bought** card sets one goal price, in that trade's market. Prices come from CoinGecko every fifteen minutes while an alert is armed. An alert fires once and goes to Telegram; selling closes it.

| Command | Returns |
| --- | --- |
| `/price` | BTC, ETH and SOL now, with 24h, 7d and 30d change |
| `/holding` | each trade still holding its asset, with its estimated gain |
| `/summary` | realized gain, annualized, closed and open trades, holdings |
| `/watch` / `/unwatch` | prices every 20 minutes while something is held, or stop |

The bot answers only in `TELEGRAM_CHAT_ID`'s chat, and in your private chat if `TELEGRAM_OWNER_ID` is set. To fill the `/` menu, send `/setcommands` to [@BotFather](https://t.me/BotFather) and paste:

```
price - BTC, ETH and SOL prices now, with 24h, 7d and 30d change
holding - trades still holding ETH, cbBTC, WBTC, SOL or PSOL, one line each
summary - realized gain, annualized, closed, open and held
watch - send the BTC, ETH and SOL prices every 20 minutes
unwatch - stop the price updates
help - what this bot can do
```

## config.env

```bash
cp config.env.example config.env && chmod 600 config.env
```

| Key | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from `/newbot` at [@BotFather](https://t.me/BotFather); keep it secret |
| `TELEGRAM_CHAT_ID` | your user id ([@userinfobot](https://t.me/userinfobot)) or a group's negative id |
| `TELEGRAM_OWNER_ID` | optional: your id, so a group bot also answers you privately |
| `ETHERSCAN_API_KEY` | free key from etherscan.io, for Ethereum and Arbitrum transactions |
| `HELIUS_API_KEY` or `SOLANA_RPC_URL` | for Solana transactions |
| `BASE_RPC_URL` | a Base node; without one, Base hashes are pasted by hand |

To find a group's id, add the bot, post a `/` message, and with the app stopped run:

```bash
curl -s "https://api.telegram.org/bot<token>/getUpdates" | grep -o '"id":-[0-9]*'
```

Restart after editing; the startup log says whether alerts can be sent. Test with:

```bash
curl -X POST -H 'Content-Type: application/json' http://localhost:3000/api/alerts/test
```

An exported variable overrides the file for one run, and `ETHROUNDTRIP_CONFIG` points at a file elsewhere. The file is gitignored and the token never appears in a log.

## Layout

```
server.js      Express API and static host
db.js          SQLite schema
lib/           shared with the browser: calc.js (every formula), input.js, csv.js, statement.js
public/        the app's interface
landing/       the public page, served by nginx
alerts.js bot.js telegram.js report.js   alerts and the Telegram bot
fx.js prices.js                          exchange rates and market prices
etherscan.js chainnode.js solana.js      finding transactions on chain
scripts/       checks and release tooling
data/          the SQLite file, not committed
NEXT.md        VPS steps after a release, and what to build next
```
