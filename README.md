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

Sending needs a Telegram bot of its own, set up once in `config.env`. Without that file
nothing breaks: the bell works, goals are saved and kept, and the window says what is
missing.

## Setting up config.env

Alerts are the one part of this app that speaks to the outside world on your behalf, so
they need a bot and somewhere to send to. Five minutes, once.

**1. Make a bot.** Message [@BotFather](https://t.me/BotFather) and send `/newbot`. It
asks for a display name, then a username ending in `bot`, and answers with a token like
`123456789:AAE...`. That token *is* the bot: anyone holding it can post as it, so treat
it the way you would a password.

**2. Put the bot in the group.** Open the group, add a member, search for the username
you just chose. Nothing else is needed - a bot can post to a group without being an
administrator.

**3. Find the group's chat id.** Send a message beginning with `/` in the group, then
ask Telegram what it saw:

```bash
curl -s "https://api.telegram.org/bot<token>/getUpdates" | grep -o '"id":-[0-9]*'
```

It has to be a `/` message. A bot in a group is given Telegram's privacy mode by
default, which means it is shown commands and replies to itself and nothing else, so
ordinary chat will leave `getUpdates` empty and look like a failure. The id is negative,
and begins `-100` for a supergroup. Privacy mode has no bearing on anything after this
step, because the app only ever sends.

**4. Write the file**, in the directory the app runs from:

```bash
cp config.env.example config.env && chmod 600 config.env
```

| Key | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token from step 1 |
| `TELEGRAM_CHAT_ID` | the id from step 3 |
| `TELEGRAM_GROUP_NAME` | display only: shown in the alert window and at startup |

**5. Restart, and read the line it prints.** The file is read once, when the process
starts, so a ledger already running will not notice an edit. On the way up it says one
of:

```
Price alerts will message Aave Loop Alerts.
Price alerts are not configured: TELEGRAM_CHAT_ID is missing from config.env.
```

**6. Send a test**, rather than waiting for the market to tell you whether it works:

```bash
curl -X POST http://localhost:3000/api/alerts/test
```

`{"ok":true,"error":null}` and a message in the group means it is done. Anything else
comes back as a sentence rather than a stack trace: `Bad Request: chat not found` for a
wrong id, `Unauthorized` for a wrong token. One test per ten seconds.

### Notes on the file

**The format** is `KEY=value`, one per line. Blank lines and `#` comments are skipped, a
leading `export ` is tolerated because these get pasted out of a shell, and one matching
pair of surrounding quotes is stripped. There is no interpolation and no escapes: a bot
token needs neither, and every such feature is another way to read a secret wrong.

**Anything in it can be overridden for one run** by exporting it first, the same rule
every other setting in this app follows:

```bash
TELEGRAM_CHAT_ID=-1009876543210 npm start
```

**On a server, where the app directory is not yours to write to**, the copy will be
refused. Either put the file there as root and hand it to whichever user the app runs
as - `ls -ld .` and the service's `User=` will say who that is:

```bash
sudo cp config.env.example config.env
sudo chown "$APP_USER:$APP_USER" config.env
sudo chmod 600 config.env
```

or keep it somewhere you own and point the app at it, which needs no root at all:

```bash
MYAAVE_CONFIG=/home/you/aave-loop.env npm start
```

**`config.env` is gitignored by name**, because `.env.*` does not match it. Only
`config.env.example`, which holds placeholders, is committed. The app warns once at
startup if the file is readable by other users on the machine, and the token appears in
no log line, no error message and no API response.

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
