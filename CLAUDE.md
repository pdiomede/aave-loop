# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
./runETHRoundTrip.sh              # start it; checks Node, installs deps, finds a free port
./runETHRoundTrip.sh --kill       # stop another program on port 3000 instead of moving on
./runETHRoundTrip.sh --port 3011  # a specific port
./resetDatabase.sh           # empty the ledger; asks twice, backs up to data/backups
./backupDatabase.sh          # online SQLite backup, safe while the server runs; --help has the cron line
npm start                    # node server.js, no port hunting
npm run check                # scripts/check-calc.mjs, check-input.mjs, check-statement.mjs, then check-server.mjs
node scripts/check-server.mjs  # one suite on its own; there is no per-check filter
node scripts/set-platform.mjs --etherfi <id> [--apply]  # fill in old trades' platform; dry run without --apply
node scripts/audit-hashes.mjs [--apply]  # check every stored hash against its trade; --apply forgets wrong searched ones
```

**There is no test framework, no linter and no build step.** Nothing is transpiled;
the files on disk are the files that run. `npm run check` runs four scripts.
`scripts/check-calc.mjs` covers `lib/calc.js` - the estimates, the totals adding up as
printed - and the CSV's rounding, against hand-worked figures on a fixed date; add a
case there when you change a formula, with the expected value worked out from the
inputs rather than by calling the function again.
`scripts/check-input.mjs` covers `lib/input.js` - how a typed or pasted figure is read
and what the forms accept - typing each figure a keystroke at a time as the page does -
and `lib/address.js` against Keccak's and EIP-55's published vectors; add a case there
when you change an input rule.
`scripts/check-statement.mjs` covers `lib/statement.js`, the Statement PDF: that the
hand-written file is a valid one-page PDF, that the figures it sets match ones worked
out by hand, and that `lib/logo.js` still matches the app's logo; add a case there
when you change what the statement prints.
`scripts/check-server.mjs` starts the real server as a child on a free port, against a
database in a temp directory with Telegram, the price service and the rate service
mocked on loopback, and checks the API's write rules, the alert message (its lines
must add up to its Gain), every way the alert sweep handles a failed send, the bot's
reports and where `/watch` sends them, `scripts/set-platform.mjs`, `scripts/audit-hashes.mjs`, and `fx.js`'s
stand-ins and refusals (`fxChild` runs it in a child against a database of its own);
add a case there when you change any of those. It never touches the network or `data/myaave.db`, and takes about ten
seconds. A check is only worth adding if it fails on the old code: revert the fix
for a moment and run it.
Beyond that, verification means executing the thing you changed:

```bash
node --check server.js                      # syntax (public/app.js needs a .mjs copy)
node --input-type=module -e "import('./lib/calc.js').then(...)"   # pure functions
PORT=3011 ETHROUNDTRIP_DB=/tmp/scratch.db npm start                     # never data/myaave.db
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
| `ETHROUNDTRIP_DB` | database file. Always set it when testing. |
| `ETHROUNDTRIP_FX_OFFLINE=1` / `ETHROUNDTRIP_ETH_OFFLINE=1` | no network lookups at all |
| `ETHROUNDTRIP_ETH_PRICE=3450` / `ETHROUNDTRIP_BTC_PRICE=97000` / `ETHROUNDTRIP_WBTC_PRICE=96500` / `ETHROUNDTRIP_SOL_PRICE` / `ETHROUNDTRIP_PSOL_PRICE` | a fixed price per market (`<MARKET>_PRICE`), so alerts can be driven deterministically; read like a typed amount, and a value that is not a usable price is ignored with a warning. A fixed market is never fetched |
| `ETHROUNDTRIP_BOT_OFF=1` | no Telegram long-poll |
| `ETHROUNDTRIP_FX_URL` / `ETHROUNDTRIP_ETH_URL` / `ETHROUNDTRIP_TELEGRAM_URL` / `ETHROUNDTRIP_ETHERSCAN_URL` / `ETHROUNDTRIP_SOLANA_URL` | point at a mock |
| `ETHROUNDTRIP_ALLOWED_HOSTS` | extra Host values, for running behind a proxy |
| `ETHROUNDTRIP_FX_REFRESH_MS` | how often the server re-asks for missing and stand-in rates (default an hour) |

Every interval read from the environment (`ETHROUNDTRIP_FX_REFRESH_MS`, `ETHROUNDTRIP_ALERT_POLL_MS`,
`ETHROUNDTRIP_ETH_POLL_MS`, and the bot's `ETHROUNDTRIP_BOT_LEASE_MS`, `ETHROUNDTRIP_BOT_LEASE_RETRY_MS`,
`ETHROUNDTRIP_WATCH_MS`) goes through `intervalMs` in `lib/calc.js`: below a second it is
the default, above 2^31 − 1 ms it is capped. Node turns an out-of-range timer into 1 ms,
so a huge value meant to switch something off made it fire continuously.
`ETHROUNDTRIP_BOT_POLL_S` is clamped to 1–50 seconds, and `/watch` to at least a minute.

