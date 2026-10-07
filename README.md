# Aave Loop

Track leveraged trade cycles on Aave: borrow a stablecoin, buy ETH, sell it, repay the loan, and see what the round trip actually earned.

A local web app on SQLite, with no account and no wallet connection. Borrow in USDC, USDT, DAI, GHO or EURC; every total is in US dollars, to the cent, with ETH to four places. Release notes are in [CHANGELOG.md](CHANGELOG.md). Licensed [MIT](LICENSE.md).

## Run

```bash
./run_myAave.sh
```

Opens on http://localhost:3000, loopback only, on Node 18 or newer. The script installs dependencies if needed and moves to the next free port when 3000 is taken (`--kill` reclaims it, `--port N` picks one).

- `./resetDatabase.sh` empties the ledger. It asks twice, refuses while a server has the file open, and keeps a backup under `data/backups`.
- `./backupDatabase.sh` takes a backup that is safe while the server runs; `--help` gives the cron line.
- `npm run check` runs four offline suites: the formulas in `lib/calc.js` against hand-worked figures, the forms' input rules, the Statement PDF, and the server itself against a throwaway database with Telegram and the price service mocked.

## How a trade works

A trade starts with the borrow; each stage is added as it happens.

| Stage | You enter | Status becomes |
| --- | --- | --- |
| Borrow | date, currency, amount, APR, gas fee (optional) | `OPEN` |
| Buy ETH | date, amount spent, ETH received, costs & fees (swap), gas fee to lend (optional) | `HOLDING` |
| Sell ETH | date, ETH sold, amount received, gas fee to unstake (optional), costs & fees (swap) | `SOLD` |
| Repay | date, amount repaid, gas fee (optional) | `CLOSED` |

Fees are in dollars whatever was borrowed, and 0 is a figure. The swaps require theirs (gas plus the DEX fee). A blank borrow or repay fee shows as *not recorded*, never $0.00; a blank Aave lend or unstake fee means none was paid.

- **Trades** is the history table. Expand a row to see and edit its four stages.
- **Stats** shows performance, net gain by currency and by month closed, the biggest and smallest trade in dollars and by annualized rate, interest paid, total borrowed, average hold and fees. It has a tab per year plus **All**: a trade counts in the year it was repaid, and one still open in the current year. Only closed trades count towards realized figures, and only those with a known exchange rate towards the money.
- **Export CSV** downloads the tab's trades, one row each with every input and derived figure; an unknown figure is an empty cell. It is semicolon-separated with decimal commas, for Excel in a European locale.
- **Statement** downloads the year's closing statement as a one-page PDF: the trades closed that year, never open ones.
- **Open positions**, in the header, estimates what the open trades would make if closed today, at the current ETH price and exchange rate. The table's Net gain column shows the same figure, tagged `est`, as do `/holding` and the alert messages.

## The math

| Figure | Formula |
| --- | --- |
| ETH buy / sell price | `buy_amount / buy_eth`, `sell_amount / sell_eth` |
| Gross gain | `sell_amount - buy_amount * (sell_eth / buy_eth)` |
| Accrued interest | `borrow_amount * apr% * days / 365` |
| Fees | the six stage fees, in dollars |
| Net gain | `gross_gain - interest_paid - fees` |
| Annualized | `net_gain_usd / borrow_usd * 365 / days` |
| Estimate, holding | `buy_eth * eth_price_now - (buy_amount + accrued_interest) * rate_today - fees` |
| Estimate, sold | `(gross_gain - accrued_interest) * rate_today - fees`, plus any ETH still held at today's price less its cost |

Gross gain uses the cost of the ETH actually sold, so a profitable partial exit is never reported as a loss. The return is annualized: a 3 day trade netting 7.2% reads 876%. Every amount, conversion and fee is taken to the cent as printed, so each card and total adds up from its lines.

## Exchange rates

Amounts are recorded in the borrowed coin and reported in dollars. A EURC stage converts at the European Central Bank reference rate for its own day, so the euro's movement between borrowing and repaying lands in the result.

| Figure | Formula |
| --- | --- |
| Loan cost | `repaid_usd - borrowed_usd` |
| of which interest | `interest_paid * repay_rate` |
| of which currency | the rest: `borrowed * (repay_rate - borrow_rate)` |
| Net gain | `gross_gain_usd - loan_cost - fees` |

A loan cost can be negative: if the euro fell, the loan was cheaper in dollars than its interest.

