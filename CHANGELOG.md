# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

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
