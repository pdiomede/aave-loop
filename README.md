# Aave Loop Ledger

Track leveraged trade cycles on Aave: borrow a stablecoin, buy ETH, sell it, repay the loan, and see what the round trip actually earned.

Local web app, SQLite storage, no account and no wallet connection. USD only, shown to two decimals with ETH to four.

## Run

```bash
./run_myAave.sh
```

Opens on http://localhost:3000, bound to loopback only. The script checks Node, installs dependencies if needed, and moves to the next free port when 3000 is taken (`--kill` reclaims it instead, `--port N` picks another).

Requires Node 18 or newer.

## How a trade works

A trade is created with the borrow alone, then each stage is added as it happens.

| Stage | You enter | Status becomes |
| --- | --- | --- |
| Borrow | date, amount, stablecoin, APR | `OPEN` |
| Buy ETH | date, amount spent, ETH received | `HOLDING` |
| Sell ETH | date, ETH sold, amount received | `SOLD` |
| Repay | date, amount repaid | `CLOSED` |

## Views

**Trades** is the history table. Expand any row to see its four stages and edit them.

**Summary** reports performance by stablecoin, net gain by month closed, best and worst trade, interest paid, win rate, total borrowed and average hold. Only closed trades count towards realized figures.

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
| Annualized return | `net_gain / borrow_amount * 365 / days` |

Gross gain uses the cost basis of the ETH actually sold, so a partial exit is not reported as a loss.

The percentage is annualized, so a 3 day trade netting 7% shows as roughly 877%.

## Layout

```
server.js      Express API and static host
db.js          SQLite connection and schema
lib/calc.js    all formulas, shared by the server and the browser
public/        interface
data/          SQLite file, not committed
```

## License

MIT. See [LICENSE.md](LICENSE.md).
