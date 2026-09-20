# Prompts

Reusable audit prompts for this repository, kept in a form a terminal `claude`
session can swallow whole. Run them in a **fresh session**, so the auditor comes at
the code cold rather than inheriting the assumptions of whoever wrote it.

Each prompt is wrapped in `<!-- prompt:NAME -->` markers. They are invisible when the
file renders, and they let a one-liner lift a prompt out without you selecting 170
lines by hand:

```bash
prompt() { awk -v n="$1" '$0=="<!-- prompt:"n" -->"{f=1;next} $0=="<!-- /prompt -->"{f=0} f' PROMPTS.md; }
```

Drop that in your shell and `prompt bug-hunt-and-fix` prints one. The commands below
inline the same awk, so they work without it.

## Running them

**Audit only** — reports, changes nothing:

```bash
cd ~/Projects/myAave && claude --effort max "$(awk '$0=="<!-- prompt:bug-hunt -->"{f=1;next} $0=="<!-- /prompt -->"{f=0} f' PROMPTS.md)"
```

**Audit and fix** — edits `lib/calc.js` and `public/app.js` as it goes:

```bash
cd ~/Projects/myAave && git switch -c bug-hunt && claude --effort max --permission-mode acceptEdits "$(awk '$0=="<!-- prompt:bug-hunt-and-fix -->"{f=1;next} $0=="<!-- /prompt -->"{f=0} f' PROMPTS.md)"
```

`--effort max` is the top of the five levels (low, medium, high, xhigh, max).
`--permission-mode acceptEdits` matters only for the fixing run: it touches the same
two files twenty times, and approving each edit turns an autonomous job into an hour
of clicking. Bash still prompts, and `git diff` is the real review gate — which is
why the branch comes first. Add `ultracode` to the front of a prompt to fan it out
across parallel agents; if you do, tell it to fan out for **finding** only and apply
the fixes in one serial pass, or agents will collide on those two files.

Do not use `-p` / `--print`. These are long multi-step jobs you want to watch.

**Say this too, whenever the ledger is running.** The prompts ask the agent to verify
against a temp database, and your own instance already holds port 3000:

> Port 3000 is taken by my own running instance. Verify with
> `PORT=3011 MYAAVE_DB=/tmp/audit.db npm start`, and never touch `data/myaave.db`.

## Bug hunt

Wide and read-only: money, database, security, interface, edge cases. Use it when you
want to know what is wrong before deciding what to do about it.

<!-- prompt:bug-hunt -->
Audit Aave Loop for real, demonstrable bugs. Report up to **20**, ranked
most severe first. **Finding five genuine bugs is a better result than twenty padded
ones. Do not invent findings to reach a number, and say so plainly if an area is
clean.**

### The codebase

A local-first personal ledger for Aave loop trades: borrow a stablecoin, buy ETH,
sell it, repay. Express + better-sqlite3 + vanilla ES modules. No framework, no build
step, no test suite, no linter.

```
server.js       Express API, validation, static host, Host allow-list
db.js           SQLite connection, schema, migrations, statement cache
fx.js           EUR/USD rate lookup and cache. The only module that does I/O
lib/calc.js     every formula. Pure and synchronous. Imported by the server AND
                served raw to the browser, so both run identical code
public/app.js   the whole front end, rendered with template literals + innerHTML
landing/        the public marketing page and 404, served by nginx, not by the app
```

A trade has four stages (borrow, buy ETH, sell ETH, repay), each with a date and
amounts. Every amount is denominated in `borrow_currency`. USDC, USDT, DAI and GHO
are dollar coins; EURC is a euro coin converted to USD at the ECB reference rate
published for each stage's own date, stored per stage on the row. All summaries and
statistics are reported in USD. In production nginx serves a public landing page at
`/` and keeps the ledger at `/app` behind basic auth.

### Cover all five areas. Do not stop after the easy ones.

**1. The money. This is the one that matters most.**

Check every formula in `lib/calc.js` against what its comment claims and what
`README.md` documents. Work out the algebra yourself rather than trusting either.

- Partial sales and the cost basis: is the basis scaled to the ETH actually sold, and
  marked at the purchase date rather than the sale date?
- The annualized return over short, zero-day and backwards spans.
- Simple interest, and the difference between accrued and actually paid.
- Gross gain vs net gain vs loan cost, and whether they reconcile in both currencies.
- **The per-stage currency conversion.** Each of the four stages converts at its own
  date's rate. Prove no currency movement is double counted, and none is dropped.
  Specifically: `loanCostUsd` should equal `interestPaidUsd + principalFxUsd`, and
  with a single flat rate applied to every stage, `netGainUsd` must equal
  `netGain * rate` exactly.
