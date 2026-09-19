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

## The rate convention, pinned down first

> **`<stage>_fx` is USD per one unit of `borrow_currency`. `usd = native * fx`.
> A dollar-pegged coin is exactly 1.**

This matches what the provider returns for `EUR -> USD` (1 EUR = 1.0842 USD), so nothing
in the codebase ever inverts a rate. That sentence goes verbatim above the columns in
`db.js`, above `pegOf` in `lib/calc.js` and above `resolveRate` in `fx.js`. Direction is
where systems like this go wrong.

**EURC is not EUR.** There is no free keyless historical EURC feed, so the ECB euro rate
is a proxy, recorded honestly as `source: 'ecb'` against base `'EUR'`. That is a
modelling assumption and gets a comment saying so, not a silent approximation.

## The conversion model

With `fx_b`, `fx_buy`, `fx_sell`, `fx_r` the rates for the four stage dates:

```
borrowUsd        = borrow_amount * fx_b
costOfSoldEthUsd = costOfSoldEth * fx_buy        (= buyUsd * soldFraction)
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
inside it. Note `loanCostUsd` **can be negative** if the euro fell over the life of the
loan: that is real, not a bug.

The cost basis is marked at the **buy** date, never the sell date. Marking it at the sale
double-counts the currency move, and it is the easiest mistake to make here, so it gets a
comment.

For a USD-pegged coin every rate is 1, `principalFxUsd` is 0 and every formula collapses
to exactly what the app computes today. **Existing rows and existing figures do not
change.** That property is the regression test.

## Implementation

### 1. `db.js` - schema and migration

Add the rate columns to the `CREATE TABLE` for fresh databases, and migrate existing
ones. There is no migration system, so add a small `migrate()` that reads
`PRAGMA table_info(trades)` and issues `ALTER TABLE trades ADD COLUMN` for each column
not already present. SQLite adds a nullable column instantly, and the pass is idempotent.

```sql
borrow_fx REAL, buy_fx REAL, sell_fx REAL, repay_fx REAL   -- rate applied
borrow_fx_date TEXT, buy_fx_date TEXT,                     -- date the ECB actually
sell_fx_date TEXT, repay_fx_date TEXT,                     -- published that rate
fx_source TEXT                                             -- 'ecb' or 'peg'
```

One source column per trade, not per stage, because the rate always comes from one place.
If a manual override is ever added, per-stage `*_fx_source` is the extension point.

No data backfill. Pegged coins resolve to 1 inside `derive()`, so existing rows stay
untouched, a half-typed form object in the browser still computes, and a future dollar
stablecoin needs no migration either.

New cache table, so a rate is fetched once and the ledger reads fully offline afterwards:

```sql
CREATE TABLE IF NOT EXISTS fx_rates (
  base TEXT NOT NULL, quote TEXT NOT NULL, date TEXT NOT NULL,
  rate REAL NOT NULL, rate_date TEXT NOT NULL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (base, quote, date)
) WITHOUT ROWID;
```

Keyed on the **peg** (`EUR`), not the ticker, so a second euro coin would reuse the same
cached rates. `date` is what was asked for; `rate_date` is what the ECB actually published
on. On a Sunday they differ, which is the entire reason both exist. Writes use
`INSERT ... ON CONFLICT DO UPDATE`, since the launcher permits two servers against one
file and `busy_timeout` is already set.

Keep `FIELDS` as the user-writable columns only and export a separate `FX_COLUMNS`, so the
server writes rates through its own statements and `normalise()` never fights the resolver
over the same keys.

`resetDatabase.sh` rebuilds the schema by importing `db.js`, so it picks up both the new
columns and `fx_rates` with no change. It also drops the rate cache, which is harmless
because the cache refills. `run_myAave.sh` needs nothing.

### 2. `fx.js` (new, repository root)

Root, not `lib/` - `server.js:27` serves `lib/` to the browser, so anything there is
downloadable at `/lib/<name>`. `db.js` sits at root precisely because it is server-only;
`fx.js` belongs next to it. The invariant to state at the top of both files:
**`fx.js` imports `db.js` and `lib/calc.js`; `lib/calc.js` imports nothing, ever.**

```js
export async function resolveRate(currency, isoDate)      // -> {rate, rateDate, source} | null
export function cachedRate(currency, isoDate)             // sync, cache only, no network
export async function resolveRange(currency, from, to)    // one request for a whole span
export async function backfillRates({ refresh })          // -> {scanned, filled, stillMissing}
export function fxStatus()                                // -> {offline, cooldownUntil, lastError}
```

Resolution order in `resolveRate`:

1. **Pegged** -> `{ rate: 1, rateDate: isoDate, source: 'peg' }`. No cache, no network, so
   switching a trade from EURC back to USDC always succeeds offline.
2. **Cache hit** on `(peg, 'USD', date)` -> return it.
3. **`MYAAVE_FX_OFFLINE=1`, or inside the failure cooldown** -> `null`.
4. **Fetch** `${MYAAVE_FX_URL}/${date}?from=${peg}&to=USD` (default
   `https://api.frankfurter.app`) with `AbortSignal.timeout(2500)`. Node 18 has global
   `fetch`, so **no new dependency**. Validate that `rates.USD` is finite and within a
   sane band, and that the returned date is not *after* the date asked for. Cache, return.
