# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [0.0.14] - 2026-09-19

### Fixed

- The exchange-rate lines on a EURC trade's stage cards were clipped mid-word: "$7,117.20 at 1.1862 on 13 Feb 20", "-$38.55 interest $8.25, currency ". The cards sit inside the expanded row's table cell, which inherits the table's `white-space: nowrap` so a column of figures never breaks mid number. Inside a card that is wrong, and the line had nowhere to go. The cell now resets it, and the converted figure and the rate that produced it take a line each. The part being cut was the rate and the date, which is exactly what makes a conversion checkable against the ECB's own tables.
- The loan cost breakdown is two rows of its own rather than a run-on third line. It matters most when the cost comes out negative, which happens when the currency fell over the life of the loan, and that was the case being cut off hardest: -$38.55 is $8.25 of interest less $46.80 the euro moved. A signed figure in those rows keeps its colour, like every other gain and loss in the app.

### Notes

- Presentation only. `lib/calc.js` is untouched and a dollar-stablecoin trade renders exactly as before: no sub-lines, no extra rows.
- Verified by asserting that nothing inside the stage cards has `scrollWidth` greater than `clientWidth`, at 1440px and 390px in both themes. Twelve elements failed that before the change; none do now.

## [0.0.13] - 2026-09-19

### Security

- The app sent no framing policy, so an attacker's page could embed the ledger against a logged in session and place a click on **Delete trade**. That was moot while it answered only on loopback; behind a proxy it is not. `frame-ancestors 'none'` and `X-Frame-Options: DENY` are both sent, along with `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. It stops at framing on purpose: a `script-src` policy would need `'unsafe-inline'` for the theme script that runs before first paint and for the bar widths on the Summary, and a policy that allows inline script is most of the way back to no policy at all.
- `X-Powered-By: Express` is no longer advertised.

## [0.0.12] - 2026-09-19

### Changed

- The **Ask for Access** button carries an envelope, so it is clear it opens a mail client rather than another page. It is an inline SVG stroked in `currentColor`, not a background image, so it takes the button's colour in both themes without a second rule.

### Fixed

- The landing page footer still read v0.0.10 after the 0.0.11 release. It is hand-maintained, because `/api/version` sits behind auth, so it has to be bumped alongside the others and was missed.

## [0.0.11] - 2026-09-19

The four low severity items left open by the 0.0.7 audit, all in the rate lookup.

### Fixed

- A backfill asked for one span running from the earliest date needing a rate to the latest. Two EURC trades six years apart pulled every business day in between: 2,435 days to fill two rates. The days are now grouped into runs, so the same pair costs two requests of eight days each. Each run opens a week early, so one starting on a weekend still has a published day to carry forward from.
- A backfill had no bound on how long it could run. Each request was capped at 2.5 seconds but the number of them was not, so a ledger with many scattered dates held the browser's request open for minutes. A run now stops after twenty seconds, reports what it did not reach as still missing, and says there is more to fetch.
- The ECB never publishes on a Saturday or a Sunday, so a weekend transaction is converted at Friday's rate permanently and correctly. `tradesWithSubstitutedFx` matched on the dates alone, which put every weekend trade in the list of replaceable stand-ins forever, to be re-fetched on every refresh and counted as still missing each time. Only transactions on a business day are listed now.
- `derive` reported an exchange rate source inside each of the four stages, but a row stores one `fx_source` for all of them, so the four always agreed whether or not the rates came from the same fetch. The source is reported once for the row as `fxSource` instead of claiming a provenance per transaction.

## [0.0.10] - 2026-09-19

### Fixed

- The ledger answered every proxied request with `This ledger only answers on localhost.` The Host allow-list added in 0.0.7 is right to exist, but it assumed the app is only ever addressed on loopback, which stopped being true once nginx sat in front of it sending the public hostname. `MYAAVE_ALLOWED_HOSTS` now names the hosts a proxy may present. Unset, behaviour is exactly as before; set, any hostname not on the list is still refused, so the protection is intact.
- An unknown path under `/api` fell through to Express's default handler and answered with an HTML error page, where every other API response is JSON. A client that mistyped an endpoint failed to parse the reply rather than reading the error.

### Added

- A 404 page for aaveloop.com at `landing/404.html`, in the landing page's own design, served by nginx for a missing public file and by the app for an unknown path. The shared `/var/www/errors/404.html` that the other sites on the host use is untouched.
- The nginx 404 handler needs `auth_basic off`. Without it the internal redirect re-runs auth and a missing file reports as a 401, which is what made a missing `landing/` directory look like a credentials problem.

### Changed

- The landing page drops the self-hosting card and the line about running on your own server, and the closing call to action gains an **Ask for Access** button.