- Weighted averages: what is the weight, is it the right one, and does the **label**
  in the UI describe the statistic actually being computed? A figure that is correct
  but mislabelled is a bug.
- Aggregates: does every figure in one card describe the same population of trades?
  Mixing "all closed" with "closed and convertible" makes two correct numbers look
  inconsistent.
- `null` vs `0`: anywhere a null is coerced to zero and lands in a total, stating a
  figure nobody measured.
- Floating point accumulation across many trades, and rounding applied to an
  intermediate rather than at the point of display.
- Sort order, tie-breaking, and ranking by a different quantity from the one shown.
- Date arithmetic across DST, leap years and month ends, given dates are parsed as
  calendar days.

**2. The database.**

The migration path on a fresh database, an old pre-FX one, and a partially migrated
one. Whether the prepared-statement cache can grow without bound from
attacker-influenced SQL shapes. Whether any SQL is built by string interpolation from
anything that is not a fixed whitelist, and prove whether the whitelist actually
holds. Transaction boundaries and partial writes on a failed multi-row update.
Concurrent access, since the launcher explicitly permits two servers on one file. WAL
and checkpoint handling on shutdown. Whether a failed rate lookup can leave a row
internally inconsistent: a rate with no date, or a rate attached to a stage that has
since been cleared.

**3. Security.**

The front end builds HTML with template literals and `innerHTML`. Find **every**
interpolation that does not pass through `esc()` and determine whether the value can
carry user-controlled text. Note that `fmtDate` escapes its own output, so double
escaping is also a defect. The notes field accepts 2000 arbitrary characters.

Check SQL injection through column names, values and any ORDER BY. Prototype
pollution through request bodies spread into objects (`__proto__`, `constructor`).
SSRF and injection through `MYAAVE_FX_URL` and anything interpolated into a fetch
URL. Whether the API trusts any field it should compute itself, exchange rates above
all. The `Host` allow-list and `MYAAVE_ALLOWED_HOSTS`: can it be bypassed, and does
it still block DNS rebinding. The shell scripts for word splitting and unquoted
expansions.

State for each finding whether it is exploitable given that the app binds loopback
and sits behind basic auth in production, or only if that changes. **Do not pad the
list with "no authentication" or "no HTTPS" as findings in themselves.**

**4. The interface.**

Validation that disagrees between client and server, in either direction. Numeric
parsing of pasted input: thousands separators, currency symbols, European decimal
commas, leading `+`, exponent notation, values that lose precision. State handling
across re-renders, in-flight requests and view switches, including whether a slow
response can overwrite newer state, and whether a half-typed form can be silently
discarded. Event delegation, and whether any handler can fire twice or leak. Any
field that renders a value in one currency under the symbol of another. Anything
showing a stale, wrong or `0` figure where the honest answer is "unknown". Layout
that clips or overflows: check `scrollWidth` against `clientWidth` rather than
judging by eye, at 1440px and 390px, in both themes.

**5. Errors and edge cases.**

Unhandled promise rejections, an async route that can hang, a thrown error that
escapes a handler and takes the process down, the network failing mid-request,
malformed JSON, missing fields, absurd values, a database that is read-only or full.

### Rules

- **Verify before reporting.** Read the surrounding code. Where you can, prove it:
  write a throwaway script, or run the server on a temp database via `MYAAVE_DB` and
  drive it with curl. Say explicitly which findings you executed and which you only
  reasoned about.
- Every finding gives: `file:line`, severity, what breaks, a concrete trigger (exact
  input, exact sequence), the impact, and a fix in one or two sentences.
- **Distinguish a defect from a deliberate decision.** Several apparent oddities here
  are intentional and documented in comments or `CHANGELOG.md`: an open position is
  not marked to the current exchange rate; a loan cost can be negative when the euro
  falls; the headline annualized figure is a blended return on capital over time, not
  the mean of the per-trade rates. If a comment explains the behaviour, either accept
  it or explain why it is wrong anyway.
- No style, naming, formatting or "add tests" findings. Behaviour and security only.
- If an area is clean, say so rather than inventing something to fill it.

Report the findings only. Do not change any code unless I ask.
<!-- /prompt -->

## Bug hunt and fix

Narrower and hands-on: FX, APY, dates, field validation, UI and math, with no
database or security. It applies the fixes as it goes.

<!-- prompt:bug-hunt-and-fix -->
Find and fix real, demonstrable bugs in Aave Loop. Report and fix up to
**20**, ranked most severe first. **Six genuine bugs is a better result than twenty
padded ones. Do not invent findings to reach a number. If an area is clean, say so
plainly and move on.**

