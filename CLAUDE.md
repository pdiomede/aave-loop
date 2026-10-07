# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
./run_myAave.sh              # start it; checks Node, installs deps, finds a free port
./run_myAave.sh --kill       # reclaim port 3000 instead of moving to the next one
./run_myAave.sh --port 3011  # a specific port
./resetDatabase.sh           # empty the ledger; asks twice, backs up to data/backups
./backupDatabase.sh          # online SQLite backup, safe while the server runs; --help has the cron line
npm start                    # node server.js, no port hunting
npm run check                # scripts/check-calc.mjs, check-input.mjs, check-statement.mjs, then check-server.mjs
node scripts/check-server.mjs  # one suite on its own; there is no per-check filter
```

**There is no test framework, no linter and no build step.** Nothing is transpiled;
the files on disk are the files that run. `npm run check` runs four scripts.
`scripts/check-calc.mjs` covers the estimate math in `lib/calc.js` against hand-worked
figures on a fixed date; add a case there when you change a formula, with the expected
value worked out from the inputs rather than by calling the function again.
`scripts/check-input.mjs` covers `lib/input.js` - how a typed or pasted figure is read
and what the forms accept - typing each figure a keystroke at a time as the page does;
add a case there when you change an input rule.
`scripts/check-statement.mjs` covers `lib/statement.js`, the Statement PDF: that the
hand-written file is a valid one-page PDF, that the figures it sets match ones worked
out by hand, and that `lib/logo.js` still matches the app's logo; add a case there
when you change what the statement prints.
`scripts/check-server.mjs` starts the real server as a child on a free port, against a
database in a temp directory with Telegram and the price service mocked on loopback,
and checks the API's write rules, the alert message, every way the alert sweep handles
a failed send, and the bot's reports; add a case there when you change any of those.
It never touches the network or `data/myaave.db`, and takes about eight seconds.
Beyond that, verification means executing the thing you changed:

```bash
node --check server.js                      # syntax (public/app.js needs a .mjs copy)
node --input-type=module -e "import('./lib/calc.js').then(...)"   # pure functions
PORT=3011 MYAAVE_DB=/tmp/scratch.db npm start                     # never data/myaave.db
```

Drive a throwaway ledger rather than reasoning about a figure: import `lib/calc.js`
directly for math, or run a server on a temp database and hit it with curl. Claims of
correctness in this repo are expected to come with the command that produced them.
Stop a scratch server by the PID you started it with, never `pkill -f "node server.js"`:
the user's own instance, or another scratch server, is often running too.

Every non-GET `/api` request must send `Content-Type: application/json`, or it gets a
415. That is the cross-site guard, so a bare `curl -X POST` fails by design: add
`-H 'Content-Type: application/json'`. A purchase or sale also needs its swap cost
(`buy_gas_usd` / `sell_gas_usd`).

### Switches that make the app testable offline

| Variable | Effect |
| --- | --- |
| `MYAAVE_DB` | database file. Always set it when testing. |
| `MYAAVE_FX_OFFLINE=1` / `MYAAVE_ETH_OFFLINE=1` | no network lookups at all |
| `MYAAVE_ETH_PRICE=3450` | a fixed ETH price, so alerts can be driven deterministically; read like a typed amount, and a value that is not a usable price is ignored with a warning |
| `MYAAVE_BOT_OFF=1` | no Telegram long-poll |
| `MYAAVE_FX_URL` / `MYAAVE_ETH_URL` / `MYAAVE_TELEGRAM_URL` | point at a mock |
| `MYAAVE_ALLOWED_HOSTS` | extra Host values, for running behind a proxy |
| `MYAAVE_FX_REFRESH_MS` | how often the server re-asks for missing and stand-in rates (default an hour) |

Every interval read from the environment (`MYAAVE_FX_REFRESH_MS`, `MYAAVE_ALERT_POLL_MS`,
`MYAAVE_ETH_POLL_MS`, and the bot's `MYAAVE_BOT_LEASE_MS`, `MYAAVE_BOT_LEASE_RETRY_MS`,
`MYAAVE_WATCH_MS`) goes through `intervalMs` in `lib/calc.js`: below a second it is
the default, above 2^31 − 1 ms it is capped. Node turns an out-of-range timer into 1 ms,
so a huge value meant to switch something off made it fire continuously.
`MYAAVE_BOT_POLL_S` is clamped to 1–50 seconds, and `/watch` to at least a minute.

`MYAAVE_CONFIG` relocates `config.env`. Everything in that file can be overridden by
exporting it for one run; the shell always wins over the file.

### Releasing

```bash
npm version patch --no-git-tag-version
```

`--no-git-tag-version` is load-bearing. Plain `npm version patch` also commits and
tags, and neither is wanted: releases have not been tagged since v0.0.19–v0.0.23, and
the commit message should say what changed rather than repeat the number.

Write the `CHANGELOG.md` entry **before** the bump. The `version` lifecycle ends in
`git add -u`, so an entry written first is staged with everything else; written after,
it is left behind. Then commit by hand.

Since 1.0.0 the number means what SemVer says it means: `major` for a change to the
API, the database or a stored figure, `minor` for a new feature or figure on screen,
`patch` for fixes and cosmetic changes only — not `patch` out of habit.

Every user-visible change gets its `CHANGELOG.md` line in the commit that makes it,
under `## [Unreleased]`, which you rename to the new number by hand at release (the
bump does not touch `CHANGELOG.md`). A change committed with
no entry is forgotten by the next release; two Repaid card commits went out that way
and had to be written up after the fact. Run `npm run check` before the bump.

