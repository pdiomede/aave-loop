# Aave Loop

Track leveraged trade cycles on Aave: borrow a stablecoin, buy ETH, sell it, repay the loan, and see what the round trip actually earned.

Local web app, SQLite storage, no account and no wallet connection. Borrow in USDC, USDT, DAI, GHO or EURC; every total is reported in US dollars, shown to two decimals with ETH to four.

## Run

```bash
./run_myAave.sh
```

Opens on http://localhost:3000, bound to loopback only. The script checks Node, installs dependencies if needed, and moves to the next free port when 3000 is taken (`--kill` reclaims it instead, `--port N` picks another).

Requires Node 18 or newer.

To empty the ledger and start over:

```bash
./resetDatabase.sh
```

It asks twice, refuses to run while a server has the file open, and keeps a timestamped backup under `data/backups`.

## How a trade works

A trade is created with the borrow alone, then each stage is added as it happens.

| Stage | You enter | Status becomes |
| --- | --- | --- |
| Borrow | date, amount, currency, APR | `OPEN` |
| Buy ETH | date, amount spent, ETH received | `HOLDING` |
| Sell ETH | date, ETH sold, amount received | `SOLD` |
| Repay | date, amount repaid | `CLOSED` |

## Views

**Trades** is the history table. Expand any row to see its four stages and edit them.

**Summary** reports performance by currency, net gain by month closed, best and worst trade, interest paid, win rate, total borrowed and average hold. Only closed trades count towards realized figures, and only ones whose exchange rate is known count towards the money.

## The math

| Figure | Formula |
| --- | --- |
| ETH buy price | `buy_amount / buy_eth` |
| ETH sell price | `sell_amount / sell_eth` |
| Gross gain | `sell_amount - buy_amount * (sell_eth / buy_eth)` |
| Days | borrow date to repay date |
| Accrued interest | `borrow_amount * apr% * days / 365` |
| Suggested repayment | `borrow_amount + accrued_interest` |
| Net gain | `sell_amount - repay_amount` |
| Annualized return | `net_gain_usd / borrow_usd * 365 / days` |

Gross gain uses the cost basis of the ETH actually sold, so a partial exit is not reported as a loss.

## Currencies and exchange rates

Amounts are recorded in the coin that was borrowed. Every total, every statistic and
every column of the history table is reported in US dollars, because adding euros to
dollars gives a number that means nothing.

For a dollar coin the two are the same thing. For EURC each stage is converted at the
European Central Bank euro reference rate published for the day of that transaction, so
a loan taken in January and repaid in March is converted at two different rates and the
euro's own movement lands in the dollar result, as it did in reality.

| Figure | Formula |
| --- | --- |
| Any amount in dollars | `amount * rate_for_that_day` |
| Loan cost | `repaid_usd - borrowed_usd` |
| of which interest | `interest_paid * repay_rate` |
| of which currency | `borrowed * (repay_rate - borrow_rate)` |
| Net gain | `gross_gain_usd - loan_cost` |

The loan cost can be negative: if the euro fell between borrowing and repaying, the loan
was cheaper in dollars than its interest alone. The Repaid card shows the two parts
separately so this reads as an explanation rather than a mistake.

Rates come from the ECB, which publishes once per business day. A Sunday transaction is
therefore converted at Friday's rate, and the day the rate was published is stored and
shown next to it, so any figure can be checked against the ECB's own tables.

**EURC is valued as one euro.** There is no free historical feed for the coin itself, and
it tracks the euro closely enough for this to be the honest approximation. It is an
approximation all the same.

**Working offline.** A trade always saves, whether or not a rate could be fetched. One
without a rate is marked rather than guessed at, is left out of the totals rather than
counted as if a euro were a dollar, and the **Fetch rates** button on the Summary fills
in everything outstanding once the network is back. Rates are cached, so each day is
only ever looked up once.

**A known limitation.** An open position is not marked to today's rate. Its dollar value
is its cost basis on the day it was borrowed, so the currency's movement on capital still
at work is not shown until the loan is repaid.