5. **Failure** -> record the error, start a 60s cooldown, return `null`.

The cooldown matters: without it, saving a four-stage trade with the network unplugged
would sit through four separate timeouts. One failure puts lookups to sleep, the row saves
with empty rate columns, and the interface says so.

Expected response shape:
`{"amount":1,"base":"EUR","date":"2026-03-13","rates":{"USD":1.0842}}`. I cannot reach
the host from this sandbox to confirm it, so the first implementation step is one curl
from a machine with network. If the host or shape has moved, the ECB's own SDMX endpoint
(`data-api.ecb.europa.eu`, also keyless) is the fallback and only `resolveRate` changes.

`backfillRates` uses `resolveRange` so filling twenty missing dates is one request, not
twenty. It also re-asks for any stage whose stored `*_fx_date` differs from its stage date,
which is how a rate the ECB had not yet published at entry time gets corrected later.

### 3. `lib/calc.js` - stays pure, gains the USD layer

```js
export const CURRENCY_META = { USDC: {peg:'USD'}, ..., EURC: {peg:'EUR'} };
export const CURRENCIES = ['USDC', 'USDT', 'DAI', 'GHO', 'EURC'];
export const FX_STAGES = ['borrow', 'buy', 'sell', 'repay'];
export function pegOf(currency)        // defaults to 'USD' for anything unknown
export function isUsdPegged(currency)
```

In `derive()` (`lib/calc.js:91`), keep every existing native field exactly as it is and add
the USD twins from the formulas above: `borrowUsd`, `buyUsd`, `sellUsd`, `repayUsd`,
`costOfSoldEthUsd`, `grossGainUsd`, `interestPaidUsd`, `principalFxUsd`, `loanCostUsd`,
`netGainUsd`, `buyPriceUsd`, `sellPriceUsd`, `projectedNetGainUsd`, plus:

- `accruedInterestUsd` / `suggestedRepayUsd` - converted at the borrow rate, since an open
  loan has no repayment rate yet and these are already forecasts.
- `fxMissing` - the stages the trade has actually *reached* that have no rate. An open
  trade is not missing a sale rate; it has not sold anything.
- `fxComplete`, `isUsdPegged`, and an `fx` block carrying the rate, effective date and
  source per stage, so the UI can state what it applied.

**`isRealized` (`lib/calc.js:168`) stays exactly as it is**, gating on the native
`netGain`. A closed trade whose rate we have not fetched is still closed: only the money is
unknown. Instead add a second, narrower gate:

```js
/** Realized *and* convertible: the trade has a dollar result we can add up. */
export function hasUsdResult(d) { return isRealized(d) && d.netGainUsd !== null; }
```