The bump runs `scripts/stamp-version.mjs`, which writes the number into the two pages
that print it, `public/index.html` and `landing/index.html`. **A pattern that no
longer matches is an error, not a silent skip**, because a version left behind quietly
is the failure that script exists to prevent — so if you restructure either footer,
expect the next release to fail loudly and fix the regex rather than working around
it.

Both pages are stamped because a reader sees both numbers, and for different reasons.
The landing page has no runtime source at all and nginx serves it directly, so a
missed edit there simply stands. The app repaints its own footer from `/api/version`
once the page is up — but that repaint is deliberately not awaited and can fail, so
the stamped number is what renders on every load and what stays if the call never
lands.

## Architecture

Express + better-sqlite3 + vanilla ES modules. Four stages per trade (borrow, buy
ETH, sell ETH, repay), each with its own date and amounts, all denominated in
`borrow_currency`. Everything is reported in USD.

### lib/calc.js is isomorphic, and that is the central constraint

It is imported by Node **and** served raw to the browser at `/lib/calc.js`, so both
sides run byte-identical formulas. **It must import nothing, ever** — the moment it
reaches for the database or the network it stops working in the browser. Keep it pure
and synchronous. `derive(trade)` is the single source of truth for a trade's status
and every derived figure; anything that needs to know whether a trade is HOLDING
should ask `derive`, not re-implement the test. Several past bugs were exactly that
drift between a hand-written SQL predicate and `stages()`.

`estimatedGainUsd(t, d, price, fxNow)` is the same for an open position's estimate:
the header's Open positions tile (`openGainsUsd`), the table's `est` figures and their
sort, Telegram's `/holding` and the alert message all print it, so one trade never
reads two ways. It takes the ETH price and today's rate per coin as arguments rather
than fetching them, which is what keeps it in `lib/`. It is the one place an open
position is marked to today's exchange rate; `derive`'s own figures never are.

`lib/input.js` is the forms' input half - `sanitizeNumeric`, `validateField`, the field
labels - out of `public/app.js` so it can be checked; like `lib/csv.js` it imports
`calc.js` and nothing else, and keeps no DOM.

`lib/statement.js` writes the Stats Statement button's PDF by hand - no library, so
nothing is bundled and the CSP is untouched - from the same `summaryReport` the Stats
view calls, over the year's **closed trades only** (`closedTrades`, by `isRealized`):
it is a closing statement, so an open position is in no figure on it. It imports
`calc.js` and `lib/logo.js`, the logo's PNG data written by `scripts/make-logo.mjs`
(rerun it if `public/AaveLoop_logo_96.png` changes; the checks fail until you do).
It is one A4 page by construction (a year has at most 12 months and `CURRENCIES` 5
coins) and throws rather than draw past the bottom margin, so a layout change that
overflows fails `npm run check`. It is ASCII throughout - text beyond it as octal
escapes, the logo hex-encoded - so the xref offsets are string lengths.

