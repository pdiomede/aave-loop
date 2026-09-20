# Aave Loop

Track leveraged trade cycles on Aave: borrow a stablecoin, buy ETH, sell it, repay the loan, and see what the round trip actually earned.

Local web app, SQLite storage, no account and no wallet connection. Borrow in USDC, USDT, DAI, GHO or EURC; every total is reported in US dollars, shown to two decimals with ETH to four.

Release notes for every version are in [CHANGELOG.md](CHANGELOG.md).

## Run

```bash
./run_myAave.sh
```

Opens on http://localhost:3000, bound to loopback only. Requires Node 18 or newer. The script checks Node, installs dependencies if needed, and moves to the next free port when 3000 is taken (`--kill` reclaims it instead, `--port N` picks another).

`./resetDatabase.sh` empties the ledger. It asks twice, refuses to run while a server has the file open, and keeps a timestamped backup under `data/backups`.

## How a trade works

A trade is created with the borrow alone, then each stage is added as it happens.

| Stage | You enter | Status becomes |
| --- | --- | --- |
| Borrow | date, amount, currency, APR | `OPEN` |
| Buy ETH | date, amount spent, ETH received | `HOLDING` |
| Sell ETH | date, ETH sold, amount received | `SOLD` |
| Repay | date, amount repaid | `CLOSED` |

**Trades** is the history table; expand a row to see its four stages and edit them. **Summary** reports performance by currency, net gain by month closed, the biggest and smallest trade ranked two ways - in dollars and by annualized rate, which rarely name the same trade - plus interest paid, total borrowed and average hold. Only closed trades count towards realized figures, and only ones whose exchange rate is known count towards the money.

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

Gross gain uses the cost basis of the ETH actually sold, so a partial exit is not reported as a loss. The return is annualized, so a 3 day trade netting 7% shows as roughly 877%.

## Currencies and exchange rates

Amounts are recorded in the coin that was borrowed, and every total is reported in US dollars, because adding euros to dollars gives a number that means nothing. For a dollar coin the two are the same thing. For EURC each stage is converted at the European Central Bank euro reference rate published for the day of that transaction, so a loan taken in January and repaid in March is converted at two different rates and the euro's own movement lands in the dollar result, as it did in reality.

| Figure | Formula |
| --- | --- |
| Any amount in dollars | `amount * rate_for_that_day` |
| Loan cost | `repaid_usd - borrowed_usd` |
| of which interest | `interest_paid * repay_rate` |
| of which currency | `borrowed * (repay_rate - borrow_rate)` |
| Net gain | `gross_gain_usd - loan_cost` |

The loan cost can be negative: if the euro fell between borrowing and repaying, the loan was cheaper in dollars than its interest alone. The Repaid card shows the two parts separately so this reads as an explanation rather than a mistake.

- **Rates come from the ECB**, which publishes once per business day, so a Sunday transaction is converted at Friday's rate. The publication date is stored and shown next to the figure, so any conversion can be checked against the ECB's own tables.
- **EURC is valued as one euro.** There is no free historical feed for the coin itself, and it tracks the euro closely enough for this to be the honest approximation. It is an approximation all the same.
- **Working offline.** A trade always saves, whether or not a rate could be fetched. One without a rate is marked rather than guessed at and left out of the totals; **Fetch rates** on the Summary fills in everything outstanding once the network is back. Each day is only ever looked up once.
- **A known limitation.** An open position is not marked to today's rate. Its dollar value is its cost basis on the day it was borrowed, so the currency's movement on capital still at work is not shown until the loan is repaid.

## Price alerts

While a trade is HOLDING - the ETH is bought and not yet sold - the **Bought ETH** card carries a bell. It opens a window showing what the trade cost, when, and what ETH is worth now, and takes one figure: the price you want to be told about. The message that will be sent is shown in full before anything is saved.