Every money aggregate uses `hasUsdResult`; the counts use `isRealized`. That way
`closedCount` and `tradeCount` stay honest while no unconverted figure ever enters a total.

`summarize` (173) and `summaryReport` (239):

- `netGain`, `deployed`, `totalBorrowed`, `interestPaid` and the `byMonth` sums switch to
  the USD fields, gated on `hasUsdResult`.
- `avgPct` weights by **`borrowUsd`**, not `borrow_amount`. Otherwise 30,000 EURC and
  30,000 USDC count as the same money, which they are not.
- `best` / `worst` rank on `netGainUsd`, skipping rows where it is null. Ranking a euro
  gain against a dollar gain on native numbers is simply wrong.
- `winRate` is computed over trades with a USD result, so an unconverted trade is not
  silently scored as a loss.
- New `missingFx` count and `missingFxIds`, so the view can name the problem and link to it.
- `byCurrency` rows keep `borrowed` / `netGain` as USD and gain `borrowedNative` /
  `netGainNative`. Native totals are meaningful in a table grouped by currency; they are
  meaningless in the global tiles.

**Known limitation, stated deliberately:** an open EURC position is not marked to today's
rate. `borrowUsd` is its cost basis at the borrow date, because a pure synchronous
`derive()` cannot fetch a live rate. The unrealized currency move on capital still at work
is therefore not shown. This goes in a comment and in the README.

### 4. `server.js` - resolving rates on write

- `normalise()` (line 90) needs no change to accept EURC; it validates against
  `CURRENCIES`, which now contains it. It must **reject any `*_fx` key sent by a client** -
  rates are server-resolved, never posted. Change the error copy from
  `'Pick a supported stablecoin.'` to `'Pick a supported currency.'`
- New `staleFxColumns(current, patch)`: a rate belongs to a date. Move the purchase from
  the 12th to the 14th, or switch the loan from USDC to EURC, and the stored rate is no
  longer the rate for that transaction. Leaving it would quietly make the dollar figures
  wrong, which is worse than showing nothing. Rules: currency changed -> clear all four;
  a stage date changed -> clear that stage; a stage date cleared -> clear that stage, so no
  orphan rate is left on a stage that no longer exists.
- New `fillFxColumns(row)`: for each stage with a date and no rate, `await resolveRate`.
  A `null` stays null. **A failed lookup must never fail a save.**
- `POST /api/trades` (216) and `PATCH /api/trades/:id` (234) become `async`. The existing
  `try/catch { next(err) }` already handles an async body correctly, so no wrapper is
  needed. The POST row must be built from `[...FIELDS, ...FX_COLUMNS]` before the INSERT
  names those columns, or better-sqlite3 throws `Missing named parameter`.
- New `GET /api/fx/rate?currency=&date=`, `GET /api/fx/status`, and
  `POST /api/fx/backfill`. All three **return 200 even when offline** - "I could not reach
  the network" is a result, not a server error, and the browser's `api()` helper (app.js:116)
  throws on any non-ok status.
- `GET /api/trades` and `GET /api/summary` need no change: `withDerived` spreads the whole
  row, so the new columns reach `derive()` on their own. `checkChronology` needs no change
  either; repay >= borrow is a claim about the loan in its own currency.

### 5. Front end - `public/app.js`, `public/eurc.svg`, `public/styles.css`

- New `public/eurc.svg` matching the house format (`viewBox="0 0 32 32"`, full-bleed
  circle, white glyph, rendered at 26px). **Do not reuse Circle's USDC blue `#2775C9`** -
  at 26px the two rows would be indistinguishable. Use EU-flag navy `#003399` so the coin
  reads as "euro" instantly. The euro glyph is a stroked arc plus two bars, which is
  trivial as strokes and fiddly as a filled path. Eyeball it at 26px before committing.
  Then `COIN_ART.EURC = '/eurc.svg'` (app.js:87); the dropdown at line 306 picks EURC up
  from `CURRENCIES` on its own, and the fallback tinted circle at line 98 covers the asset
  landing late.