`fx.js`, `eth.js`, `db.js`, `telegram.js`, `config.js`, `alerts.js`, `bot.js`,
`report.js` and `format.js` sit at the root **because they are server-only** — the
browser is served `lib/` wholesale. `format.js` duplicates some of `public/app.js`'s
formatters on purpose: the browser's escape their output for `innerHTML`, which would
be wrong in a Telegram message.

### Two instances can share one database

`run_myAave.sh` starts a second copy on the next free port when the first is in the
way, so concurrent access is a supported state, not an edge case. Production runs one
copy; this is mostly a dev-machine state, but the code holds for both. This is why:

- alerts are claimed with a conditional `UPDATE ... WHERE id = ? AND status = 'armed'`
  before the message is sent, so of two processes exactly one gets `changes === 1`;
- the Telegram bot takes a **lease** in `bot_state` (only one caller of `getUpdates`
  may exist), and an instance without it never touches the network;
- a partial unique index allows one *armed* alert per trade;
- an armed alert whose trade no longer holds ETH is closed by `closeUnwatched()`, a
  conditional `UPDATE ... WHERE status = 'armed'`, run after a trade edit, at startup
  and at the top of every sweep — the sweep is what catches the other copy's edits;
- a `PATCH` writes only to the row it read (`WHERE id = ? AND updated_at IS ?`) and
  works the edit out again from a fresh read when the other copy got there first,
  because the rate lookup in between can take seconds; three misses answer 503;
- an alert's failed sends are counted in SQL (`attempts = attempts + 1`), never from
  the row the sweep read at its start;
- both copies run the hourly rate refresher (`startFxRefresher` in `fx.js`), which
  is harmless: the backfill re-reads each row and writes the same rate, in an
  immediate transaction so it waits on the busy timeout instead of failing at once;
- cache reads and writes in `fx.js` / `eth.js` swallow database errors — a statement
  can be refused while the connection is open, and a cache that cannot be read is a
  miss, not a failure.

### How an alert's send can fail

