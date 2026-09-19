# EURC support with historical EUR/USD conversion

## Context

Aave Loop Ledger records every amount on a trade in one currency, `borrow_currency`.
All four supported coins today (USDC, USDT, DAI, GHO) are dollar stablecoins, so the
app has never needed a conversion: `public/app.js` applies `usd()` straight to the raw
stored numbers, and `summarize` / `summaryReport` in `lib/calc.js` add up
`borrow_amount`, `netGain`, `interestPaid` and `deployed` across trades as if one token
were always one dollar.

We want to loop EURC as well. EURC is a euro coin, so that implicit 1:1 assumption stops
being harmless: without a conversion layer, a 50,000 EURC borrow would land in the
totals as $50,000 and silently corrupt every figure in the Summary view and every hero
tile.

The outcome: EURC becomes a fifth borrowable coin, each stage keeps its amount in EURC
as entered, and alongside it the app stores the USD equivalent converted at the ECB euro
reference rate published for that stage's own transaction date. The ledger keeps reading
natively per trade; every summary and statistic reads in USD.

**Decisions taken** (confirmed with the user):

1. Rate source is the **ECB daily euro reference rate**, fetched from the free
   Frankfurter API (no key, no signup) and cached in SQLite. EURC is treated as one euro.
2. **Each stage converts at its own date's rate.** Borrow, buy, sell and repay are four
   separate marks, so euro movement over the life of the loan lands in the USD result,
   because it genuinely happened.
3. When a rate cannot be fetched, **the trade saves anyway**, its USD value is marked
   pending, and a refresh action backfills it later. A row with no rate is never counted
   as 1:1 and never quietly folded into a total.

## The conversion model

For a trade in a non-USD coin, with `fx_b`, `fx_buy`, `fx_sell`, `fx_r` the rates for the
four stage dates:

```
borrowUsd        = borrow_amount * fx_b
costOfSoldEthUsd = costOfSoldEth * fx_buy       (basis already scaled to the ETH sold)
sellUsd          = sell_amount   * fx_sell
repayUsd         = repay_amount  * fx_r

grossGainUsd     = sellUsd - costOfSoldEthUsd
interestPaidUsd  = interestPaid * fx_r           (the interest itself, at repayment)
principalFxUsd   = borrow_amount * (fx_r - fx_b) (what the euro did to the principal)
loanCostUsd      = repayUsd - borrowUsd          (= interestPaidUsd + principalFxUsd)

netGainUsd       = grossGainUsd - loanCostUsd
pct              = annualizedPct(netGainUsd, borrowUsd, days)
buyPriceUsd      = (buy_amount  / buy_eth)  * fx_buy
sellPriceUsd     = (sell_amount / sell_eth) * fx_sell
```

`netGainUsd` is exactly the sum of the four cash flows marked at their own dates, so it
is the real dollar result of the loop. Splitting the loan cost into interest and the
euro's own move keeps the "Interest paid" figure honest instead of burying FX drift
inside it.

For a USD-pegged coin every rate is 1, `principalFxUsd` is 0 and every formula collapses
to exactly what the app computes today. **Existing rows and existing figures do not
change.** That property is the regression test.

## Implementation

### 1. `db.js` - schema and migration

Add the rate columns to the `CREATE TABLE` for fresh databases, and migrate existing
ones. There is no migration system, so add a small `migrate()` that reads
`PRAGMA table_info(trades)` and issues `ALTER TABLE trades ADD COLUMN` for each column
not already present. SQLite adds a nullable column instantly, and the operation is
idempotent.

```sql
borrow_fx REAL, buy_fx REAL, sell_fx REAL, repay_fx REAL   -- rate applied
borrow_fx_date TEXT, buy_fx_date TEXT,                     -- date the ECB actually
sell_fx_date TEXT, repay_fx_date TEXT,                     -- published that rate
fx_source TEXT                                             -- e.g. 'ECB'
```

No data backfill. USD-pegged coins resolve to 1 at derive time (see `calc.js` below), so
existing rows stay untouched and a future USD stablecoin needs no migration either.

New cache table, so a rate is fetched once and the ledger reads fully offline afterwards:

```sql
CREATE TABLE IF NOT EXISTS fx_rates (
  as_of TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
  rate REAL NOT NULL, rate_date TEXT NOT NULL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (as_of, base, quote)
);
```

Keep `FIELDS` as the user-writable columns only; export a separate `FX_FIELDS` so the
server writes rates through its own statements rather than accepting them from a request
body.

`resetDatabase.sh` rebuilds the schema by importing `db.js`, so it picks both the new
columns and `fx_rates` up with no change. `run_myAave.sh` needs nothing.

### 2. `fx.js` (new, repository root)

Root, not `lib/` - `server.js:27` serves `lib/` to the browser, and `lib/calc.js` must
stay pure, synchronous and dependency free. This module imports `db.js` and does I/O, so
it is server-only.