- New formatter beside `money()` (app.js:45) for the dual figure: the amount in EURC with
  `~ $54,210.00` under it and a muted `at 1.0842 on 13 Mar 2026`. A figure nobody can
  reproduce is worse than no figure. **Render the sub-line only when `!d.isUsdPegged`**,
  which is the guarantee that every existing trade renders byte-identically to today.
- `stageSummary()` (441): each card keeps its native amount and gains the USD sub-line.
  "ETH price" switches to `usd(d.buyPriceUsd)` / `usd(d.sellPriceUsd)`, which is a genuine
  fix: today it divides a euro amount and labels the result dollars. On the Repaid card,
  relabel `Interest` to `Loan cost` for a non-pegged coin and show the `principalFxUsd`
  split, so a negative loan cost reads as an explanation rather than a bug. Any stage in
  `d.fxMissing` shows a warning chip in place of its sub-line.
- `tradeRow()` (531): the table stays in USD so the columns remain comparable. The Trade
  cell's primary line becomes `usd(d.borrowUsd)` with the native amount on its existing
  small line for a non-USD coin. Net gain, buy/sell price and annualized read the USD
  fields, and `gainClass` reads `netGainUsd` (with a currency move, the native and USD
  signs can in principle disagree). No ticker chip needed; the coin art already says which
  currency it is.
- `renderSummary()` (721) / `renderStats()` (768): unchanged in shape, reading the USD
  aggregates. Add a note - "All figures in USD, converted at the ECB euro reference rate
  for each transaction date" - and, when `missingFx > 0`, a banner naming the count with a
  **Fetch rates** button posting to `/api/fx/backfill`, then `loadTrades()` + `render()`.
  Offline, it toasts the reason from the response body. This banner is the offline story
  made visible, and it is fully exercisable in this sandbox.
- `currencyTable()` (660): USD columns plus a native "Borrowed" column; header
  `Stablecoin` -> `Currency`.
- `refreshHints()` (356) previews client-side, where no rate exists yet for a brand new
  EURC stage. Keep the previews native and say the USD equivalent is filled in on save.
  Do not invent a rate in the browser. Optional polish, cheap and worth it: on a date
  change in a non-pegged form, debounce ~250ms and `GET /api/fx/rate` purely to show the
  rate that *will* be applied; a null answer just says the rate is not available yet.
- `styles.css`: two small rules, both reusing existing tokens.
  `.chip--warn { background: var(--warn-soft); color: var(--warn); }` beside `.chip`
  (line 684), and the FX sub-line at the size already set by `.row__stack small` (653).
  Nothing new in the palette.

### 6. Docs

- `README.md`: EURC in the coin list, a "Currencies and exchange rates" section stating
  the ECB source, the per-stage marking, the offline behaviour, the EURC-as-euro proxy and
  the unmarked-open-position limitation. Correct the "USD only" line near the top, extend
  the math table with the USD formulas, and add `fx.js` to the layout block.
- `CHANGELOG.md`: a `[0.0.6]` entry in the existing Keep a Changelog style, calling out the
  schema migration and, under Fixed, that cross-currency totals previously summed raw
  amounts as if every coin were a dollar, and that the ETH price on a non-dollar trade was
  a native figure wearing a dollar sign.
- `package.json` version bump to 0.0.6, and the `#version` fallback in `index.html:94`.

## Edge cases, decided rather than left open

