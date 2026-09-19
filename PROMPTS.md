# Prompts

Reusable prompts for working on this repository. Run them in a **fresh session**, so
the auditor comes at the code cold rather than inheriting the assumptions of whoever
wrote it.

---

## Bug hunt

> Audit the Aave Loop Ledger for real, demonstrable bugs. Report up to **20**, ranked
> most severe first. **Finding five genuine bugs is a better result than twenty padded
> ones. Do not invent findings to reach a number, and say so plainly if an area is
> clean.**
>
> ### The codebase
>
> A local-first personal ledger for Aave loop trades: borrow a stablecoin, buy ETH,
> sell it, repay. Express + better-sqlite3 + vanilla ES modules. No framework, no build
> step, no test suite, no linter.
>
> ```
> server.js       Express API, validation, static host, Host allow-list
> db.js           SQLite connection, schema, migrations, statement cache
> fx.js           EUR/USD rate lookup and cache. The only module that does I/O
> lib/calc.js     every formula. Pure and synchronous. Imported by the server AND
>                 served raw to the browser, so both run identical code
> public/app.js   the whole front end, rendered with template literals + innerHTML
> landing/        the public marketing page and 404, served by nginx, not by the app
> ```
>
> A trade has four stages (borrow, buy ETH, sell ETH, repay), each with a date and
> amounts. Every amount is denominated in `borrow_currency`. USDC, USDT, DAI and GHO
> are dollar coins; EURC is a euro coin converted to USD at the ECB reference rate
> published for each stage's own date, stored per stage on the row. All summaries and
> statistics are reported in USD. In production nginx serves a public landing page at
> `/` and keeps the ledger at `/app` behind basic auth.
>
> ### Cover all five areas. Do not stop after the easy ones.
>
> **1. The money. This is the one that matters most.**
>
> Check every formula in `lib/calc.js` against what its comment claims and what
> `README.md` documents. Work out the algebra yourself rather than trusting either.
>
> - Partial sales and the cost basis: is the basis scaled to the ETH actually sold, and
>   marked at the purchase date rather than the sale date?
> - The annualized return over short, zero-day and backwards spans.
> - Simple interest, and the difference between accrued and actually paid.
> - Gross gain vs net gain vs loan cost, and whether they reconcile in both currencies.
> - **The per-stage currency conversion.** Each of the four stages converts at its own
>   date's rate. Prove no currency movement is double counted, and none is dropped.
>   Specifically: `loanCostUsd` should equal `interestPaidUsd + principalFxUsd`, and
>   with a single flat rate applied to every stage, `netGainUsd` must equal
>   `netGain * rate` exactly.
> - Weighted averages: what is the weight, is it the right one, and does the **label**
>   in the UI describe the statistic actually being computed? A figure that is correct
>   but mislabelled is a bug.
> - Aggregates: does every figure in one card describe the same population of trades?
>   Mixing "all closed" with "closed and convertible" makes two correct numbers look
>   inconsistent.
> - `null` vs `0`: anywhere a null is coerced to zero and lands in a total, stating a
>   figure nobody measured.
> - Floating point accumulation across many trades, and rounding applied to an
>   intermediate rather than at the point of display.
> - Sort order, tie-breaking, and ranking by a different quantity from the one shown.
> - Date arithmetic across DST, leap years and month ends, given dates are parsed as
>   calendar days.
>
> **2. The database.**
>
> The migration path on a fresh database, an old pre-FX one, and a partially migrated
> one. Whether the prepared-statement cache can grow without bound from
> attacker-influenced SQL shapes. Whether any SQL is built by string interpolation from
> anything that is not a fixed whitelist, and prove whether the whitelist actually
> holds. Transaction boundaries and partial writes on a failed multi-row update.
> Concurrent access, since the launcher explicitly permits two servers on one file. WAL
> and checkpoint handling on shutdown. Whether a failed rate lookup can leave a row
> internally inconsistent: a rate with no date, or a rate attached to a stage that has
> since been cleared.
>
> **3. Security.**
>
> The front end builds HTML with template literals and `innerHTML`. Find **every**
> interpolation that does not pass through `esc()` and determine whether the value can
> carry user-controlled text. Note that `fmtDate` escapes its own output, so double
> escaping is also a defect. The notes field accepts 2000 arbitrary characters.
>
> Check SQL injection through column names, values and any ORDER BY. Prototype
> pollution through request bodies spread into objects (`__proto__`, `constructor`).
> SSRF and injection through `MYAAVE_FX_URL` and anything interpolated into a fetch
> URL. Whether the API trusts any field it should compute itself, exchange rates above
> all. The `Host` allow-list and `MYAAVE_ALLOWED_HOSTS`: can it be bypassed, and does
> it still block DNS rebinding. The shell scripts for word splitting and unquoted
> expansions.
>
> State for each finding whether it is exploitable given that the app binds loopback
> and sits behind basic auth in production, or only if that changes. **Do not pad the
> list with "no authentication" or "no HTTPS" as findings in themselves.**
>
> **4. The interface.**
>
> Validation that disagrees between client and server, in either direction. Numeric
> parsing of pasted input: thousands separators, currency symbols, European decimal
> commas, leading `+`, exponent notation, values that lose precision. State handling
> across re-renders, in-flight requests and view switches, including whether a slow
> response can overwrite newer state, and whether a half-typed form can be silently
> discarded. Event delegation, and whether any handler can fire twice or leak. Any
> field that renders a value in one currency under the symbol of another. Anything
> showing a stale, wrong or `0` figure where the honest answer is "unknown". Layout
> that clips or overflows: check `scrollWidth` against `clientWidth` rather than
> judging by eye, at 1440px and 390px, in both themes.
>
> **5. Errors and edge cases.**
>
> Unhandled promise rejections, an async route that can hang, a thrown error that
> escapes a handler and takes the process down, the network failing mid-request,
> malformed JSON, missing fields, absurd values, a database that is read-only or full.
>
> ### Rules
>
> - **Verify before reporting.** Read the surrounding code. Where you can, prove it:
>   write a throwaway script, or run the server on a temp database via `MYAAVE_DB` and
>   drive it with curl. Say explicitly which findings you executed and which you only
>   reasoned about.
> - Every finding gives: `file:line`, severity, what breaks, a concrete trigger (exact
>   input, exact sequence), the impact, and a fix in one or two sentences.
> - **Distinguish a defect from a deliberate decision.** Several apparent oddities here
>   are intentional and documented in comments or `CHANGELOG.md`: an open position is
>   not marked to the current exchange rate; a loan cost can be negative when the euro
>   falls; the headline annualized figure is a blended return on capital over time, not
>   the mean of the per-trade rates. If a comment explains the behaviour, either accept
>   it or explain why it is wrong anyway.
> - No style, naming, formatting or "add tests" findings. Behaviour and security only.
> - If an area is clean, say so rather than inventing something to fill it.
>
> Report the findings only. Do not change any code unless I ask.

---

## Notes on using it

Drop the last line if you want fixes applied as it goes. Narrow the scope by deleting
the sections you do not want; the five areas are independent.

The highest-value variant is section 1 alone, run against a specific figure you
distrust, phrased as: *"Reproduce this number from the raw trade data by hand, then
tell me whether the code computes the same thing its label claims."* That is how the
mislabelled annualized figure was found: the arithmetic was correct and the word
"Average" was not.