- **Rates are the ECB's**, through a public mirror of its daily file (`MYAAVE_FX_URL` points elsewhere). It publishes on business days, so a Sunday trade takes Friday's rate; the publication date is shown beside each figure so it can be checked against [the ECB's tables](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html).
- **EURC is valued as one euro**, the honest approximation with no free feed for the coin itself.
- **Rates fill themselves in.** A trade always saves. One without a rate is marked, left out of the totals, and looked up every hour; **Fetch rates** on Stats asks at once.
- **Only estimates use today's rate.** A trade's own dollar figures stay at the rates of the days they happened.

## Price alerts

While a trade holds ETH, the **Bought ETH** card has a bell. It takes one goal price and shows the message in full before saving. A goal above today's ETH price waits for a rise, one below for a fall. A trade has one armed alert; saving again replaces it.

The price comes from CoinGecko, without a key, every fifteen minutes, and only while an alert is armed. An alert fires once, even with two copies of the app on one database. It stays in the **Alerts** view, ten to a page, with the time and price its goal was reached. Selling the ETH closes it for good. Sending needs a Telegram bot in `config.env`; without one, goals are still saved and the window says what is missing.

## Bot commands

The bot answers in the chat `TELEGRAM_CHAT_ID` names, and in your private chat if `TELEGRAM_OWNER_ID` is set. Anything from another chat is ignored, since `/holding` is your whole position.

| Command | Returns |
| --- | --- |
| `/price` | ETH now, with 24h, 7d and 30d change |
| `/holding` | each trade still holding ETH, with its estimated gain, the total and what it is worth. A trade sold but not repaid is open, and `/summary` counts it, but it holds no ETH and is not listed |
| `/summary` | realized net gain, blended annualized, closed trades, open positions |
| `/watch` / `/unwatch` | the price every twenty minutes, or stop |

`/help`, `/start` and anything unrecognised list the commands. A `@name` suffix, capitals and arguments are fine. Commands are read by long polling, so nothing needs to be reachable from the internet; two copies of the app share one reader by a lease. `/watch` survives a restart.

Telegram draws the Menu button only in a private chat. To get it, set `TELEGRAM_CHAT_ID` to your own user id, or keep the group and set `TELEGRAM_OWNER_ID` too; alerts still go to the group alone. To fill the `/` menu, send `/setcommands` to [@BotFather](https://t.me/BotFather) and paste:

```
price - ETH price now, with 24h, 7d and 30d change
holding - trades still holding ETH, one line each
summary - realized gain, annualized, closed and open
watch - send the price every 20 minutes
unwatch - stop the price updates
help - what this bot can do
```

## Setting up config.env

1. **Make a bot.** Send `/newbot` to [@BotFather](https://t.me/BotFather). The token it returns is the bot; keep it like a password.
2. **Choose the chat.** For a private chat, send `/start` to the bot and take your id from [@userinfobot](https://t.me/userinfobot). For a group, add the bot (it needs no admin rights), post a message starting with `/`, and read the id, which is negative:
   ```bash
   curl -s "https://api.telegram.org/bot<token>/getUpdates" | grep -o '"id":-[0-9]*'
   ```
   Do this with the app stopped or started with `MYAAVE_BOT_OFF=1`: only one reader is allowed, and a running app takes the updates first. A group's id changes when it becomes a supergroup, which making the bot an admin can trigger; the log prints the id of every chat it ignores.
3. **Write the file** in the app's directory, then fill it in:
   ```bash
   cp config.env.example config.env && chmod 600 config.env
   ```

   | Key | What it is |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | the token |
   | `TELEGRAM_CHAT_ID` | the chat id |
   | `TELEGRAM_CHAT_NAME` | display only |
   | `TELEGRAM_OWNER_ID` | optional: your user id, so a group bot answers you privately too |
4. **Restart.** The file is read at startup, which logs either `Price alerts will message <chat>.` or what is missing.
5. **Send a test:**
   ```bash
   curl -X POST -H 'Content-Type: application/json' http://localhost:3000/api/alerts/test
   ```
   `{"ok":true}` and a message means it works; otherwise the answer says why (`chat not found`, `Unauthorized`). One test per ten seconds.

The format is `KEY=value` per line, with `#` comments, an optional `export ` and one pair of quotes stripped; no interpolation. An exported variable overrides the file for one run. Where the app directory is not yours to write, point at a file you own with `MYAAVE_CONFIG=/path/to/file`. `config.env` is gitignored, the app warns if others can read it, and the token never appears in a log or a response.

## Layout

```
landing/       public page, served by nginx
server.js      Express API and static host
db.js          SQLite connection and schema
fx.js eth.js   exchange rates and the ETH price, cached
telegram.js    sending one message
alerts.js      price alerts and their timer
bot.js         reading and answering commands
report.js      what the bot says, with format.js
config.js      reads config.env
lib/           shared with the browser: calc.js (every formula), input.js (form rules),
               csv.js (the export), statement.js and logo.js (the PDF)
public/        interface
scripts/       release tooling and npm run check
data/          SQLite file, not committed
```
