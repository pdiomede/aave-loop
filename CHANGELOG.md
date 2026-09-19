# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [0.0.1] - 2026-09-19

### Added

- Trade lifecycle in four stages: borrow, buy ETH, sell ETH, repay.
- Progressive entry, so a trade can sit at Open, Holding, Sold or Closed.
- Derived figures: ETH buy and sell price, gross gain, accrued interest, net gain, annualized return.
- Repaid amount prefilled from the APR and the loan length, editable.
- SQLite storage with full history, plus view, edit and delete of past trades.
- Light and dark themes modelled on app.aave.com, with the choice remembered.
- `run_myAave.sh` launcher with dependency, port and Node checks.