## [0.0.9] - 2026-09-19

### Changed

- The Trade column states the span of a loop rather than only its start: `10 Jan 2026 - 13 Jan 2026`. The range appears only once a trade is repaid, because that is the only point at which it has a real end date. A trade still running shows its borrow date alone rather than being paired with today, which would put a date on the row that nobody entered and that moves by itself overnight.
- A trade in a currency other than the dollar now carries its native amount on its own line, above the dates. The two used to share one line joined by a middot, which read as a run-on: the amount borrowed and the days it ran are different kinds of fact. Dollar stablecoins are unchanged at two lines, since there the native amount and the dollar value are the same number.
- In card mode the Trade label is aligned to the top of its cell, rather than floating in the middle of what is now a three line stack.

### Notes

- Presentation only. `lib/calc.js` is untouched and `/api/trades` and `/api/summary` return byte-identical responses before and after.
- The first column narrowed slightly rather than widening, because splitting the two figures removed what had been the longest single string in it.

## [0.0.8] - 2026-09-19

### Added

- A public landing page at `/`, in `landing/`. It explains what the ledger does in a screen or two and carries a **Use Aave Loop** button that leads to the app, and therefore to the password prompt. Served by nginx as static files, which leaves the Node process with no publicly reachable route.
- The page shares the app's `myaave-theme` setting, so a dark session carries across both ways, and it follows the system preference for a first time visitor, which the app does not.

### Notes

- The landing page is intentionally self contained rather than linking the app's stylesheet: `/styles.css` sits behind basic auth, so a public visitor would get a 401 and an unstyled page.
- Its text colour is a darker violet than the fills. `#9896ff` measures 3.6:1 on the soft violet behind the status badges, which fails contrast for small bold type; the text violet clears 4.9:1 there and 5.7:1 on white.
- The footer states plainly that this is an independent tool and not affiliated with Aave, since the page borrows enough of their look that the question is worth answering up front.

## [0.0.7] - 2026-09-19

Twenty-two defects found by an audit of the maths, the database handling, the security surface, the interface and the error paths. No new features.

### Security

- The API answered any `Host` header, so a page on the internet could point its own hostname at `127.0.0.1` and reach the ledger as a same origin, reading and deleting every trade. The loopback bind is the whole of this app's protection, so a request now has to be addressed to loopback as well.
- The backfill stored whatever the rate service sent. `resolveRange` never ran the check `resolveRate` applies to every single-day answer, so a rate of `-999999` was accepted and written to a trade, and the day key from the response was stored in `*_fx_date` and rendered into the page unescaped. Both paths now validate, and `fmtDate` escapes its result.

### Fixed, crashes and races

- `GET /api/fx/rate` had no error handling. Express does not catch a rejected async handler, so any throw from the rate cache became an unhandled rejection: the request hung with no answer and the server process exited. `/api/fx/backfill` next door already guarded against this.
- Editing or creating a borrow threw `ReferenceError: Cannot access 'c' before initialization` on every keystroke once an amount and an APR were both present. `c` was read in the borrow branch of `refreshHints` nine lines before its `const`, so the interest-per-day hint never appeared at all.
- `PATCH` became asynchronous when rate lookups moved into it, so two requests for one trade interleaved across the await: the second read the row before the first had written and answered the browser with a row missing the change just made. Writes are now serialized per trade.
- A rate backfill could pin a rate to a stage that had moved while it was away on the network. It now re-reads each row inside its transaction and skips any stage whose date or currency changed.

### Fixed, in the dates

- `todayISO()` returned the UTC date, which anywhere east of UTC is yesterday for part of the day. The forms prefilled yesterday and the browser then refused the user's own today as "in the future": in Tokyo from 09:00 local onwards, in Rome between midnight and 02:00. Today is now read from the local calendar on both sides. Spans are unaffected, because `parseDate` still builds UTC midnights, so DST and leap years stay exact.
- The server let a future date through anyway. Its 36 hour slack was measured from `Date.now()` while a date parses to UTC midnight, so tomorrow always fell inside it and still produced the negative loan span the check exists to prevent.

### Fixed, in the maths

- The Average annualized figure was weighted by loan size alone, so a one day flip that made $50 counted as heavily as a ninety day trade that made $900. Two such trades read 109.5% where the honest figure is 38.1%. The weight is now capital times time.
- The by-currency table counted only closed trades towards Borrowed, so a currency with 50,000 still outstanding showed a dash, contradicting the Open positions tile on the same page.
- A trade that came out exactly flat was counted as a loss, reporting a break-even ledger as 0% won. It is now left out of the win rate rather than held against it.
- A closed trade whose rate had not been fetched made the headline Realized net gain read `+$0.00`. It made a real gain that is simply not known in dollars, and that tile shows on the Trades view too, where the Summary's banner is not there to explain it. The total is now marked unknown rather than stated as zero.