`TZ` sets the calendar the server counts days on (`todayISO`: interest, days held, the
bot's replies); the page counts on the reader's. Production should run with the
owner's zone (`TZ=Europe/Rome` in the service), and the startup log says which it uses.

`ETHROUNDTRIP_CONFIG` relocates `config.env`. Everything in that file can be overridden by
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
`patch` for fixes and cosmetic changes only — not `patch` out of habit. That is the
default to propose; when the user names the number, use theirs (2.1.1 added a
column as a patch, by their call).

**At most one bump per calendar day**, patch or minor alike. Before any `npm version`,
look at the date on the newest `CHANGELOG.md` heading: if it is today, a release
already went out, so the new entries go under that heading and the number stays as
it is — even when asked for the next one; say so instead. A second bump made the
same day is undone with `npm version <that day's number> --no-git-tag-version` and
its notes merged into that day's section. (cbBTC went out as 2.1.8 and Morpho as
2.1.9 on 2026-11-20; the user had them folded into one 2.1.8.)

Work is committed straight to `main` and pushed: production deploys by pulling `main`
on the VPS, and there are no pull requests.

`NEXT.md` lists what is left to do on the VPS after a release (nginx, BotFather,
checks) and what to build next. `.gitignore` names `next.md` for personal notes, which
on a case-insensitive Mac matches it too, so it was force-added; edits to it are
tracked as usual. Keep it current when a release leaves a step for the VPS.

The old Aave Loop name is gone from the code except `~/aaveloop-backups`,
`backupDatabase.sh`'s default destination, kept on purpose so existing backups and
cron lines stay valid. The first name, myAave, survives only as fallbacks and in
`data/myaave.db`, the ledger's file, kept so no install has to move it:

- Settings are `ETHROUNDTRIP_*`, read through `setting()` in `env.js` (server-only),
  which falls back to the old `MYAAVE_*` name when the new one is unset or empty, so
  a service file written before the rename keeps working; the startup log names any
  old ones in use. The shell scripts read them in the same order. Read a new setting
  through `setting()`, never `process.env` directly. `scripts/check-server.mjs`
  blanks every `MYAAVE_*` from the developer's shell for that reason.
- Browser storage is `ethroundtrip-*` (`stored`/`store` in `public/app.js`, and the
  theme in `public/theme.js` and both landing scripts): read under the new key, then
  the old `myaave-*` one, and saved under the new key with the old one removed.
- The package is `eth-roundtrip`.

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
the asset - ETH, cbBTC, WBTC, SOL or PSOL - sell it, repay), each with its own date and amounts,
all denominated in `borrow_currency`, which is always a stablecoin. Everything is
reported in USD.

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
reads two ways. `/holding` lists only trades still holding their asset (`ethHeldNow`), a
part-sold one with what it kept; a trade sold in full and not repaid is open (the
tile and `/summary` count it) but not in `/holding`. It takes the price of the
trade's market (`priceFor`) and today's rate per coin as arguments rather
than fetching them, which is what keeps it in `lib/`. It is the one place an open
position is marked to today's exchange rate; `derive`'s own figures never are.

`lib/input.js` is the forms' input half - `sanitizeNumeric`, `validateField`, the field
labels - out of `public/app.js` so it can be checked; like `lib/csv.js` it imports
`calc.js` and nothing else, and keeps no DOM.

`lib/address.js` reads a wallet address for the Wallets tab (`parseAddress`, `walletNameError`)
on both sides, and like `calc.js` it imports nothing. That is why it carries its own
Keccak-256: EIP-55's checksum needs it, Node's crypto has only SHA3-256 (other
padding) and the browser neither. Mixed case that misses its checksum is refused, not
corrected; one case is accepted and stored checksummed.

`lib/statement.js` writes the Stats Statement button's PDF by hand - no library, so
nothing is bundled and the CSP is untouched - from the same `summaryReport` the Stats
view calls, over the year's **closed trades only** (`closedTrades`, by `isRealized`):
it is a closing statement, so an open position is in no figure on it. It imports
`calc.js` and `lib/logo.js`, the logo's PNG data written by `scripts/make-logo.mjs`
(rerun it if `public/ETHRoundtrip_logo_96.png` changes; the checks fail until you do).
It is one A4 page by construction (a year has at most 12 months, drawn in two
columns of six, `CURRENCIES` 5 coins and `ASSETS` 5) and throws rather than draw past
the bottom margin, so a layout change that overflows fails `npm run check`; the
fullest year, all five assets included, leaves about 7.5pt (rows of 14pt for currencies
and assets, 13pt for months, since SOL and PSOL ran it 15.5pt past at 17pt). It is ASCII throughout - text beyond it as octal
escapes, the logo hex-encoded - so the xref offsets are string lengths.

`env.js`, `fx.js`, `prices.js`, `db.js`, `telegram.js`, `config.js`, `alerts.js`, `bot.js`,
`report.js`, `etherscan.js`, `chainnode.js`, `solana.js` and `format.js` sit at the root **because they are server-only** — the
browser is served `lib/` wholesale. `format.js` duplicates some of `public/app.js`'s
formatters on purpose: the browser's escape their output for `innerHTML`, which would
be wrong in a Telegram message.

### Two instances can share one database