### The codebase

A local-first personal ledger for Aave loop trades: borrow a stablecoin, buy ETH,
sell it, repay. Express + better-sqlite3 + vanilla ES modules. No framework, no
build step, no test suite, no linter.

```
lib/calc.js     every formula. Pure, synchronous, dependency-free. Imported by the
                server AND served raw to the browser, so both run identical code
fx.js           EUR/USD rate lookup, validation and cache. The only module doing I/O
server.js       Express API, request validation, static host
db.js           SQLite connection, schema, migrations
public/app.js   the whole front end: template literals + innerHTML, no framework
```

A trade has four stages (borrow, buy ETH, sell ETH, repay), each with its own date
and amounts. Every amount is denominated in `borrow_currency`. USDC, USDT, DAI and
GHO are dollar coins; EURC is a euro coin converted to USD at the ECB reference rate
published for **each stage's own date**, stored per stage on the row. All summaries
and statistics are reported in USD.

### The six areas. Cover all of them; do not stop after the easy ones.

**1. FX and currency conversion.**

Four stages, four independent rates, one row. Prove no currency movement is double
counted and none is silently dropped.

- `derive()` in `lib/calc.js`: check `borrowUsd`, `buyUsd`, `sellUsd`, `repayUsd`,
  `costOfSoldEthUsd`, `grossGainUsd`, `interestPaidUsd`, `principalFxUsd`,
  `loanCostUsd`, `netGainUsd` and `projectedNetGainUsd` each convert at the rate
  belonging to the stage that actually produced the number — not the borrow rate as
  a convenient default, and not the sale rate for a basis established at purchase.
- Two invariants that must hold exactly. Test them: `loanCostUsd` must equal
  `interestPaidUsd + principalFxUsd`; and with a single flat rate applied to all
  four stages, `netGainUsd` must equal `netGain * rate` to floating-point tolerance.
  If either fails, the FX is being applied at the wrong layer.
- `buyPriceUsd` and `sellPriceUsd`: a per-ETH price converted at the wrong stage's
  rate is still a plausible-looking number.
- A partially-rated row: some stages have a rate, some do not. Does a missing rate
  produce `null` all the way up, or does it coerce to 0 and land in a total?
  `fxMissing` / `fxComplete` must actually gate every USD figure they claim to.
- `isProvisionalFx()` and `FX_PROVISIONAL_DAYS`: weekends, ECB holidays, and a stage
  date in the future. Is a rate published *before* the stage date treated the same
  as one published after?
- `fx.js`: `validate()`, `cachedRate()`, `resolveRange()`, `staleFxColumns()` and
  `fillFxColumns()`. A cache hit keyed on the wrong date, a rate reused across
  currencies, a stale rate surviving a stage-date edit, a failed lookup leaving a
  rate attached to a stage that has since been cleared.
- Anywhere a rate might be inverted. The convention is `usd = native * fx`, a
  dollar coin is exactly 1, and nothing anywhere inverts a rate. Verify that.
- Aggregates in `summarize()` and `summaryReport()`: does every figure inside one
  card describe the same population of trades? Mixing "all closed" with "closed and
  FX-convertible" makes two correct numbers look inconsistent.

**2. APY / annualized return.**

- `annualizedPct(netGain, loan, days)`: work the algebra yourself. Check a zero-day
  trade (span clamps to 1), a backwards span, `loan === 0`, a negative net gain, and
  a multi-year hold. Confirm the clamp is documented behaviour and not masking a
  date bug upstream.
- `accruedInterest()`: simple interest on a 365-day year. Check leap years, and the
  gap between interest *accrued* and interest *actually paid* — confirm the two are
  never substituted for one another.
- Weighted averages anywhere in `summarize()` / `summaryReport()`: what is the
  weight, is it the right one, and does the **label rendered in the UI** describe
  the statistic actually being computed? A figure that is arithmetically correct
  and mislabelled is a bug, and is the exact class of bug found here before.
- `pct` vs `pctNative`: confirm each is shown under the currency it was computed in.

**3. Date calculations.**

- `parseDate()`, `todayISO()`, `daysBetween()`. Dates are calendar days, not
  instants. Check DST boundaries, month ends, leap days, year boundaries, and
  whether any path lets a local-timezone `Date` shift a day.
- Stage dates out of order: repay before borrow, sell before buy, a future date.
  Does each produce `null`, or a confident wrong number?
- `suggestedRepay` / `suggestedRepayOn()`: the day count driving it, and whether
  the interest window is inclusive or exclusive at both ends — consistently.