### Fixed, in the numbers people paste

- A European amount was silently gutted. `32.000,00` lost its comma and became 32, recording a 32,000 loan as thirty-two; `32000,50` became 3200050. A pasted amount is now read for what it is. Typing is unchanged, because `1,5` on its way to `1,500` cannot be read as a decimal comma.
- A half typed `1500.` was rejected as "must be a number" although the server accepted it. The trailing dot of a figure on its way to `1500.75` is now allowed.
- The form and the server disagreed about exponent notation: `1e5` was 15 in one and 100000 in the other, because the form deleted letters until what was left parsed. Both now use one parser in `lib/calc.js`, which refuses anything that is not a number instead of editing it.
- An APR sent as a single space was stored as 0%, a silent interest free loan. Whitespace now counts as blank.

### Fixed, in the interface

- An error raised when a field was left refocused that same field, so the value could not be tabbed away from until it was acceptable. An error from leaving a field no longer takes focus back.
- Neither form disabled its button while a request was in flight, so a double click on Create trade posted the same borrow twice and the duplicate then double counted in every total.
- Derived figures were a snapshot taken when the page loaded, so a tab left open across midnight kept showing the day count and the accrued interest from load time. The browser now recomputes them from the shared module.
- A failed **Fetch rates** left the button reading "Fetching..." and disabled for good, because the re-render that would have replaced it never happened.

### Fixed, on the server

- Clearing a stage's amounts through the API left a row still labelled CLOSED whose net gain had become null, so it dropped out of every realized total while being counted as an open position. 0.0.5 closed this for the dates only; stage order now holds on the amounts too.
- An oversized request body was reported as a 500. It is a 413.
- A write that lost the lock race to a second instance was reported as a 500 as well, which read as data loss. It is now a 503 saying the ledger is busy and to try again.
- Caching a span of rates committed once per day in the span. A wide backfill is thousands of days, so it is now one transaction.

## [0.0.6] - 2026-09-19

### Added

- EURC as a fifth borrowable currency, converted to US dollars at the European Central Bank euro reference rate published for the day of each transaction. Each of the four stages is converted at its own date, so the euro's movement over the life of a loan lands in the dollar result rather than disappearing.
- The Repaid card splits the cost of a loan in another currency into the interest and what the currency itself did to the principal, so a loan that got cheaper in dollars reads as an explanation rather than a mistake.
- Rates are cached in the database and looked up once. A trade always saves whether or not a rate could be fetched; one without a rate is marked, left out of the totals, and filled in later by **Fetch rates** on the Summary.
- `GET /api/fx/rate`, `GET /api/fx/status` and `POST /api/fx/backfill`. All three answer 200 when the network cannot be reached, since that is a result to show rather than a server fault.

### Fixed

- Every cross-currency total summed raw amounts as though one token were always one dollar. Harmless while every supported coin was a dollar, it would have reported a 50,000 EURC borrow as $50,000. The totals now convert, and the average annualized return is weighted by the dollar size of each loan rather than the native one.
- The ETH buy and sell price divided the amount spent by the ETH bought and labelled the result dollars. On a trade in another currency that is a euros-per-ETH figure under a dollar sign.
- Best and worst trade ranked native amounts against each other, which is not a comparison.

### Changed

- The database gains nine nullable columns and a rate cache table, added on first open. An existing ledger opens unchanged, with no migration to run by hand.
- Exchange rates are resolved by the server and rejected if submitted, so no request can move the dollar figures without touching an amount.
- "Stablecoin" reads "Currency" in the form and the summary table.

## [0.0.5] - 2026-09-19

### Added

- `resetDatabase.sh`, which empties the ledger. It asks twice, refuses to run while a server holds the file open, and keeps a timestamped backup unless told not to.

### Changed

- The four stage cards now put the money on the second line and state it in the coin that was borrowed, so "32,000.00 USDT" reads in one go. The Sold ETH card leads with Received and then Sold. ETH prices stay in dollars.
- Amount fields carry the stablecoin ticker instead of a dollar sign, and the ticker follows the dropdown while a new trade is being entered.

### Fixed, in the maths