```js
export const FX_BASE = { EURC: 'EUR' };            // coin -> fiat base
export async function resolveRate(isoDate, base)   // -> { rate, rateDate, source } | null
export async function ratesForRow(row, previous)   // -> patch of the fx_* columns
export async function backfillRates()              // -> { updated, stillMissing }
```

- `resolveRate` returns `{ rate: 1, rateDate: iso, source: 'USD' }` for a pegged coin,
  otherwise reads `fx_rates`, and only on a miss calls
  `GET {MYAAVE_FX_URL}/{date}?base=EUR&symbols=USD` (default
  `https://api.frankfurter.dev/v1`) with `AbortSignal.timeout(5000)`. Node 18 has global
  `fetch`, so **no new dependency**.
- The expected response is
  `{"amount":1,"base":"EUR","date":"2026-03-13","rates":{"USD":1.0842}}`. I cannot reach
  the host from this sandbox to confirm it, so the first implementation step is one curl
  against it from a machine with network; if the shape or the host has moved, the ECB's
  own SDMX endpoint (`data-api.ecb.europa.eu`, also key free) is the fallback and only
  `resolveRate` changes. The base URL stays configurable through `MYAAVE_FX_URL`.
- The response carries the date the ECB really published (`{"date":"2026-03-13",...}`).
  Store it as `rate_date`. When it differs from the date asked for - a weekend, a TARGET
  holiday, or a trade entered before the daily publication - the substitution is recorded
  rather than hidden, and the UI states it.
- Cache writes happen for exact hits. A substituted rate is used and cached too, but
  `backfillRates` re-asks the API for any stage whose `*_fx_date` differs from its stage
  date, so a rate the ECB had not yet published gets corrected on the next refresh.
- Every network path is wrapped: a failure returns `null` and is never allowed to fail
  the request that triggered it.

### 3. `lib/calc.js` - stays pure, gains the USD layer

```js
export const CURRENCIES = ['USDC', 'USDT', 'DAI', 'GHO', 'EURC'];
export const USD_PEGGED = new Set(['USDC', 'USDT', 'DAI', 'GHO']);
export function isUsdPegged(currency)
export function tradeRates(t)   // { borrow, buy, sell, repay }, 1 when pegged, else the
                                // stored column or null
```

In `derive()` (`lib/calc.js:91`), keep every existing native field exactly as it is and
add the USD twins from the formulas above: `borrowUsd`, `buyUsd`, `sellUsd`, `repayUsd`,
`costOfSoldEthUsd`, `grossGainUsd`, `interestPaidUsd`, `principalFxUsd`, `loanCostUsd`,
`netGainUsd`, `buyPriceUsd`, `sellPriceUsd`, `projectedNetGainUsd`, plus:

- `accruedInterestUsd` / `suggestedRepayUsd` - an open loan has no repayment rate yet, so
  convert at the most recent rate the trade does have (`repay ?? sell ?? buy ?? borrow`)
  and treat them as the estimates they already are.
- `fxComplete` (boolean) and `missingFx` (array of stage keys with a filled stage but no
  rate), which is what the UI flags and the aggregates exclude.

`isRealized(d)` (`lib/calc.js:168`) becomes `status === CLOSED && d.netGainUsd !== null`.
For pegged coins `netGainUsd === netGain`, so nothing reclassifies; for a EURC trade
missing a rate it is the gate that keeps an unconverted figure out of the totals.

`summarize` (173) and `summaryReport` (239) switch every aggregate to the USD fields:
`netGain`, `deployed`, `totalBorrowed`, `interestPaid`, `best`/`worst`, the `byMonth`
sums, and the `avgPct` weights (weight by `borrowUsd`). Additions:

- `usdIncomplete` - count of trades with a filled stage and no rate, so the view can say
  so out loud.
- `byCurrency` rows keep `borrowed` as the USD total and gain `borrowedNative`, so the
  "By stablecoin" table can show both.

### 4. `server.js` - resolving rates on write

- `normalise()` (line 90) needs no change to accept EURC; it validates against
  `CURRENCIES`, which now contains it. Reject any `*_fx` key sent by a client.
- `POST /api/trades` (216) and `PATCH /api/trades/:id` (234) become `async`. After
  `checkChronology`, call `ratesForRow(merged, current)` and merge the returned fx columns
  into the same INSERT/UPDATE. Rules: resolve a stage's rate when that stage's date is
  present and its rate is missing **or its date changed**; clear a stage's rate when the
  date is cleared; clear all four when the currency changes to a pegged coin; resolve all
  four when it changes to EURC.
- New `POST /api/fx/refresh` -> `backfillRates()`, returning `{ updated, stillMissing }`.
  This is the "save now, backfill later" path.
- Errors from the FX layer never reach the client as a failure; the trade saves and the
  response simply carries nulls.