`runETHRoundTrip.sh` replaces an earlier copy started from the same folder (matched by
its physical working directory, on the port asked for or one it moved to, with 14 s to
shut down: the server waits up to 12 s for an alert send), but moves to the next free
port when anything else holds it, and a copy started by hand (`PORT=3011
npm start`, a second checkout pointed at the same `ETHROUNDTRIP_DB`) runs beside it. So
concurrent access is a supported state, not an edge case. Production runs one
copy; this is mostly a dev-machine state, but the code holds for both - **as long as
both copies run the same version.** An older copy does not know a newer asset and
`assetOf` reads it as ETH: 2.1.8 on a 2.2.0 database closed every armed WBTC alert as
"off market" the moment it started, and its page would save a WBTC purchase back as
ETH. Nothing in the newer code can prevent it, so a release that adds an asset or a
market leaves a warning in NEXT.md (never run the older version on that database,
never restore a newer backup onto an older install). This is why:

- alerts are claimed with a conditional `UPDATE ... WHERE id = ? AND status = 'armed'`
  before the message is sent, so of two processes exactly one gets `changes === 1`;
- the Telegram bot takes a **lease** in `bot_state` (only one caller of `getUpdates`
  may exist), and an instance without it never touches the network;
- a partial unique index allows one *armed* alert per trade;
- an armed alert whose trade no longer holds ETH, or whose goal is in another market
  than its trade's now (`ALERT_OFF_MARKET`, built from `ASSET_META`), is closed by
  `closeUnwatched()`, a conditional `UPDATE ... WHERE status = 'armed'`, run after a
  trade edit, at startup and at the top of every sweep — the sweep is what catches the
  other copy's edits, and an alert put back by a failed send after its asset changed;
- a `PATCH` writes only to the row it read (`WHERE id = ? AND updated_at IS ?`) and
  works the edit out again from a fresh read when the other copy got there first,
  because the rate lookup in between can take seconds; three misses answer 503;
- an alert's failed sends are counted in SQL (`attempts = attempts + 1`), never from
  the row the sweep read at its start;
- "held" for alerts is one SQL predicate, `HOLDING` exported from `alerts.js`, used by
  the sweep and `closeUnwatched`; it must ask what `stages()` asks (bought, sale
  incomplete, **not repaid**) or a trade `derive` calls CLOSED is alerted on. Any
  sale closes an alert. `/holding` and `holdingCount()` ask `ethHeldNow` instead,
  so a part-sold trade still counts as holding what it kept;
- Delete all alerts sends `?through=<newest id shown>` and the server deletes only up
  to it, so a goal set from elsewhere since the page read its list is not deleted
  unseen;
- both copies run the hourly rate refresher (`startFxRefresher` in `fx.js`), which
  is harmless: the backfill re-reads each row and writes the same rate, in an
  immediate transaction so it waits on the busy timeout instead of failing at once;
- cache reads and writes in `fx.js` / `prices.js` swallow database errors — a statement
  can be refused while the connection is open, and a cache that cannot be read is a
  miss, not a failure.

### How an alert's send can fail

`telegram.js` answers every send with `{ ok, retryable, setup, notSent }`, and `alerts.js`
treats the three failures differently. **Retryable** (5xx, 429, a timeout) puts the
alert back to armed and counts a try; three end in FAILED. **Setup** (401, 403, 404,
or a 400 naming the chat or the bot's rights - "not enough rights", "have no rights to
send", "need administrator rights") puts it back without counting, because
fixing `config.env` or the group cures it. A send that fails after a newer goal was
saved meanwhile is closed as FAILED with "Replaced by a new goal", as one replaced
after its failure is (`backToArmed`, `failReachedArmed`). **notSent** (connection refused, no DNS, no
route: the request never reached Telegram) also goes back uncounted; a timeout still
counts, because that message may have arrived. Anything else is a refusal of the
message itself and is final. A 200 whose body is not Telegram's JSON (a portal's
page, a cut-off reply) is an unknown outcome and **retryable**, like a timeout. An
armed alert with `fired_at` set has already reached its goal and is sent on the next
sweep whatever ETH costs - at a fresh price when there is one, otherwise at its
`fired_price`, worded "at" and "Worth then" rather than "now" (`alertMessage`'s
`when`); a goal saved afresh has none, and saving a new goal over it closes it as
`failed` with its reason rather than deleting it. The Alerts table's Fired at reads `firedAt`, not the status, so
such a row shows when and where its goal was reached.

`marketPrices` falls back to the cache whatever its age when the service fails, so
`freshPrice(quote)` (`alerts.js`) is the gate: a fresh goal fires only on a price
under two refreshes old - an age that is not a finite number (`ageOf`'s Infinity for
a fetch time ahead of the clock) is not fresh - and a goal saved meanwhile takes its
direction from the purchase price. `/api/prices` and `/api/alerts` send `stale` as
that same test, so the alert window shows such a price with its age, never as "now".
Goals are stored to the cent (`asPrinted`), the figure every view prints. Shutdown
waits for a sweep in flight (`alertSweepDone`, up to 12 s) before closing the
database, or a claimed alert stays `fired` though its send failed; `stopAlertPoller`
sets `stopping`, so a sweep claims nothing new once shutdown begins, and `fire` looks
a euro trade's rate up *before* its claim, so only the 10 s send is left to wait for.
`scripts/check-server.mjs` drives each path against a mock Telegram.