- The Repaid card showed the theoretical accrued interest while the net gain was computed from the interest actually paid, so the card did not add up: gross 2,824.00 less the 304.10 shown missed the 2,519.87 stated. It now shows the interest the loan really cost.
- The live preview under the repayment field ran its own `proceeds - repaid` formula instead of the shared one. On a partial sale it read -4,028.77 where the saved result was +971.23.
- A repayment below the principal made the implied interest negative, which the net gain then counted as profit. Repaying 20,000 on a 32,000 loan reported a 14,824 gain. Such a repayment is now rejected.
- A trade could be recorded as repaid without ever having been sold, a state the maths has no answer for. Stages must now be filled in order, as the interface already required.
- `summarize` called every repaid trade closed while `summaryReport` required a net gain, so the two disagreed about the same row. Both now use one definition of a realized trade.
- The by-stablecoin sort compared two nulls as `-Infinity - -Infinity`, giving NaN and an undefined order.
- A typed `0` was treated as an empty field, so a 0% borrow previewed nothing even though it is accepted.
- A future dated trade produced a negative loan span, which quietly suppressed the interest and the annualized return instead of reporting anything. Future dates are now refused.

### Fixed, in the interface

- Pasting an amount such as `12,000` or `$12000` left the field silently empty, because a number input discards what it cannot parse. Amounts are now collected as text and tidied as they are typed.
- Negative amounts, a negative APR, an APR above 100 and future dates were all accepted by the form and only refused by the server, one round trip later.
- A blank form submitted blanks rather than saying what was missing. Every field is now checked before anything is sent, and again when a field is left.
- An error stayed on screen and the field stayed red even after the value was corrected.
- Edits in progress were silently discarded when the view changed, reverting the field to its stored value.
- The stage forms are validated against their siblings, so selling more ETH than was bought, or dating a sale before its purchase, is caught as it is entered.

## [0.0.4] - 2026-09-19

### Added

- A real Summary view behind the nav link, which until now only scrolled the page. It reports performance by stablecoin, net gain by month closed, best and worst trade, interest paid, win rate, total borrowed and average hold time.
- The nav now switches views, tracks the active link and supports deep links such as `#summary`.

### Fixed

- The nav was hidden below 760px. Once the links did something, that left the Summary view unreachable on a phone, so it now drops to a segmented control on its own row.
- Grid tracks declared as `minmax(260px, 1fr)` cannot shrink below their floor, so on a narrow viewport they overflowed and the card's `overflow: hidden` silently clipped the values. The same flaw affected the stage cards and the stage forms.
- API responses carried an ETag but no `Cache-Control`, so the browser could heuristically cache them and show a ledger that had already changed. They are now `no-store`, and the client asks for them uncached.
- Static assets were served with `max-age=0`, which still allowed reuse from the memory cache. They are now `no-cache`, so an edit is picked up on the next load.
- `/favicon.ico` returned 404. It now redirects to the app icon.

## [0.0.3] - 2026-09-19

### Changed

- Dropped the APR column from the trades table. The rate is still on the Borrowed card when a row is expanded.
- Broke the page subtitle across two lines.

## [0.0.2] - 2026-09-19

### Changed

- Renamed the app to Aave Loop Ledger.
- USD is shown to two decimals and ETH to four throughout.
- Footer is now right aligned and credits the author.
- The server binds to loopback only, so the ledger is not exposed to the network.

### Fixed

- Gross gain on a partial sale compared the proceeds against the whole purchase, turning a profitable sale into a large reported loss. It now uses the cost basis of the ETH actually sold, and the remaining ETH is shown.
- An annualized return was still produced when the dates ran backwards. Both that and accrued interest now return nothing for a negative span.
- A borrow at 0% APR was rejected. Rates may now be zero while amounts must still be positive.
- Clearing a required borrow field through the API failed as an opaque server error instead of a validation message.
- A repayment could be dated before the sale that funded it.
- A malformed JSON body returned a server error rather than a bad request.
- The database is now checkpointed and closed on shutdown, so committed rows no longer sit in a stray write ahead log.
- Added a busy timeout, so a second instance sharing the same file waits for a write instead of failing at once.
- Prepared statements are cached rather than recompiled on every write.
- Dark mode never set `color-scheme`, so the native date picker and scrollbars stayed light.
- A failed delete and an unreachable server both failed silently in the interface.

## [0.0.1] - 2026-09-19

### Added

- Trade lifecycle in four stages: borrow, buy ETH, sell ETH, repay.
- Progressive entry, so a trade can sit at Open, Holding, Sold or Closed.
- Derived figures: ETH buy and sell price, gross gain, accrued interest, net gain, annualized return.
- Repaid amount prefilled from the APR and the loan length, editable.
- SQLite storage with full history, plus view, edit and delete of past trades.
- Light and dark themes modelled on app.aave.com, with the choice remembered.
- `run_myAave.sh` launcher with dependency, port and Node checks.