One *armed* alert per trade. Saving again replaces it; **Remove alert** deletes it. Which way it reads is settled when you save, against what ETH costs at that moment: a goal above alerts when ETH rises to it, a goal below alerts when it falls. Selling the ETH, or undoing the purchase, stops the alert being checked without deleting it - put the stage back and it picks up where it was.

**A fired alert is kept.** The bell goes back to unselected once the message has gone, so a new goal can be set on the same trade, and the one that fired stays in the **Alerts** view with the time it was sent and the price it fired at. That view lists every alert ever set, fifteen to a page, and each row can be deleted - as can the whole list at once.

The price comes from CoinGecko, which answers without a key, and is checked every fifteen minutes - but only when at least one alert is armed, so a ledger with none on it never calls out. An alert fires once, and a second copy of the app running against the same database cannot send the same message twice.

Sending needs a Telegram bot of its own, set up once in `config.env`. Without that file nothing breaks: the bell works, goals are saved and kept, and the window says what is missing.

## Bot commands

The bot answers in the group named by `TELEGRAM_CHAT_ID`, and only there. It can be found by anyone who knows its username, and `/holding` is the whole of your position, so a command from any other chat is ignored without a reply.

| Command | Returns |
| --- | --- |
| `/price` | ETH now, with 24h, 7d and 30d change |
| `/holding` | every open position, one line each, with the total and what it is worth |
| `/summary` | realized net gain, blended annualized, closed trades, open positions |
| `/watch` | the price report every twenty minutes |
| `/unwatch` | stops it |

`/help` lists them; `/start` does the same, because Telegram sends it by itself the first time a chat with a bot is opened. Anything unrecognised gets the same list. A `@name` suffix, capitals and trailing arguments are all fine: `/Price@aave_loop_bot now` is `/price`.

**The Menu button is a private-chat feature.** Telegram draws it in a one-to-one chat with a bot and nowhere else; in a group the equivalent is the `/` icon in the message box, which appears once a bot with commands is a member. Set `TELEGRAM_CHAT_ID` to your own user id and everything happens in that private chat, button included. If you want the group *and* the button, set `TELEGRAM_OWNER_ID` to your user id as well and the bot answers in both; alerts still go to the group alone.

A group has one more way to reach the commands, and it needs no setup at all: post them in the chat and pin it. Telegram makes each `/command` in a message tappable, and a tap sends it.