The percentage is annualized, so a 3 day trade netting 7% shows as roughly 877%.

## Price alerts

While a trade is HOLDING - the ETH is bought and not yet sold - the **Bought ETH** card
carries a bell. It opens a window showing what the trade cost, when, and what ETH is
worth now, and takes one figure: the price you want to be told about. The window shows
the message that will be sent, in full, before anything is saved.

One alert per trade. Saving again replaces it and re-arms it; **Remove alert** deletes
it. Which way it reads is settled when you save, against what ETH costs at that moment:
a goal above alerts when ETH rises to it, a goal below alerts when it falls. Selling the
ETH, or undoing the purchase, stops the alert being checked without deleting it - put
the stage back and it picks up where it was.

The price comes from CoinGecko, which answers without a key, and is checked every
fifteen minutes - but only when at least one alert is armed, so a ledger with none on it
never calls out. An alert fires once. A second copy of the app running against the same
database cannot send the same message twice.

Sending needs a Telegram bot. Copy the template and fill it in:

```bash
cp config.env.example config.env && chmod 600 config.env
```

| Key | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from [@BotFather](https://t.me/BotFather), after `/newbot` |
| `TELEGRAM_CHAT_ID` | the group's id; negative, and starting `-100` for a supergroup |
| `TELEGRAM_GROUP_NAME` | display only, shown in the alert window and at startup |

Add the bot to the group before reading its chat id from
`https://api.telegram.org/bot<token>/getUpdates`. `config.env` is gitignored and anything
in it can be overridden for one run by exporting it in the shell.

Without the file the app runs exactly as before: the bell works, goals are saved, and
the window says what is missing. `POST /api/alerts/test` sends one message now, which is
the quick way to find out whether the token and the chat id are right.

## Layout

```
landing/       public marketing page, served by nginx rather than by the app
server.js      Express API and static host
db.js          SQLite connection and schema
fx.js          exchange rate lookup and cache, server only
eth.js         ETH spot price lookup and cache, server only
telegram.js    sending one message to a group, server only
alerts.js      price alerts and the timer that checks them, server only
config.js      reads config.env, server only
lib/calc.js    all formulas, shared by the server and the browser
public/        interface
data/          SQLite file, not committed
```

## Landing page

`landing/` is a static page for people who have not logged in. nginx serves it at `/`
and keeps everything else on the host behind basic auth, so the ledger itself sits at
`/app` and the Node process has no publicly reachable route at all.

It is deliberately self contained. It must not link `/styles.css`, because that path is
behind auth and a public visitor would get a 401 and an unstyled page, so the design
tokens are copied into `landing/styles.css` instead. Brand images are not copied: nginx
serves `aaveLogo.png` and the coin marks straight from `public/`, so there is one copy
of each in the repo.

The theme toggle shares the `myaave-theme` localStorage key with the app, so the choice
carries between the two pages. The version in the footer is hard coded, since
`/api/version` is behind auth, and needs bumping by hand with the others.

`landing/404.html` is served by both nginx and the app: nginx points `error_page 404` at
it for a missing public file, and the app returns it for an unknown path. An unknown path
under `/api` gets JSON instead, because every other API answer is JSON. The 404 carries no
version number, so it is not a third place to remember to bump.

## Running behind a proxy

The ledger binds to loopback and checks the `Host` header, because it has no login of its
own and a page on the internet can otherwise point its own hostname at `127.0.0.1` and
reach the API as a same origin. Behind a reverse proxy the Host is the public name, so
name it:

```
MYAAVE_ALLOWED_HOSTS=aaveloop.com,www.aaveloop.com
```

Unset, nothing changes: only `localhost`, `127.0.0.1` and `[::1]` are accepted. Set, those
still work and the named hosts are added. Any other hostname is still refused, which is
the whole point of the check.

## License

MIT. See [LICENSE.md](LICENSE.md).