`telegram.js` answers every send with `{ ok, retryable, setup }`, and `alerts.js`
treats the three failures differently. **Retryable** (5xx, 429, a timeout) puts the
alert back to armed and counts a try; three end in FAILED. **Setup** (401, 403, 404,
or a 400 naming the chat or the bot's rights) puts it back without counting, because
fixing `config.env` or the group cures it. Anything else is a refusal of the message
itself and is final. An armed alert with `fired_at` set has already reached its goal
and is sent on the next sweep whatever ETH costs; a goal saved afresh has none.
`scripts/check-server.mjs` drives each path against a mock Telegram.

### The frontend

`public/app.js` is the whole interface: template literals rendered into mount points
with `innerHTML`, one delegated `click` listener on `document.body`, no framework.

- **Anything from outside goes through `esc()`.** `fmtDate` escapes its own output, so
  double-escaping is also a defect.
- **Sequence guards.** `loadSeq`/`writeSeq` (and `alertLogSeq`/`alertWriteSeq`) drop a
  reply that a newer load overtook or a write superseded. Any new fetch that writes
  into `state` needs the same treatment.
- **`captureDraft`/`restoreDraft`** keep a half-typed stage form alive across
  re-renders. A change that re-renders the table must not discard it.
- **Submit locks are per form**, keyed by what the form saves (`submitKey`), so a
  re-render mid-request cannot reopen one and one form saving never blocks another.
- **Currency is a custom combobox** (`coinSelect`), not a `<select>`: the value lives
  in a hidden `borrow_currency` input, a pick fires `input` on it, and code that sets
  it directly must call `syncCoinSelect`. `CURRENCIES` is the picker's order and
  `CURRENCIES[0]` is a new trade's coin (`unitOf`). Its list is `position: fixed`
  because the trades table's scroll wrapper clips anything positioned inside it.

### Rules the code holds itself to

- **`null` is not `0`.** A figure nobody measured renders as a dash. A closed trade
  with no exchange rate made a real gain that is simply not known in dollars, and
  printing `$0.00` states a figure nobody measured.
- **Sign and colour come from the figure as printed, not as held.** A value that
  rounds to all zeros carries no minus and no red. `printsZero` in `public/app.js`
  and `signOf` in `format.js` exist for this; `pctClass`/`gainClass` are the colour
  half. This rule has been broken and re-fixed several times — check it whenever you
  touch a formatter.
- **A money figure is built from figures as printed.** `derive` takes every amount,
  dollar conversion and fee to the cent as its card prints it (`asPrinted`), and
  every result is a difference of those, so a stage card adds up line by line; the
  currency effect is what is left of the loan cost after the interest. Every total in
  `summarize`, `summaryReport` and `openGainsUsd` then adds `cents(v)`, never raw
  floats, so By month closed and By currency add up to Realized net gain. Rounded
  only at the end, cards missed their result by a cent on a quarter of euro trades and
  totals their rows on nearly half of random ledgers. New figures follow the same rule.
- **A figure and its label must describe the same thing.** A number that is
  arithmetically correct under a label describing something else is a bug here.
- **Exchange rates are resolved server-side and never accepted from a request.** A
  caller that could post its own rate could move every dollar figure in the ledger.
- **Gas fees are dollars, one per stage.** The swaps' ("Costs & Fees (swap)", gas
  plus the DEX fee) are required on a purchase or sale being written
  (`checkSwapFee` in `server.js`); the borrow's and repayment's are optional. 0 is
  a figure; NULL is "not recorded", never 0, whether left blank or on a trade from
  before fees existed: `feesUsd` is null and `feesMissing`
  names the stages. `derive` takes fees off `netGainUsd`, the projected gain and
  `unrealisedUsd`. The native `netGain` converts each fee at its own stage's rate, the
  one place a rate is divided, and is null until those rates exist, which is why
  `isRealized` gates on `grossGain` rather than `netGain`.
- **Migrations are shape-detected, not versioned.** `addMissingColumns` reads the
  table back and adds what is missing. A new column needs **both** the `CREATE TABLE`
  DDL edit (for fresh databases) and the column-list edit (for existing ones).

### Comments are load-bearing

This codebase documents *why*, at length, and usually names the specific failure a
line prevents. Match that: a comment explaining a past bug is the reason the code
looks the way it does, and deleting or contradicting one is a regression. When an
apparent oddity has a comment defending it, either accept it or explain why it is
wrong anyway — several are deliberate (an open position's own figures are not marked
to today's exchange rate — only its estimate is; a loan cost can be negative when the euro falls; the headline
annualized figure is a blended return on capital over time, not a mean of per-trade
rates).

`CHANGELOG.md` entries are short: one bullet per change, the problem and what it does
now, with at most one example. It was condensed by half, so do not grow it back.

### Security posture

The ledger binds loopback and has no authentication of its own; in production nginx
serves `landing/` at `/`, keeps the app at `/app` behind basic auth, and the systemd
service runs as a different user from the one that owns the checkout. A Host
allow-list blocks DNS rebinding — a page on the internet pointing its own hostname at
127.0.0.1 fails it. `config.env` holds the Telegram token, is gitignored, and every
string leaving `telegram.js` is redacted first.

Two rules the production nginx imposes on the pages, both enforced by `npm run check`:

- **The public pages load only from `/landing/`.** That is the one path nginx serves
  without a password, besides `/` itself. An image at the root goes to the app, behind
  auth, and the browser shows a login prompt on the public page — the landing logo did
  exactly that, in every browser without saved credentials. Keep a copy in `landing/`.
- **Inline scripts are admitted by hash.** nginx's Content-Security-Policy lists the
  SHA-256 of each inline script on `landing/index.html` and `landing/404.html`; edit one
  and the browser silently blocks it until the user updates nginx. The ledger page has
  no inline script at all for that reason — its theme runs from `public/theme.js`.