| Case | Decision |
|---|---|
| Weekend or TARGET holiday | The provider returns the preceding business day and echoes the real date. Cache on the date asked for, store the returned date as `rate_date`, and the UI states it. Reject a returned date *after* the one requested. |
| Today, before the daily publication | Same mechanism. `backfillRates` re-asks later and corrects it. |
| Stage date edited after the fact | `staleFxColumns` clears that stage, `fillFxColumns` re-resolves. Offline, it saves with a null and shows the marker. |
| Currency switched USDC -> EURC | All four cleared, all four re-resolved. EURC -> USDC resolves to the peg with no network, so it always succeeds. |
| Partial sale | Cost basis marked at the buy date, scaled by `soldFraction`. Never at the sell rate. |
| Missing rate in aggregates | The trade still counts in `closedCount` and `tradeCount`; its money is withheld from every USD total; `missingFx` increments and the banner names it. Never silently 1:1. |
| Negative `loanCostUsd` | Real: the euro fell and the loan got cheaper in dollars. Shown as a split, not hidden. |
| Open EURC position | Not marked to today's rate. Documented limitation, not an oversight. |
| No rate will ever exist (provider gap) | Stays null and stays flagged. |
| Rounding | Store the rate exactly as returned, never pre-round. Round only in formatters: rate to 4 places, money to 2, ETH to 4. Rounding an intermediate would make `grossGainUsd` and `sellUsd - costOfSoldEthUsd` disagree by cents. |

## Verification

Outbound network is blocked in this sandbox (403 on CONNECT to the FX host), so the live
fetch cannot be exercised here. The design turns that from an obstacle into a fixture:
steps 1 to 4 need no browser and no network.

1. **Math regression, no network.** A throwaway node script imports `lib/calc.js` and
   asserts a USDC trade with all-null rate columns produces `netGainUsd === netGain`,
   `buyPriceUsd === buyPrice` and an unchanged `pct`. This is the "existing data keeps
   working" proof.
2. **EURC math, hand-checked**, including two invariants that catch almost any direction
   or cost-basis error: `loanCostUsd === interestPaid * fx_r + principalFxUsd`, and, when
   all four rates are equal, `netGainUsd === netGain * rate` to within 1e-9. Plus a partial
   sale with `fx_buy != fx_sell`, asserting the basis is marked at the buy rate.
3. **Missing rates.** A EURC trade with null rates: `fxMissing` names the right stages,
   `netGainUsd` is null, `netGain` is not, `closedCount` still counts it, every USD total
   excludes it, and `missingFx` is 1.
4. **Migration.** Build a temp DB with the *old* schema and a USDC row, import the new
   `db.js` against it via `MYAAVE_DB`, and assert the columns appear, `fx_rates` exists and
   the row is otherwise untouched. Run twice to prove idempotence. Never point it at
   `data/myaave.db`.
5. **API, offline.** Server with `MYAAVE_FX_OFFLINE=1` on a temp DB: a EURC POST returns
   201 with null rates and the right `fxMissing`; a date PATCH clears the stale rate; a
   switch to USDC resolves to the peg with no network; clearing a stage date leaves no
   orphan rate; `POST /api/fx/backfill` returns 200 with `{ offline: true }`, not a 500;
   `GET /api/fx/rate` returns 200 with a null rate, fast, with no hang.
6. **The cache path, also offline.** Seed `fx_rates` by SQL, restart, POST a EURC trade on
   that date, and confirm it resolves with `source: 'ecb'` and no network touched. This is
   what makes the cache table earn its keep and it is testable here today.
7. **The online path, against a local stub.** A ~20 line `node -e` HTTP server on
   127.0.0.1 returning Frankfurter-shaped JSON, with `MYAAVE_FX_URL` pointed at it. Proves
   parsing, validation, the weekend `rate_date` divergence and the cache write, and a 503
   from the stub proves the trade still saves. The online path, fully exercised offline.
8. **UI.** `./run_myAave.sh`, then one EURC trade through all four stages: the dual
   figures, the rate-and-date line, the missing-rate chip, the banner and its Fetch rates
   button, an existing USDC trade rendering identically, both themes, and 360px width.

## Out of scope

Manual rate override (the rate always comes from the ECB; per-stage `*_fx_source` is the
extension point if it is ever wanted), any coin beyond EURC, intraday or execution-price
rates, and marking open positions to the current rate.