### 5. Front end - `public/app.js`, `public/eurc.svg`, `public/styles.css`

- New `public/eurc.svg`, a circular mark in the style of `usdc.svg` (Circle blue
  `#2775C9`, `viewBox="0 0 32 32"`, white euro glyph drawn as paths, not `<text>`), and
  `COIN_ART.EURC = '/eurc.svg'` at `app.js:87`. The dropdown at `app.js:306` picks EURC up
  from `CURRENCIES` on its own.
- New formatter next to `money()` (app.js:45) for the dual figure, e.g.
  `withUsd(native, usdValue, currency, rate, rateDate)`, rendering the amount in EURC with
  `~ $54,210.00` under it and a muted `ECB 1.0842 - 13 Mar 2026`. For a pegged coin it
  falls back to today's single line, so those cards do not change at all.
- `stageSummary()` (441): each card keeps its native amount and gains the USD line.
  "ETH price" switches to `usd(d.buyPriceUsd)` / `usd(d.sellPriceUsd)`, which is a genuine
  fix - today it divides a euro amount and calls the result dollars.
- `tradeRow()` (531): the table stays in USD so the columns remain comparable. The Trade
  cell's primary line becomes `usd(d.borrowUsd)` and its small line carries the native
  amount for a non-USD coin (`50,000.00 EURC - 13 Mar 2026`). Net gain, buy/sell price and
  annualized all read the USD fields. A row missing a rate shows a warning chip.
- `renderSummary()` (721) / `renderStats()` (768): unchanged in shape, reading the USD
  aggregates. Add a note on the Summary card - "All figures in USD, converted at the ECB
  euro reference rate for each transaction date" - and, when `usdIncomplete > 0`, a banner
  naming the count with a **Refresh rates** button posting to `/api/fx/refresh`.
- `currencyTable()` (660): "Borrowed" reads USD with the native total beneath it for EURC.
- `refreshHints()` (356) previews client-side, where no rate exists yet for a brand new
  EURC stage. Keep the previews native (they already use `unitOf`) and note that the USD
  equivalent is filled in on save; do not invent a rate in the browser.
- `styles.css`: two small rules. The warning chip reuses the existing tokens -
  `.chip--warn { background: var(--warn-soft); color: var(--warn); }` beside `.chip`
  (line 684) - and the FX sub-line reuses `var(--text-muted)` at the size already set by
  `.row__stack small` (653). Nothing new in the palette.

### 6. Docs

- `README.md`: EURC in the coin list, a short "Currency conversion" section stating the
  ECB source, the per-stage marking, the offline behaviour, and that EURC is valued as one
  euro. Correct the "USD only" line near the top and extend the math table with the USD
  formulas.
- `CHANGELOG.md`: a `[0.0.6]` entry in the existing Keep a Changelog style, calling out the
  schema migration and, under Fixed, that cross-currency totals previously summed raw
  amounts as if every coin were a dollar.
- `package.json` version bump to 0.0.6, and the `#version` fallback in `index.html:94`.

## Verification

Outbound network is blocked in this sandbox (403 on CONNECT to the FX host), so the live
fetch cannot be exercised here. The design makes that testable anyway:

1. **Math regression, no network.** A throwaway node script under the scratchpad imports
   `lib/calc.js` and asserts that a set of USDC/USDT trades produce byte-identical
   `derive`, `summarize` and `summaryReport` output before and after the change. This is
   the guard on existing data.
2. **EURC math, hand-checked.** The same script derives a EURC trade with rates pinned in
   the row (borrow 50,000 @ 1.0842, buy @ 1.0842, sell @ 1.1010, repay @ 1.0975) and
   checks `netGainUsd` against the figure computed by hand, including the case where
   `principalFxUsd` is non-zero and the partial-sale case where `soldFraction < 1`.
3. **Missing rates.** Assert a EURC trade with null rates is excluded from every total,
   counted in `usdIncomplete`, and that its native card figures still render.
4. **API, against a local stub.** Point `MYAAVE_FX_URL` at a ~20 line local HTTP stub
   serving Frankfurter-shaped JSON (including a weekend date answering with the previous
   Friday) and run the server on a temp DB via `MYAAVE_DB`. `curl` a EURC POST, then the
   stage PATCHes, and confirm the stored fx columns, the substituted `rate_date`, and that
   a stub returning 503 still saves the trade with nulls and that `POST /api/fx/refresh`
   fills them once the stub recovers.
5. **Migration.** Run the new `db.js` against a copy of a pre-change database and confirm
   the columns appear, the rows are intact, and the app renders identical figures.
6. **UI.** `./run_myAave.sh`, then walk one EURC trade through all four stages and check
   the dual figures, the Summary banner, the refresh button and the coin art in both
   themes.

## Out of scope

Manual rate override (the rate always comes from the ECB; the `fx_source` column leaves
room to add one later), any coin beyond EURC, and intraday or execution-price rates.