- `monthOf()` and the month grouping in the summary: which timezone decides the
  bucket, and what happens to the first and last day of a month.

**4. Field validation and form errors.**

- `sanitizeNumeric()` and `parseAmount()` / `normaliseAmountText()`: thousands
  separators, a European decimal comma, a currency symbol, leading `+`, exponent
  notation, whitespace, an empty string, and values that lose precision. Check the
  pasted path separately from the typed path.
- `validateField()` and `validateForm()` against what `server.js` actually enforces.
  Disagreement in **either** direction is a bug: a value the client accepts and the
  server rejects, and a value the client blocks that is genuinely valid.
- `showFormError()` / `clearFieldError()`: an error that survives a successful
  resubmit, an error attached to the wrong field, or focus stolen on re-render.
- `payloadOf()`: does the request body carry any field the server should compute
  itself — exchange rates above all?
- Bounds: zero, negative, absurdly large, and more decimal places than the column
  stores.

**5. Overall UI.**

- `captureDraft()` / `restoreDraft()`: can a half-typed form be silently discarded
  by a re-render, a view switch, or an in-flight response landing late?
- `api()` and `loadTrades()`: can a slow response overwrite newer state? Is there
  any request sequencing at all?
- `sortedTrades()`, `applySort()`, `pager()`, `pageOfTrade()`, `clampPage()`: tie
  breaking, a null sort key, ranking by a different quantity from the one displayed,
  and the current page surviving a sort change or a row deletion.
- `esc()` and `innerHTML`: find every interpolation that does not pass through
  `esc()` and determine whether the value can carry user-controlled text. Note that
  `fmtDate()` escapes its own output, so double-escaping is also a defect.
- Any field rendering a value in one currency under the symbol of another —
  `money()` vs `usd()` vs `signedUsd()` vs `fxNote()`.
- Anything showing a stale, wrong or `0` figure where the honest answer is
  "unknown".
- Layout that clips or overflows: measure `scrollWidth` against `clientWidth` rather
  than judging by eye, at 1440px and 390px, in both light and dark themes.
- Event delegation in `wire()`: any handler that can fire twice, leak, or bind to a
  node replaced by the next render.

**6. Overall math.**

- Partial sales: is the cost basis scaled to the ETH actually sold, and marked at
  the purchase date rather than the sale date? Check `costOfSoldEth`, `retainedEth`
  and `isPartialSale`.
- Gross gain vs net gain vs loan cost — do they reconcile, in both currencies?
- `null` vs `0`: anywhere a null is coerced to zero and lands in a total, stating a
  figure nobody measured.
- Floating-point accumulation across many trades, and rounding applied to an
  intermediate value rather than at the point of display.

### Verify before you fix

- Prove each finding. Write a throwaway script that imports `lib/calc.js` directly,
  or run the server against a temp database via `MYAAVE_DB` and drive it with curl.
  For UI findings, drive the running app in a browser.
- **Say explicitly which findings you executed and which you only reasoned about.**
- **Distinguish a defect from a deliberate decision.** Several apparent oddities are
  intentional and documented in code comments or `CHANGELOG.md`: an open position is
  not marked to the current exchange rate; a loan cost can be negative when the euro
  falls; the headline annualized figure is a blended return on capital over time,
  not the mean of the per-trade rates. If a comment explains the behaviour, either
  accept it or explain why it is wrong anyway.
- No style, naming, formatting or "add tests" findings. Behaviour only.

### Fixing

- Fix in place, smallest change that actually corrects the behaviour. Do not
  refactor, rename, or restructure anything you are not fixing.
- `lib/calc.js` is served raw to the browser and imported by Node: it must stay
  dependency-free, side-effect-free, and free of any Node-only syntax.
- A fix that changes a displayed figure must also fix its **label** if the label was
  describing the old behaviour.
- After each fix, re-run the check that proved the bug, and confirm you have not
  broken the two FX invariants above.
- Add a `CHANGELOG.md` entry grouping the fixes. Do not commit or bump the version
  unless I ask.

### Report

For each finding: `file:line`, severity, what breaks, a concrete trigger (exact
input, exact sequence), the impact, the fix you applied, and how you verified it.
End with a one-line list of areas you found clean.
<!-- /prompt -->

## Notes

Narrow either prompt by deleting the areas you do not want; they are independent.
Drop the last line of **Bug hunt** to get fixes from it too.

The highest-value variant is the money section alone, run against a specific figure
you distrust, phrased as: *"Reproduce this number from the raw trade data by hand,
then tell me whether the code computes the same thing its label claims."* That is how
the mislabelled annualized figure was found: the arithmetic was correct and the word
"Average" was not.
