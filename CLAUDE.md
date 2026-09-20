# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
./run_myAave.sh              # start it; checks Node, installs deps, finds a free port
./run_myAave.sh --kill       # reclaim port 3000 instead of moving to the next one
./run_myAave.sh --port 3011  # a specific port
./resetDatabase.sh           # empty the ledger; asks twice, backs up to data/backups
npm start                    # node server.js, no port hunting
```

**There is no test suite, no linter and no build step.** Nothing is transpiled; the
files on disk are the files that run. So verification means executing the thing you
changed:

```bash
node --check server.js                      # syntax (public/app.js needs a .mjs copy)
node --input-type=module -e "import('./lib/calc.js').then(...)"   # pure functions
PORT=3011 MYAAVE_DB=/tmp/scratch.db npm start                     # never data/myaave.db
```

Drive a throwaway ledger rather than reasoning about a figure: import `lib/calc.js`
directly for math, or run a server on a temp database and hit it with curl. Claims of
correctness in this repo are expected to come with the command that produced them.

### Switches that make the app testable offline

| Variable | Effect |
| --- | --- |
| `MYAAVE_DB` | database file. Always set it when testing. |
| `MYAAVE_FX_OFFLINE=1` / `MYAAVE_ETH_OFFLINE=1` | no network lookups at all |
| `MYAAVE_ETH_PRICE=3450` | a fixed ETH price, so alerts can be driven deterministically |
| `MYAAVE_BOT_OFF=1` | no Telegram long-poll |
| `MYAAVE_FX_URL` / `MYAAVE_ETH_URL` / `MYAAVE_TELEGRAM_URL` | point at a mock |
| `MYAAVE_ALLOWED_HOSTS` | extra Host values, for running behind a proxy |

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

Since 1.0.0 the number means what SemVer says it means, so `major` is the right verb
for a change to the API, the database or a stored figure — not `patch` out of habit.

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

`fx.js`, `eth.js`, `db.js`, `telegram.js`, `config.js`, `alerts.js`, `bot.js`,
`report.js` and `format.js` sit at the root **because they are server-only** — the
browser is served `lib/` wholesale. `format.js` duplicates some of `public/app.js`'s
formatters on purpose: the browser's escape their output for `innerHTML`, which would
be wrong in a Telegram message.

### Two instances can share one database

`run_myAave.sh` starts a second copy on the next free port when the first is in the
way, so concurrent access is a supported state, not an edge case. This is why:

- alerts are claimed with a conditional `UPDATE ... WHERE id = ? AND status = 'armed'`
  before the message is sent, so of two processes exactly one gets `changes === 1`;
- the Telegram bot takes a **lease** in `bot_state` (only one caller of `getUpdates`
  may exist), and an instance without it never touches the network;
- a partial unique index allows one *armed* alert per trade;
- cache reads and writes in `fx.js` / `eth.js` swallow database errors — a statement
  can be refused while the connection is open, and a cache that cannot be read is a
  miss, not a failure.

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

### Rules the code holds itself to

- **`null` is not `0`.** A figure nobody measured renders as a dash. A closed trade
  with no exchange rate made a real gain that is simply not known in dollars, and
  printing `$0.00` states a figure nobody measured.
- **Sign and colour come from the figure as printed, not as held.** A value that
  rounds to all zeros carries no minus and no red. `printsZero` in `public/app.js`
  and `signOf` in `format.js` exist for this; `pctClass`/`gainClass` are the colour
  half. This rule has been broken and re-fixed several times — check it whenever you
  touch a formatter.
- **A figure and its label must describe the same thing.** A number that is
  arithmetically correct under a label describing something else is a bug here.
- **Exchange rates are resolved server-side and never accepted from a request.** A
  caller that could post its own rate could move every dollar figure in the ledger.
- **Migrations are shape-detected, not versioned.** `addMissingColumns` reads the
  table back and adds what is missing. A new column needs **both** the `CREATE TABLE`
  DDL edit (for fresh databases) and the column-list edit (for existing ones).

### Comments are load-bearing

This codebase documents *why*, at length, and usually names the specific failure a
line prevents. Match that: a comment explaining a past bug is the reason the code
looks the way it does, and deleting or contradicting one is a regression. When an
apparent oddity has a comment defending it, either accept it or explain why it is
wrong anyway — several are deliberate (an open position is not marked to today's
exchange rate; a loan cost can be negative when the euro falls; the headline
annualized figure is a blended return on capital over time, not a mean of per-trade
rates).

`CHANGELOG.md` entries are written in the same voice and carry the reproduction, not
just the fix.

### Security posture

The ledger binds loopback and has no authentication of its own; in production nginx
serves `landing/` at `/`, keeps the app at `/app` behind basic auth, and the systemd
service runs as a different user from the one that owns the checkout. A Host
allow-list blocks DNS rebinding — a page on the internet pointing its own hostname at
127.0.0.1 fails it. `config.env` holds the Telegram token, is gitignored, and every
string leaving `telegram.js` is redacted first.

## Importing other agent configs

An OpenAI Codex config exists at `~/.codex/config.toml`. Reply `/import` to scan and
list what is importable (MCP servers, slash commands, subagents, skills,
instructions), then `/import --yes=<digest>` with the digest that scan prints to apply
the user-level items. If `/import` is unavailable on this surface, run `claude import`
from a terminal instead.