Nothing registers these with Telegram, so the menu that appears as you type `/` is yours to set. Send `/setcommands` to [@BotFather](https://t.me/BotFather), pick the bot, and paste:

```
price - ETH price now, with 24h, 7d and 30d change
holding - open positions, one line each
summary - realized gain, annualized, closed and open
watch - send the price every 20 minutes
unwatch - stop the price updates
help - what this bot can do
```

`/watch` survives a restart and carries on from where it was rather than reporting on every boot. Commands are read by long polling, so nothing needs to be reachable from the internet; and because Telegram allows only one reader per bot, two copies of the app running against one database settle it between themselves with a lease — one polls, the other waits, and it changes hands on its own if the first stops.

## Setting up config.env

Alerts are the one part of this app that speaks to the outside world on your behalf, so they need a bot and somewhere to send to. Five minutes, once.

**Somewhere to send to is a chat id, and it does not have to be a group.** Your own user id sends everything to your private chat with the bot, which is the whole setup if you are the only one reading it - and the only arrangement that gets Telegram's Menu button, since that is drawn in private chats and nowhere else. Use a group when other people should see the alerts. Steps 2 and 3 below are the group route; for a private chat, send `/start` to the bot and use your own id from [@userinfobot](https://t.me/userinfobot) instead.

**1. Make a bot.** Message [@BotFather](https://t.me/BotFather) and send `/newbot`. It asks for a display name, then a username ending in `bot`, and answers with a token like `123456789:AAE...`. That token *is* the bot: anyone holding it can post as it, so treat it the way you would a password.

**2. Put the bot in the group.** Open the group, add a member, search for the username you just chose. A bot can post to a group without being an administrator.

**3. Find the group's chat id.** Send a message beginning with `/` in the group, then ask Telegram what it saw:

```bash
curl -s "https://api.telegram.org/bot<token>/getUpdates" | grep -o '"id":-[0-9]*'
```

It has to be a `/` message: a bot in a group gets Telegram's privacy mode by default and is shown only commands and replies to itself, so ordinary chat leaves `getUpdates` empty and looks like a failure. The id is negative, and begins `-100` for a supergroup. Privacy mode has no bearing on anything after this step.

**A group's id changes when it becomes a supergroup**, which making the bot an administrator is enough to trigger, and the old id then matches nothing. If the bot goes quiet after working, this is the first thing to check - the log prints the id of every chat it ignores, so the new one is already there.

**Do this before the app is running**, or start it with `MYAAVE_BOT_OFF=1` while you do. The app reads commands from the same queue this curl reads, and only one reader is allowed: with it running, this either answers `409 Conflict` or hands back an empty list it has already taken.

**4. Write the file**, in the directory the app runs from:

```bash
cp config.env.example config.env && chmod 600 config.env
```

| Key | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token from step 1 |
| `TELEGRAM_CHAT_ID` | the id from step 3 |
| `TELEGRAM_CHAT_NAME` | display only: shown in the alert window and at startup |
| `TELEGRAM_OWNER_ID` | optional, and only useful when the id above is a group: your own user id, so the bot answers you privately too |

**5. Restart, and read the line it prints.** The file is read once, when the process starts, so an app already running will not notice an edit. On the way up it says one of:

```
Price alerts will message Aave Loop.
Bot commands are listening in Aave Loop.
```

or, if something is missing:

```
Price alerts are not configured: TELEGRAM_CHAT_ID is missing from config.env.
Bot commands are off: TELEGRAM_CHAT_ID is missing from config.env.
```

**6. Send a test**, rather than waiting for the market to tell you whether it works:

```bash
curl -X POST http://localhost:3000/api/alerts/test
```

`{"ok":true,"error":null}` and a message in the group means it is done. Anything else comes back as a sentence rather than a stack trace: `Bad Request: chat not found` for a wrong id, `Unauthorized` for a wrong token. One test per ten seconds.

### Notes on the file

- **The format** is `KEY=value`, one per line. Blank lines and `#` comments are skipped, a leading `export ` is tolerated because these get pasted out of a shell, and one matching pair of surrounding quotes is stripped. There is no interpolation and no escapes: a bot token needs neither, and every such feature is another way to read a secret wrong.
- **Anything in it can be overridden for one run** by exporting it first, the same rule every other setting follows: `TELEGRAM_CHAT_ID=-1009876543210 npm start`.
- **On a server, where the app directory is not yours to write to**, the copy is refused. Either put the file there as root and hand it to whichever user the app runs as, or keep it somewhere you own and point the app at it, which needs no root: `MYAAVE_CONFIG=/home/you/aave-loop.env npm start`. The user that runs the service is not necessarily the one that owns the checkout - `systemctl show <unit> -p User` says which, and a `config.env` the process cannot open is reported as such at startup.
- **`config.env` is gitignored by name**, because `.env.*` does not match it. Only `config.env.example`, which holds placeholders, is committed. The app warns once at startup if the file is readable by other users on the machine, and the token appears in no log line, no error message and no API response.

## Layout

```
landing/       public marketing page, served by nginx rather than by the app
server.js      Express API and static host
db.js          SQLite connection and schema
fx.js          exchange rate lookup and cache, server only
eth.js         ETH spot price lookup and cache, server only
telegram.js    sending one message to a group, server only
alerts.js      price alerts and the timer that checks them, server only
bot.js         reads commands from Telegram and answers them, server only
report.js      builds what the bot says, server only
format.js      number and date formatting for those messages, server only
config.js      reads config.env, server only
lib/calc.js    all formulas, shared by the server and the browser
public/        interface
data/          SQLite file, not committed
```

## License

MIT. See [LICENSE.md](LICENSE.md).