`/watch` stores the chat that sent it (`bot_state.watch_chat`) and the timer reports
there, falling back to the group if that chat is no longer in the config; a report
is skipped, not stopped, while `holdingCount()` is 0. `/unwatch` is exempt from both
the age limit and the ten-per-batch cap. A batch's offset is written before it is
answered, so `stopBotPoller` puts `next_offset` back to the first command not yet
answered (`rewindUnanswered`, before the lease is released) and Telegram hands the
rest out again after a restart; the one in flight may be answered twice.

### The frontend

`public/app.js` is the whole interface: template literals rendered into mount points
with `innerHTML`, one delegated `click` listener on `document.body`, no framework.

- **Anything from outside goes through `esc()`.** `fmtDate` escapes its own output, so
  double-escaping is also a defect.
- **Views are history entries.** A nav click to another view pushes `#view`
  (`setView`), and Back and Forward arrive as `hashchange`, drawn by the same
  listener as a typed hash; an old `#summary` is rewritten in place. A new way to
  change view should go through `setView`, not write the hash itself.
- **Focus survives a redraw.** A container redrawn under the user's hands - the hero
  and the Net gain cells on every price - goes through `setKeepingFocus`, which puts
  focus back on the same control in the new markup: by its keys (`focusKeys`: id,
  data-*), else by its kind and place within the nearest row or card that has keys
  (`focusPlace`), else on what stands in for it there (`data-focus-default`: a
  stage card's magnifier, hash link or paste button), else on the control that opens
  that place (`aria-controls`: a Stats card's fold button), and only then by its index in
  the whole container. Give a control that can come and go a data-* key of its own.
  A control that is busy stays focusable (`aria-disabled`, not `disabled`), or focus
  falls to the page. The scan report waits for an open question (`dialogFree`)
  rather than taking the shared window from it; a control focused on purpose goes
  through `focusInView`, which keeps it clear of the sticky header
  (`scroll-padding-top` on the page, from the measured `--header-h`).
- **Sequence guards.** `loadSeq`/`writeSeq` (and `alertLogSeq`/`alertWriteSeq`) drop a
  reply that a newer load overtook or a write superseded. Any new fetch that writes
  into `state` needs the same treatment.
- **`state.loaded`** is false until the first `loadTrades` lands; until then `trades`
  is empty because nothing was read, and views draw `LOADING`, never counts or an
  empty-ledger message. A new view, or a function that redraws one directly, needs
  the same guard.
- **Field errors** go through `showFormError`/`clearFieldError`, which find the field
  with `fieldWrap` and its control with `fieldControl`, set `aria-invalid`, and write
  into the hint line `field()` ties to the control by `aria-describedby`.
  `refreshHints` swaps any field marked invalid for its saved value, so no hint is
  worked out from a rejected figure, and `showFormError` reruns it (`rehint`) once a
  field is flagged. The flag survives a redraw (`captureDraft` keeps `flagged`) and
  an asset pick (`applyAsset` judges the field again in the new asset's words).
- **`captureDraft`/`restoreDraft`** keep a half-typed stage form alive across
  re-renders. A change that re-renders the table must not discard it.
- **Submit locks are per form**, keyed by what the form saves (`submitKey`), so a
  re-render mid-request cannot reopen one and one form saving never blocks another.
- **A stage save says what it saw.** Opening a stage form snapshots the trade
  (`state.editing.base`); the save sends `base`, what its fields held then
  (`baseOf`), and the server refuses with 409 when one of the fields it writes has
  changed since (`changedSince`), answering with the row as it now is. Field by
  field, never `updated_at`: the server writes rows itself (the rate refresher), and
  an edit to another stage is no conflict. The page then redraws the card, keeps the
  typed figures, and stands the form on the new row, so a second Save replaces the
  change knowingly. A PATCH with no `base` is not checked.
- **Currency is a custom combobox** (`coinSelect`), not a `<select>`: the value lives
  in a hidden `borrow_currency` input, a pick fires `input` on it, and code that sets
  it directly must call `syncCoinSelect`. `CURRENCIES` is the picker's order and
  `CURRENCIES[0]` is a new trade's coin (`unitOf`). Its list is `position: fixed`
  because the trades table's scroll wrapper clips anything positioned inside it.
- **The platform picker is the same combobox** with `kind: 'platform'` (`FACES` picks
  what it draws). On a new trade it sits in the card's heading, outside the form, and
  its hidden input joins the form by `form="borrow-form"`; `fieldWrap` finds a field
  tied in that way (`data-field-of`). It starts empty: the platform is required and
  never guessed.

### Wallets

The Wallets tab (`#wallets`; `#settings`, its first name, is an alias) keeps the
wallets trades are run from in `wallets` (db.js): a required name, unique in any case,
and an address, unique per `network`: Ethereum, Base, Arbitrum, Optimism or Solana
(`NETWORKS` / `NETWORK_META` in `lib/address.js`, with each EVM chain's `chainId` and
every chain's explorer URLs, Solscan for Solana; `networkOf(w)` reads it, Ethereum for a
row that names none). `parseAddress(raw, network)` stores an EVM address checksummed
and a Solana one (base58, 32 bytes, `base58Length`) exactly as typed; `parseTxHash`
likewise lowercases an EVM hash and keeps a Solana signature's case. **Never fold a
Solana value to lowercase**: its capitals are part of it, and a lowercased signature
names no transaction (`foldFor` in etherscan.js compares EVM values folded, Solana's
exactly). The Add form reads the address for the chain picked, or by its look (0x or
not) while none is. The Add form's chain picker starts empty and is required, as the new
trade's platform is; the API takes an absent `network` as Ethereum for older callers.
The same address on two chains is two wallets. The API refuses changing an address in place: it is what trades are
linked by. Every write is an immediate transaction, so its duplicate checks and the
write hold the lock together. The Add form sits outside `#wallets-mount`, so the
redraw a price triggers cannot wipe it, and a rename being typed lives in
`state.walletRename` for the same reason.

Stats' By wallet is `summaryReport().byWallet`, keyed by `wallet_id` (a row for none),
ordered by name on the page; it shows only once a trade on the tab names a wallet. The
CSV's `wallet`, `wallet_address` and `wallet_chain` come from a `walletOf` callback the
page passes (`csvWallet`), as `lib/csv.js` holds no wallets.

A trade names its wallet in `trades.wallet_id INTEGER REFERENCES wallets(id)`:
optional (NULL is none, never guessed), with no ON DELETE action, so with
`foreign_keys` on a wallet in use cannot be deleted. `DELETE /api/wallets/:id` refuses
it first with a 409 naming the trades; a foreign-key error from the other copy acting
in between is answered 409 too, never 500. `normalise` takes `wallet_id` as a whole
number of a saved wallet or blank (`walletIdIn`), and a conflict on it names the
wallet, not the id. The page reads the wallets at boot (`loadWallets`), since the
Borrowed cards name them (`walletCell`) and the pickers offer them (`walletChoices`,
the `wallet` kind of `coinSelect`): after the platform in the new trade's heading
(`walletHeadPicker`, left out while none is saved) and in the Borrowed editor.
Wallets > Onchain Data (`renderOnchainData`, drawn by `renderWalletsView`; it was
first called Simulation, and its `sim`-prefixed classes, attributes and state keep
that name) groups every
trade under its wallet, then No wallet, in the Trades table's order, with each
group's figures from `summarize` and `openGainsUsd` over its trades alone. Its rows
are `tradeRow(..., { readOnly: true })`: `.row-static`, never `.row` or `data-trade`,
because the body's click handler opens any `.row` and would expand the trade on the
Trades tab. Every trade's row there - open, holding or closed - opens by its own
`data-sim-trade` and `state.simOpenIds` into slim cards (`simStageCards`): a recorded
stage (`STAGE_DONE`, read off `derive(t).stages`) with a magnifier that finds its
transaction, one still to come as "Not yet." Get onchain data searches the same
recorded stages of every trade with a wallet.

### Transactions on Etherscan

A Solana wallet is read from a Solana node instead (`solana.js`): Helius's with
`HELIUS_API_KEY`, or any `SOLANA_RPC_URL` (`solanaNode` in config.js), plain JSON-RPC -
`getSignaturesForAddress` paged back from now to the window, then `getTransaction` for
each successful one in it, kept for good. Each transaction becomes Etherscan-shaped rows
of the wallet's net change per mint (`pre/postTokenBalances` by owner) and of its SOL
(`native:sol`: lamports with the fee put back; under 0.01 SOL is rent or a tip and
dropped), so `candidates`/`pick` match Solana as they do EVM. Mints (`STABLE.solana`,
`ASSET_TOKEN.solana`, SOL as native or wSOL) were read on chain. No key is `setup`; a
401/403 is `setup`, a 429 is retried twice then `busy`.

Every EVM search is asked of Etherscan's V2 API with the wallet's chain (`chainid`), using
that chain's contracts (`STABLE` / `ASSET_TOKEN`, per chain; a rollup's USDC is the
native and the bridged one); block and transfer caches are keyed by chain. The free
plan answers Ethereum and Arbitrum and refuses Base and Optimism ("Free API access is
not supported for this chain"): that is `kind: 'unsupported'`, remembered per chain for
an hour (`UNSUPPORTED`), said on the card with the explorer to paste from, and counted
per chain by Get onchain data, which carries on. Those two chains are read from a node
instead when one is set (`chainnode.js`, `nodeUrl` in config.js): `OPTIMISM_RPC_URL`,
defaulting to mainnet.optimism.io, which serves old blocks with no key, and
`BASE_RPC_URL`, unset by default because no free keyless node serves Base's history
(mainnet.base.org refuses log queries, publicnode wants a token for old blocks, others
cap a query at 50 blocks or sit behind a bot check). A node is asked plain JSON-RPC:
the block for a time is searched for by the times around it (Base's blocks went from 2 s
to 0.2 s, so never worked out from a block time; interpolation alternates with halving,
which interpolation alone needed 118 calls for on that history), a range is always
[first block at or after its start, first block past its end - 1] because Base's blocks
share whole-second timestamps five at a time, Transfer logs come in spans the node
allows, halved when refused, and are returned as Etherscan's rows so the matching is
shared; each UTC day of a wallet is read once and kept (`nodeDays`). A node needs no
Etherscan key, and its URL, which may carry a token, is never echoed. Base's and
Optimism's contracts were checked against the contracts themselves (`symbol()`,
`decimals()`); Blockscout's API sits behind a Cloudflare challenge and Routescan does not
carry these chains.

`etherscan.js` (server-only) finds a stage's transaction as the ERC-20 transfer of the
trade's stablecoin into the wallet (loan, sale) or out of it (purchase, repayment), in
the stage's days ±1 (the typed date is local, the chain UTC), within 1% of its amount:
one `account/tokentx` over the wallet between two blocks looked up by time. **A token
is matched by its contract, never its symbol** - wallets are sent fake same-named
tokens (address poisoning). Ranked by amount (within 0.05% or a cent is exact), then
for a purchase or sale by the asset leg of the same transaction (WETH, cbBTC, WBTC)
against the typed quantity; still tied, the loan is the last before its purchase, the
repayment the first after its sale (`ANCHOR`), and a hash another trade holds for that
stage is never offered - at any stage: a transaction is one stage of one trade, and
another trade's purchase was offered as a repayment when only the same stage was
excluded. Nor is the trade's own hash at another stage (`ownElsewhere`): its purchase was
stored as its repayment when no plain repayment transfer existed. A paste may still name
one transaction for two stages. A loan or repayment never counts a transaction that moves the same coin back
the other way (a USDC to USDC.e swap on a rollup), and one that also moves the asset
ranks after a plain transfer. The purchase or sale it is settled against is the trade's own
*pasted* hash when it has one; otherwise it is worked out again, and a guess passes
its doubt (`others`) on to the loan, since a searched hash's doubt is not stored. So
`txBasis` of the loan and repayment includes their anchor's fields, and pasting or
forgetting a purchase or sale forgets the searched loan or repayment found by way of
it (`dropDependent`). All three rules were needed on the first real wallet: two loops one
evening each borrowed and swapped exactly 30,000 EURC. The key is `ETHERSCAN_API_KEY`
in config.env (`etherscanKey` in config.js), never sent to the browser and redacted
from every message; calls are queued 400 ms apart (the free tier allows 3 a second)
and retried twice on its rate limit; settled block numbers are cached for the
process and a window's transfers for two minutes.

A failed search carries a `kind`: `setup` (no key, the key refused), `busy` (rate
limit, daily limit, timeout, no answer, not Etherscan's JSON) or `unsupported` (a chain
not covered, or a coin with no contract on that chain); a stage simply not found
has none, and Get onchain data counts `unsupported` as not searched. A refused paste's
reason is kept in `state.txPasteError`, as a typed hash is in `state.txPaste`, so a
redraw draws it again. **Get onchain data** (`scanOnchain` in public/app.js) drives the bulk search
from the page, one stage at a time through the same find endpoint (`searchStage`, which
moves no focus): a `busy` stage is waited out 10 s then 30 s (`SCAN_WAITS`), and a
chain still busy after that, or `setup`, is skipped for the rest of the scan
(`closedChains`) while the others carry on; only the ledger's own server not answering
(`ledger`) stops it. The report says which. The server's
queue keeps it on the free tier; the page only adds patience.

Found or pasted hashes live in `stage_tx` (db.js), one per trade and stage, so a
stage is searched once. `POST /api/trades/:id/tx/:stage/find` answers a stored hash
without searching, stores a found one only if the trade's `txBasis` fields are as the
search read them, no other trade took that hash meanwhile, and a loan's or
repayment's pasted anchor is the one it was settled against (re-read inside the
immediate transaction, then searched once more: two magnifiers pressed together linked
one loan to two trades, and a purchase pasted mid-search left the loan of the guessed
one beside it), and answers 200 found or not (the card shows why; the page keeps that
note only while the trade's `txBasis` fields read as searched, `txNoteOf`). A PATCH that
changes a stage's date, amount or quantity, or the trade's wallet, coin or asset,
deletes that stage's searched hash in the same transaction; a pasted one (`PUT`) is
kept - unless the trade's wallet moves to another chain, or to none, which deletes them
all: a hash is a transaction on one chain. A paste needs the trade to have a wallet.

`scripts/audit-hashes.mjs` checks every stored hash after the fact: it fetches the
transaction's receipt (Etherscan's proxy calls, or the node; `txTransfers`) and judges it
by the search's own rules (`auditStage`): succeeded, moves the coin the right way for
about the amount, a loan or repayment is no swap within the coin nor a purchase or sale,
a purchase or sale moves about the typed quantity, dated within a day
(`withinStageDays`, which the search's candidates are held to as well - its window reaches
a loan out to its purchase's day only to settle ties). A hash several trades hold stays
with the one it fits best (OK over CHECK), the rest WRONG, equal fits all CHECK; a stage
no longer recorded is WRONG, a coin with no contract on the chain unchecked. It opens the
ledger read-only; `--apply` forgets the WRONG *searched* hashes in a conditional delete,
and reports pasted ones only. A PATCH that undoes a stage deletes its hash, pasted too. It exists because hashes stored before
a matching rule was tightened are never looked at again. `scripts/check-server.mjs` mocks Etherscan on loopback.

### Platforms

`PLATFORMS` / `PLATFORM_META` in `lib/calc.js` are where a trade ran (`aave`,
`etherfi`, `morpho`, and Solana's `jupiter` and `kamino`), stored lowercase in `trades.platform`. The API requires it on a new trade
and refuses to blank it; the column is nullable because a trade from before it was
asked for has none, which shows as not recorded, never as Aave.
`scripts/set-platform.mjs` fills those in (dry run unless `--apply`). Stats splits by
it through `summaryReport().byPlatform`, built by the same `groupBuckets` loop as
`byCurrency`, with a not-recorded row so the rows still add up to the totals; the
per-platform Performance cards are `summaryReport` over that platform's trades, so a
new platform needs only its `PLATFORM_META` entry, a logo in `public/` and its id in
`PLATFORMS`. `/holding` adds a line per platform under its totals (`holdingText`),
each gain summed in cents as printed so the lines add up to Unrealised, and only when
the held trades span two platforms or more; then, by the same rule and after a blank line,
a line per wallet (by name, No wallet last). Its table gains a wallet column (the name
from a join on `wallets`, cut to 12 characters) once a held trade names a wallet. Those
summary lines are the only part of the head that grows with the ledger, so they are kept
only while the whole table fits beside them under Telegram's 4,096: wallet lines go first,
then platform lines, and only then is the table cut (`fit`). The Performance cards
and the breakdown tables fold (`collapsibleCard`, keys in `FOLDING_CARDS`),
start closed, and keep their open/closed state in localStorage (`ethroundtrip-stats-open`).
Wallets' Addresses card folds by the same key list (`addresses`), but its markup is
in `index.html`, so `syncAddressesFold` puts the saved state on it at boot.

### Assets and markets

A trade buys ETH, cbBTC, WBTC, SOL or PSOL: `ASSETS` / `ASSET_META` in `lib/calc.js`, stored lowercase
in `trades.asset`, `NOT NULL DEFAULT 'eth'` because ETH was the only choice before it
(a fact, unlike the platform). `assetOf(t)` reads it, ETH for a row that names none.
`buy_eth` / `sell_eth` and `derive`'s `ethHeld` / `retainedEth` / `costOfSoldEth` keep
their names and hold units of the trade's asset; the CSV heads them `buy_qty` /
`sell_qty`, and the swaps' "Costs & Fees" (`buy_gas_usd` / `sell_gas_usd`, gas plus
the DEX fee) `buy_swap_cost_usd` / `sell_swap_cost_usd`. `ASSET_META.dp` is how a quantity prints (4 for ETH, SOL and PSOL, 8 for cbBTC and WBTC), and
every "as printed" sum of quantities (`/holding`, `/summary`) uses it per asset and
never adds two assets together. A sale is partial only if it is under 99.99% of the
purchase (dust left behind is a full exit, its whole cost taken off; deliberate since
v0.0.2) and what it keeps prints as more than zero to those places: `derive`'s
`isPartialSale` compares Bought and Sold as printed (`qtyAsPrinted`), and `retainedEth`
after a partial sale is their printed difference, so the card's lines add up. Of 0.3 sold
0.29996, 0.00004 ETH kept is a full exit, 0.00004 cbBTC a holding; of 1 cbBTC sold
0.99996, the 0.00004 kept is within the 0.01% and a full exit too.

Prices are per **market**, not per asset: `MARKETS` is `['ETH', 'BTC', 'WBTC', 'SOL', 'PSOL']`,
cbBTC's `market` is BTC and WBTC's is WBTC, its own price (`wrapped-bitcoin`), so a
WBTC that drifts from bitcoin shows; PSOL (Phantom Staked SOL, `phantom-staked-sol`)
is likewise its own. Only `TICKER_MARKETS`, BTC, ETH and SOL in that order, are shown
for themselves - the header's ticker (three compact rows inside the 58px header),
`/price`, `/watch` - by the user's choice; WBTC's and PSOL's prices are fetched to
value their trades and alerts. Sentences that list them come from `ASSET_WORDS`,
`TICKER_WORDS` and `PLATFORM_WORDS`. `prices.js` (was `eth.js`)
fetches every market in one CoinGecko request,
reads each coin by its id, and caches a row per market in `market_price` (which
replaced the single-row `eth_price`, left in place for an older copy). A partial
answer caches what came back without the cooldown, so a missing BTC never holds ETH
back; a coin left out counts as asked (`missingAt`) for as long as the caller would
accept a cached price, so it costs one request per window, not one per caller.
`priceStatus().lastError` joins every market's problem; `problems` keeps each one
under its market, and a message about some markets quotes only theirs - `/price`
once explained a missing BTC with WBTC's problem too, under a reply that never
shows WBTC. The
page's `adoptQuotes` judges "newer" by the server's clock (`fetchedAt + ageMs`), so a
quote stamped ahead of it cannot freeze the banner. Callers pass a `{ ETH, BTC, WBTC }` map (`openGainsUsd`, `holdingText`) and pick a
trade's price with `priceFor(t, prices)`. An alert's goal is a price of its market,
stored on the alert (`alerts.market`, NULL = ETH); a PATCH that changes the asset
closes the armed alert in the same transaction, and the sweep skips any goal whose
market is not the trade's. The alert window sends the market it was drawn in
(`data-market`), and the save and preview refuse a goal in another market than the
trade's now, so a window left open across a change of asset cannot arm one. The asset picker sits in the Bought card's heading and
joins the stage form by `form=`, as the new trade's platform does; `applyAsset`
redraws the form's fields for a pick. Stats' By asset is `summaryReport().byAsset`,
with a row for loans that bought nothing yet. The Statement PDF draws it as a second
section of its By currency card ("By currency and asset"), which costs less than a
card of its own; a closing statement has no nothing-bought row.

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
  `summarize`, `summaryReport`, `openGainsUsd` and `/holding` (`report.js`) then adds
  `cents(v)`, never raw floats, so By month closed and By currency add up to Realized
  net gain, and the CSV writes amounts and fees as printed too (`money` in
  `lib/csv.js`), so its columns add up across a row; every number there is written in
  plain digits (`plain`), never in exponent form. Rounded only at the end, cards
  missed their result by a cent on a quarter of euro trades and totals their rows on
  nearly half of random ledgers. The open-position estimate is built the same way,
  term by term as the alert prints them (worth, cost with the currency move, interest,
  fees; `unrealisedUsd`/`markedUsd` and the sold path), so an alert's lines add up to
  its Gain. New figures follow the same rule.
- **A figure and its label must describe the same thing.** A number that is
  arithmetically correct under a label describing something else is a bug here.
- **Exchange rates are resolved server-side and never accepted from a request.** A
  caller that could post its own rate could move every dollar figure in the ledger.
  A rate published more than six days before its day (`MAX_RATE_LAG_DAYS` in
  `fx.js`) is no answer, and a stand-in (a rate from before its day) stays open to
  the hourly refresh until the cache has settled its day (`standInOpen`), not only
  for the four days it is marked provisional.
- **Every figure has the same ceiling, `FIGURE_MAX`** (a trillion, in `lib/calc.js`),
  and an amount of the coin must print as at least 0.01; the server's `toNumber` and
  the form's `validateField` share both, as they share `priceInRange` (alert goals)
  and `unitPriceInRange` (what a purchase or sale implies per unit, against its
  asset's own `ASSET_META.priceRange`: ETH $1-$10k (ETH's highest is about $4.9k;
  at $100k it overlapped BTC's and kept a cbBTC quantity as ETH), cbBTC and WBTC
  $10k-$1M, SOL and PSOL $1-$1k, so a quantity typed for one asset and left after
  switching to another is refused; the form checks it again the moment the asset is
  picked, in `applyAsset`, which on a sold trade also draws the sale's quantity so
  both are re-read in one save).
- **A missing or old market price is said where the estimate is.** `priceNote` in
  `public/app.js` puts a "no price" or "old price" chip on a Net gain cell, and
  `openGainLines` a line under the header's estimate, from the quote's `stale` flag
  (`freshPrice`). WBTC needs it most: it has no ticker row to show its price.
- **Gas fees are dollars, one per stage.** The swaps' ("Costs & Fees (swap)", gas
  plus the DEX fee) are required on a purchase or sale being written
  (`checkSwapFee` in `server.js`); the borrow's and repayment's are optional.
  **Except on a Solana platform** (Jupiter, Kamino: `PLATFORM_META.chain`,
  `tracksGas(t)`), where gas is a fraction of a cent and is not asked for at all:
  `derive` counts no fee there (`feesUsd` null, `feesMissing` empty, `gasless`
  true), the forms draw the gas fields hidden (`data-gas`, toggled live by a
  platform pick, `syncGasFields`), the cards leave the rows out and the CSV leaves
  the columns blank. A fee stored before is kept, ignored, and counts again if the
  platform goes back to one that tracks gas. 0 is
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
  exactly that, in every browser without saved credentials. Keep a copy in `landing/`:
  the coin, platform (`aave.png`, `etherfi.png`, `morpho.jpg`, `jupiter.jpg`, `kamino.jpg`)
  and asset (`eth.png`, `cbbtc.png`, `wbtc.png`, `sol.jpg`, `psol.png`) marks are all
  copies, so a new platform or asset needs its logo copied there and named on the landing
  page. Opaque square art is drawn to fill its disc (`ASSET_META.fill`, SOL's). The social card (`og7.png`, drawn
  from `scripts/og.html` with headless Chrome) names the assets too; redraw it under
  a new name once production has served the old one, since scrapers cache by URL. `scripts/check-calc.mjs` reads every `src`,
  `srcset`, loading `<link>`, `og:image`/`twitter:image` and CSS `url()` of the public
  pages and fails on one outside `/landing/` (Google Fonts excepted) or not on disk.
- **Text can change freely; inline scripts cannot.** The landing page describes what
  `lib/calc.js` computes (net gain after interest *and fees*, partial exits, weekend
  rates), so a formula change may mean a copy change there too.
- **Inline scripts are admitted by hash.** nginx's Content-Security-Policy lists the
  SHA-256 of each inline script on `landing/index.html` and `landing/404.html`
  (`CSP_PINNED` in `scripts/check-calc.mjs`, two today); edit one and the browser
  silently blocks it until the user updates nginx. The ledger page has no inline
  script at all for that reason — its theme runs from `public/theme.js`.
- **nginx's config is shared with other sites.** The policy is one `add_header` in
  `/etc/nginx/sites-available/all-sites.conf`, which also holds UrlReporter's
  `script-src 'self' https://www.googletagmanager.com`. A command for the user that
  rewrites ETH Roundtrip's line must match only it - anchor it on its own first
  hash, as NEXT.md's step 2 does - or it rewrites that site's too. Have them back
  the file up, `nginx -t`, then reload; the live header can be read from here with
  `curl -sI https://ethroundtrip.com/`.
