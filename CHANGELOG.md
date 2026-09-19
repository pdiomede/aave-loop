# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

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
