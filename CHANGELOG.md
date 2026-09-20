# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [1.0.1] - 2026-09-20

Two lines on the landing page that were breaking in the wrong places.

### Fixed

- **The call to action wrapped with one word alone on a second line.** "The app is private and asks for a password. If you do not have one, ask." comes to 54ch against `.cta__sub`'s 52ch measure - a nineteen pixel miss, which left `ask.` stranded underneath. It is sized to its content now rather than to a reading measure. Widening the shared measure would have fixed it too, and would have been a number tuned to this exact wording that breaks again, silently, the next time the wording changes; `fit-content` caps itself at the container, so a phone still wraps it. The 404 page keeps the 52ch measure, because its copy is a paragraph to read rather than a line to act on.

### Changed

- **The hero subtitle breaks between its two sentences.** "Borrow a stablecoin, buy ETH, sell it, repay the loan." now ends a line, and what the app does with those four moves starts the next. The ledger's own hero has done exactly this, with the same sentence, since it had a hero.

## [1.0.0] - 2026-09-20

The first stable release.

Not a rewrite and not a feature: the version number catches up with what the app already is. Forty-one releases of building it, auditing it and fixing what the audits found - the last of them a pass over every source file in the repository. The schema migrates itself forward from any version that has ever existed, and the four figures the interface leads with come from the same `lib/calc.js` the server uses, so the page and the Telegram report cannot drift apart. From here the version means what SemVer says it means: a change to the API, the database or a stored figure is a major one.

### Changed

- **Ten rows a page, on both tables.** History and Alerts read the same `PAGE_SIZE`, so the two pagers cannot disagree about how long a page is. Fifteen filled a laptop screen and then some; ten leaves the pager visible without scrolling, which is the point of having one.
- **The Summary note is one sentence again.** The second paragraph - that a loan in another currency is converted twice, once at each end - explained a mechanism the figures already carry, on a page where four of the five currencies are pegged and most ledgers never convert anything. The sentence that remains is the one doing the work: what the figures are in, and where the rate came from. `.summary__foot + .summary__foot` went with it, since nothing can match it now.

## [0.0.41] - 2026-09-20

A recursive audit of every source file in the repository - 21 files, about 10,900 lines - excluding documentation, dependencies and the database. Three bugs, each reproduced before the fix and re-run after. The count is the finding: most of this tree came back clean, and two further suspicions were dropped once testing disproved them.

### Fixed

- **The landing page's calls to action answered with the 404 page.** All three "Use Aave Loop" buttons point at `/app`, and so does "Open the ledger" on the 404 page itself - but nothing served that path. In production nginx maps it to the ledger, so this only bites the no-proxy case, which is precisely the case the `/landing` static mount was added to support. The 404 page linking to a 404 is the part worth keeping in mind: the one page whose whole job is recovery had no working way out. `/app` now serves the same file the static mount serves at `/`.
- **The Telegram summary could report a blended rate of `-0.00%`.** `format.js` defines `signOf` for exactly this - take the sign from the figure as printed, so digits that are all zero do not carry a minus - and `usd`, `signedUsd` and `pct1` all use it. `pct2` was the one that did not, and it is the formatter "Blended annualized" goes through.
- **An alert could report `Gain: -$0.00`.** `alertMessage` built its own sign from the held value rather than using the `signedUsd` sitting in the module it already imports from. Reproduced with a goal a person could type: half an ETH at 3.1%, goal 24,207.91, which lands 0.001 below break-even. The live preview in the alert window is written by the same function, so it showed it too.

### Removed

- `PROMPTS.md`. The reusable audit prompts it held have been run enough times to have done their work, and the findings they produced are in the entries above rather than in the file.

## [0.0.40] - 2026-09-20

Eight bugs across the three views, each reproduced against a seeded ledger before the fix and checked after. Fewer than the passes allowed for, and the shortfall is the point: the Trades view had one left in it, not five.

### Fixed

- **A sold trade went on advertising a price alert nothing was watching.** `selectArmed` joins to the trade and requires it still be holding ETH, so recording a sale suspends the alert - deliberately, and the comment says so, since undoing the sale brings it back. But `armedAlerts`, which feeds the interface, has no such test: the Bought ETH card kept naming the goal, and the bell is hidden on a sold trade, so there was not even a way to clear it. The card now applies the test the bell already applied, which is `derive`'s own, so the two cannot drift.
- **The Alerts table called the same alert ARMED.** Verified against the database: with the trade sold the sweep selects nothing while the table still reads ARMED. It carries a "not watched" note now, in the shape the "not sent" note already uses, saying why and that restoring the trade puts it back under watch.
- **The bell and the Alerts table contradicted each other once an alert fired.** `loadAlertLog` refreshed the log and left `state.alerts` as the boot had it, so a tab open across a sweep showed FIRED in the table and a lit bell on the trade behind it. The log is a superset of the armed map, so the map is rebuilt from the same answer - no second request.
- **"Biggest loss" was a label the ledger had not earned.** It was chosen on `< 0` alone, which is wrong twice: a trade level to within half a cent is printed `$0.00` by the tile that calls it the biggest loss, and on a ledger with nothing closed the entry is null and the expression fell through to the loss label anyway - so a brand new ledger announced a biggest loss it had never had. Both pairs now agree with the digits beside them.
- **By currency: Avg annualized took its colour from net gain.** The same defect fixed in the Trades table in 0.0.39, noted then as out of scope, and this is its scope. A rate that rounds to 0.00% is no longer painted green by a dollar figure standing behind it.
- **By month: the share bar disagreed with the figure beside it.** The bar read the held value where the cell reads the printed one, so a month netting less than half a cent showed a flat `$0.00` next to a red sliver. The bar takes the same class, and `.bar__fill--flat` draws it neutral.
- **The rate banner said more than it meant.** "so it is left out of the totals below" is false of the borrowed totals: only the borrow leg's rate decides those, and a trade waiting on a later one is counted in both Total borrowed and the By currency column. It is the trade's *result* that is left out, and the banner and `TIPS.totalBorrowed` now say that.
- **`extremeCard` was dead.** Unreferenced since `perfExtreme` replaced it in 0.0.35, and still carrying the superseded pattern of colouring a rate from a dollar figure - a worked example of the bug above, sitting in the file waiting to be copied.

## [0.0.39] - 2026-09-20

Four bugs in the Trades view, each reproduced against a seeded ledger before the fix and measured after. A fifth candidate was dropped as unreachable rather than counted.

### Fixed

- **A figure too small to show carried a minus and a colour.** Sign and class were both read from the number as held, so a trade that came out level to within half a cent printed `-$0.00` in red - a loss, stated twice, on a trade that had not lost anything. Reproduced with a partial sale: 30,000 USDC at 4%, seven ETH bought, one sold for 4,482.97, repaid at 30,197.26, which nets -0.0043. `signedPct` and `pctClass` had said since 0.0.35 that the printed figure decides this; `usd`, `signedUsd`, `money`, `signedMoney`, `pct` and `gainClass` now share the one helper that says it.
- **Annualized took its colour from the dollar gain, not from the rate beside it.** A cent made on a 30,000 loan over sixty days is a real gain and a green `+$0.01` - but annualized it is 0.0002%, which prints 0.00%, and a row of zeros wearing a green is a claim the digits do not make. The column and the card row read `pctClass(d.pct)` now, which is the figure they show.
- **A saved stage did not follow its row to another page.** Adding a sale gives a trade a net gain it did not have, and under any sort but the default that can put the row on a different page; the toast said saved while the row and its open detail disappeared. Verified: with 23 trades sorted oldest first, moving one trade date to today sent it from page 1 to page 2, and the view now goes with it. `submitBorrow` has done this since paging arrived - editing never did.
- **The table pushed the whole page sideways on a tablet.** The eight columns need about 980px, and the card layout that replaces the table does not arrive until 760, so between those two the table was wider than the page: 982px inside a 705px card at 768px, an iPad held upright, dragging the header, hero and footer 252px with it. 0.0.34 saw this and left it, correctly noting that padding cannot close a gap that size - trimming it and letting the cells wrap still leaves 800px. The table scrolls inside its own card instead, only between 761 and 1080px. Above that the container is not created at all, because an unused `overflow` still clips, and a tooltip hanging under a cell would pay for it.

## [0.0.38] - 2026-09-20

A quality pass over 0.0.37. Four findings, every one in what that release added: two places where a single fact was written down twice, one awaited call that never needed awaiting, and three comments describing something other than the code beneath them.

### Changed

- **The version lifecycle stages what it changed, not a list of what it expected to change.** `package.json` named `public/index.html` and `landing/index.html` for `git add`, and `scripts/stamp-version.mjs` named the same two in `TARGETS` - so a third page that printed the version would have been stamped, logged as stamped, and then left out of the commit. That is the silently stale version the script exists to prevent, reachable again through the staging step. `git add -u` stages what the bump and the stamp touched, and it is safe precisely because `npm version` refuses to run on a dirty tree, so nothing else can be modified when it does.
- **The footer's version is no longer awaited before the ledger loads.** `boot()` held every other request behind `await api('/api/version')`, in a function whose own comments twice explain why the ticker and the alerts must not gate the trades. Since 0.0.37 stamps the number into the markup, that call only ever corrects a page served from an older build than the server it is talking to, and nothing on screen should wait on it. Measured on localhost: the four requests ran 32.5ms to 40.4ms in series and now start together at 31.5ms. Over a network it is a full round-trip.
- **`stamp-version.mjs` finds the pages the way the rest of the repo finds a file.** It resolved `public/index.html` against the working directory, where `server.js`, `config.js` and `db.js` all anchor to `import.meta.url`. npm runs lifecycle scripts from the package root, so it worked - but it was the one file in the project relying on that, and the one whose failure mode is a raw `ENOENT` thrown before its own error handling can say which pattern went missing.

## [0.0.37] - 2026-09-20

The note under the Summary says which figures were converted and which were never near a rate, and the app gets a link style of its own. Fourteen findings from a review of 0.0.36, every one reproduced before the fix and checked after.

### Fixed

- **The Summary note said every figure was converted at an ECB rate.** Splitting it in 0.0.36 dropped the six words that made it true - "Amounts in a currency other than the dollar are" - and four of the five currencies are pegged, where `rateOf` hands back a literal 1. On a USDC ledger, the default, not one figure had been near an exchange rate, and the sentence that follows told the reader such a loan was converted twice when it is converted zero times. Both are scoped again, which is how the README and the landing page had them all along.
- **The note said "for the day of each transaction" and linked somewhere to check it.** The ECB publishes on business days, so a Sunday trade carries Friday's rate - as `db.js` says, and as the banner at the top of the same view says when it calls a rate provisional. Following the link for a weekend date found no row. It now reads "or for the last business day before it".
- **The link's dotted underline is solid.** Dotted is `.th-tip`, which in this app means a header that explains itself and does not go anywhere; a dozen of those render in the Summary, and on a touch screen no hover told them apart. The underline is also drawn in `--text-muted` rather than `--text-faint`, which was 2.5:1 on the light background - under the 3:1 WCAG 1.4.11 asks of the one cue that identifies a link. Dark theme had always passed, so it looked right to anyone testing there.
- **The note announces that it opens a new tab.** `.sr-only` was already in the stylesheet doing this for the theme toggle.

### Changed

- **The note is two paragraphs, not one with a `<br />` in it.** The break only landed between the sentences while `max-width: 108ch` held the first one on a single line: two numbers in two files tuned to each other, with about eight characters of slack and nothing on the prose side pointing at the CSS. Rewording the sentence would have brought back the three-line paragraph the split was meant to fix. The measure goes back to 68ch, a number chosen for reading.
- **A base `a` rule.** The stylesheet had no generic link style - `a.brand`, `.nav__link` and `.footer a` all key on where the link sits - so the note's anchor got a fourth container-scoped rule that copied `.th-tip`'s declarations from 485 lines away. The next link a script writes would have needed a fifth. There is one rule now, and the container rules are all more specific and override it unchanged.
- **`npm version` stamps the version everywhere it is written.** It was hand-edited in `package.json`, `public/index.html` and `landing/index.html` each release, and the landing page is the one a visitor reads and the one with no runtime source to paint over a miss. `package-lock.json` had drifted 31 releases to 0.0.5, which an `npm install` on the server would have rewritten into a dirty checkout; it is back in step.

## [0.0.36] - 2026-09-20

### Changed

- **The note under the Summary links to the ECB's rates, and reads as two lines.** It named the European Central Bank reference rate without pointing anywhere, so the one thing it invites you to do - check a figure - needed a search engine first. The phrase now links to the ECB's euro foreign exchange reference rates page, which carries the day's rates and the CSV, XML and SDMX history together; the history is the half that makes a past transaction checkable. The explanation is split after the first sentence, so the consequence starts on its own line rather than trailing off the end of a paragraph.
- The link is **hung on the phrase that was already there**, unchanged: "European Central Bank reference rate" named the number before and names it now. What the anchor adds is a destination, and the destination is where these rates are published rather than where this app fetches them - the figures are ECB reference rates but the only lookup goes to a mirror. "Checked against the ECB's own tables" is the claim `db.js`, `fx.js` and the README already make, and it is the one that is true.

## [0.0.35] - 2026-09-20

What ETH costs, in the header on every tab, and a Performance card that ranks a gain two ways.

### Added

- **The ETH price in the header**, beside the theme toggle, with the 1h, 24h and 7d change beside it. The header sits outside the three views, so one ticker serves Trades, Summary and Alerts. It refreshes every five minutes, stops asking while the tab is hidden, and keeps the last figure it had when the price service cannot be reached rather than turning into an error message.
- `GET /api/eth`, its own route. `/api/alerts` carries the armed-alert map and the Telegram configuration and dropped the change windows before answering, so polling that to read one number was the wrong shape - the same argument that split the alert log out in 0.0.33.
- **The 1h window**, which did not exist anywhere before. `/coins/markets` takes it in the comma list the other three already use, so it is one more field on a call that was being made anyway: no second request and no second cooldown. `eth_price` gains a nullable `change_1h`, added by the migration that is already there for exactly this. 30d is still fetched and still reported by `/price` in Telegram; the ticker just does not draw it.
- **Biggest and smallest gain in %**, ranked on the annualized rate rather than the dollars, beside the two that already ranked on dollars. The two orders disagree, which is the point of showing both: a four day trade that made $75 can be the best return on the ledger and the smallest cheque on it at the same time.

### Changed

- **The Performance card is three tiles then four.** The general figures keep the first row; the second reads gain, loss, gain, loss, so the dollar pair and the rate pair sit one above the other and the same trade can be found in both columns.
- **Win rate is gone** from the card. `winRate`, `wins` and `losses` are still on `GET /api/summary`, because removing a tile is a display decision and an external caller should not lose fields over it.
- **"Biggest gain" and "Smallest gain" say in USD**, and both pairs still flip to "Biggest loss" once a losing trade exists - the card must not call the worst thing on a ledger the smallest gain.
- The two ranking tooltips said "Ranked by dollars made, not by the annualized rate", written to stop the rate being mistaken for the ranking key. Two tiles now rank on exactly that, so all four are rewritten, and the rate ones warn that a same-day trade is scaled to a full year from one day of capital and can post an enormous figure on a small gain.
- `MYAAVE_ETH_POLL_MS` overrides the ticker interval, as `MYAAVE_ALERT_POLL_MS` does for the sweep. Five minutes is a long time to sit watching a ticker to find out whether it ticks. The page refuses anything under thirty seconds whatever the server says.

### Fixed

Four found in the ticker after it was written, each reproduced before the fix and again after.

- **The header and the alert window could show two different ETH prices at once.** Opening the bell asks for a price no more than a minute old while the ticker settles for five, so the window read $3,333.00 with the header above it still reading $3,000.00 - and that window is where a goal is set against the figure. `/api/alerts` now carries the change windows too, so one answer feeds both and the newer of the two always wins.
- **The same figure was drawn in two colours.** A movement of -0.04% and one of +0.02% both print `0.0%`, and they sat side by side in the header one red and one green. The sign already came from the figure as printed - that is the rule 0.0.32 introduced for `-$0.00` - and now the colour does too: a movement too small to show is drawn flat, because it is neither up nor down.
- **The row could not be read out or copied.** The gaps between the price and the badges, and between each label and its figure, are drawn by flex, so the text itself ran together as `ETH: $3,000.001h+1.4%24h-1.5%`. The spaces are in the markup now; flex drops them on the way to the screen, so nothing moved.
- **Every switch back to the tab fired a request.** Ten alt-tabs in ten seconds were ten round trips - through nginx and basic auth on the deployed app - none of which could return anything new, because the server serves the same cached figure for five minutes. It asks on return only when the figure it holds is actually due.

## [0.0.34] - 2026-09-20

An audit of the three views. Nine findings, every one reproduced before it was fixed and again after: five in the Alerts view, two in the Summary and two in the Trades table. Nothing was invented to reach a number, and the Trades table's own count is two because that is what was there.

### Fixed

- **A deleted alert came back.** The Alerts view asks for the whole log on every visit, so one of those requests is in flight for as long as the round trip takes - and a delete landing inside that window was undone by the reply. The row reappeared, deleted from the database, and pressing Delete on it again answered 404, which this app reads as "already gone" and reports as a second successful removal. `loadAlertLog` now discards a reply a newer load has overtaken or a write has superseded, the guard `loadTrades` has carried since 0.0.20.
- **A message that never went could be filed as sent.** Claiming an alert is what unselects the bell, so the whole of a send - ten seconds, when Telegram does not answer - is a window in which the card offers to set a new goal on that trade. Setting one and then failing in a way worth retrying put the old alert back to `armed` beside the new one, which the partial unique index added in 0.0.33 refuses. The sweep caught the throw, and left the row marked `fired` with no error on it: an ordinary green FIRED in the Alerts view for a message nobody received, and every alert still to be checked in that pass skipped. Re-arming is now refused in the same statement when a newer goal is already watching the trade, so the row keeps its reason and shows the "not sent" note it should always have had.
- **One bad alert cost the whole sweep.** The `catch` that keeps an unattended pass from taking the process down also swallowed the rest of the pass, so anything thrown while sending one alert skipped every alert after it for the next quarter of an hour. Each one is now tried on its own.
- **The sweep and the page disagreed about what "still holding" means.** `stages()` calls a sale recorded only when the date, the amount and the ETH are all there, and the query asked about `sell_date` alone. A row carrying a bare sale date - which the API accepts, and which the sale form cannot produce - was therefore HOLDING to `derive`, so the bell lit and a goal saved, while the sweep never looked at it again. Both halves of the test are spelled out now, here and in the `/holding` report, which had the same clause.
- **On a tablet held upright, Delete was off the edge of the screen.** The "not sent" note sat beside the status pill and made Status the widest column in the table, which pushed the whole page sideways between the card layout taking over at 760px and a width that has room for it. The note goes under the pill, as the fired price already goes under the fired date, and the table's padding tightens in that band. The trades table is wider still at those widths; that is not new and every cell in it is text.
- **"Total borrowed" said it did not know.** It counts open trades as well as closed ones - its own explanation says so, and the Borrowed column below it and the Open positions tile above it both state the same money - but it was only shown once some trade had been repaid. On a ledger with capital out and nothing closed yet it was the one place on the screen calling that figure unknown. The same inconsistency 0.0.15 fixed in the arithmetic, left in the gate.
- **A zero was written two ways in one table.** *By currency* printed "0" under Closed and a dash under Open, side by side, for the same absence.
- **Escape in the price alert window threw away the form behind it.** The bell sits on the Bought ETH card while another stage of the same trade can be open for editing, and Escape closed the window and then carried on to the page's own handler, which discarded the edit and everything typed into it. The confirmation window has stopped the key for exactly this reason since 0.0.33; the alert window now does too.

### Changed

- **The expanded row names the trade's own id.** `#N` is the id everywhere else - the Alerts table, every Telegram message - and in this one place it was the row's position in the current sort, so one trade called itself #4, #9 or #2 depending on which column the table was ordered by. It reads `Trade #7 · row 4 of 10 · added 1 Aug 2026`, with the position said in words.

## [0.0.33] - 2026-09-20

An Alerts view, and a fired alert that is kept rather than overwritten.

### Added

- **An Alerts view**, third after Summary. Every alert ever set, newest first, fifteen to a page: the trade, the goal, which way it reads, its status, the day it was set and - for one that has fired - the date, time and price it fired at. Each row deletes, and **Delete all alerts** clears the list; both ask first, and the delete-all sentence names how many are still armed, because those are the ones whose deletion has a consequence beyond the list.
- **A fired alert is kept.** The bell reads only the armed alert, so it returns to unselected once the message has gone and a new goal can be set on the same trade - while the one that fired stays in the Alerts view. That was the point of the change: setting a second goal used to overwrite the only record that the first had ever fired.
- `GET /api/alerts/log`, `DELETE /api/alerts` and a `confirmDialog()` in a second `<dialog>`, which the Delete trade confirmation now uses as well. The app no longer opens a browser `confirm()` box anywhere.

### Changed

- **Alerts have an id of their own.** `trade_id` was the primary key, which was the whole of the rule that a trade had one alert. The table is rebuilt once on open - create, copy, drop, rename - detected by shape rather than a version number, re-checked inside an immediate transaction so two copies of the app booting together cannot both do it. The rule that a trade has at most one *armed* alert is now a partial unique index, which the sweep and the `/holding` report both depend on: each joins alerts by trade with no limit, so a second armed row would send one message twice and count one position twice.
- **The alert routes are scoped to an alert; the two trade-scoped ones moved** to `PUT /api/trades/:id/alert` and `GET /api/trades/:id/alert/preview`. Redefining `DELETE /api/alerts/:id` in place would have left a tab loaded before the upgrade deleting a different trade's alert and answering 204; this way it 404s.
- **The Performance card is six tiles.** Realized net gain and Blended annualized are the first two figures above the table on every view, so the card was stating them twice on one screen; "Of which currency" goes with them. What is left is the six that are only there.
- **The landing page hero carries the real logo** rather than a hand-traced glyph of it - the same drift 0.0.23 removed from the favicon. The 96px derivative, not the 1254px master, for a tile drawn at 46.

### Fixed

- **A failed send would have rewritten a trade's whole alert history.** The two follow-up statements in `fire()` were `WHERE trade_id` with no status filter - harmless while a trade had one row, and the moment history existed they would have put every fired alert on that trade back to `armed` and sent them all again on the next sweep. Both key on the alert's own id, which is also what the claim now locks on.
- **Two clicks on Delete in one tick left no confirmation at all.** `close()` queues its event rather than firing it, so the handler ran after the window had already reopened for the second question, wiped it and closed it again - no dialog, no message, nothing deleted.
- **Neither dialog ever cleared its markup.** Both leaned on the `close` event for that, and an engine need not dispatch it for a `close()` from script, so the goal somebody had typed stayed in the document after the window shut. Both clear on the way out instead, with the event kept as a second line of defence.

## [0.0.32] - 2026-09-20

An audit of every file. Twenty-two findings across twelve of them; `alerts.js`, `lib/calc.js` and both HTML files had nothing worth changing.

### Fixed

- **A Telegram 429 was filed as permanent.** Telegram rate limits a bot per chat and answers 429 when it wants you to slow down, which is the one failure certain to pass on its own. `sendTelegramMessage` classed anything under 500 as not worth retrying, so a flood controlled alert was left marked `fired` and the message was never sent. 429 joins 5xx as retryable.
- **`eth.js` threw from a function documented not to.** `cachedEthPrice` guarded `db.open` but not the statement itself, and the call sat outside `ethPrice`'s try, so a read refused while the connection was open - a second copy of the app checkpointing the same file will do it - rejected the promise. A cache that cannot be read is a cache miss.
- **A failed cache write threw away a good price.** The write sat in the same try as the fetch, so a refused `UPDATE` discarded a price already in hand, reported the whole attempt as a failure and put lookups to sleep for a minute. It is best effort now and the price is returned either way.
- **Four callers, four requests.** The alert sweep, the watch timer, `/price` and the alert window all call `ethPrice`, and nothing stopped two coinciding against a keyless service with a shared rate limit. One request is now shared by everyone waiting on it; measured at four concurrent callers, one HTTP request where there were four.
- **`fx.js` could walk from 1970.** `resolveRange` looped from `parseDate(fromISO)`, and `parseDate` answers null for anything it cannot read, which coerces to 0 in the comparison. The bounds are checked before the walk starts, and the loop uses the `DAY_MS` the rest of the file does rather than the literal beside it.
- **The rate cache could throw on the save path**, the same shape as `eth.js` above and fixed the same way.
- **`/api` exactly answered with the browser's HTML error page**, because the 404 handler matched only `/api/`. It is the path most likely to be typed by hand.
- **`n2` and `n4` returned the string "NaN"** when handed anything that was not a number, alone among the formatters, every one of which says "-" instead. That is the sort of thing that reaches a chat message unnoticed.
- **A figure too small to show still carried a minus sign**: `-$0.00` in red, and `-0.0%`. The sign now comes from the figure as printed rather than as held.
- **`.card--warn` coloured nothing.** A card draws its edge with a ring rather than a border, so setting `border-color` left the one state that rule exists to mark looking exactly like every other card. It is a ring now.
- **The bot sat on its lease after stopping itself.** A rejected token sets `running = false`, and `stopBotPoller` returns early on that, so the lease was left to expire - during which no other instance could take over and a restart with a corrected token had to wait it out.
- **Commands past the per-batch cap vanished silently.** Their offset had already been committed, so they were gone rather than deferred. Still dropped, but the log says how many.
- **`holdingMessage` and `summaryMessage` read the database outside any try.** Both answer a chat command, where silence reads as a broken bot; they now say the ledger could not be read.

### Removed

- The `/favicon.ico` route, which `express.static` had been answering two hundred lines earlier and which therefore never ran.
- `dataDir` in `db.js`, which created `data/` even when `MYAAVE_DB` pointed somewhere else entirely.
- `AMOUNT_FIELDS` and the `annualizedPct` import in `public/app.js`, the `n2` import in `report.js`, and `--mono` in the stylesheet: all declared, none read.
- A `padding-top` in the landing stylesheet overridden by the shorthand on the very next line, and a second `.step__body` block whose only job was to add a margin to the first.

## [0.0.31] - 2026-09-20

### Changed

- **`/summary` is a table rather than a paragraph.** Each label carries a colon and the figures line up under one another, which needs a `pre` block: Telegram draws message text proportionally, so the spaces that used to separate a label from its figure lined nothing up. The footnote about open positions counting every unrepaid trade is gone; it was a sentence of explanation under four numbers that do not need it.

## [0.0.30] - 2026-09-20

### Fixed

- **"No config.env yet" was also what a config.env nobody could read said.** `readFile` returned null for a missing file and for a refused one alike, so an install whose `config.env` was owned by the wrong user was told the file did not exist - six restarts running, while `Could not read config.env: EACCES` sat on a line of its own that nobody had reason to grep for. An unreadable file now says so, and says to check who owns it. The checkout belonging to one account while the service runs as another is an ordinary arrangement, and this is what it looks like when it bites.

## [0.0.29] - 2026-09-20

### Fixed

- **"send this to your Telegram chat on Telegram"** - the name of the chat falls back to a description when `TELEGRAM_CHAT_NAME` is not set, and that description said Telegram in a sentence that already did. It is "your chat" now. Only the wording changes, in the alert window, the two startup lines and the test message.

## [0.0.28] - 2026-09-20

### Changed

- **The social card is referenced as `landing/og3.png`.** A new filename rather than an overwrite, for the same reason 0.0.23 gave: a scraper caches the image by URL, so a card that has already been unfurled will not be re-fetched under the old name. `og.png` and `og2.png` stay where they are for the unfurls already pointing at them.

## [0.0.27] - 2026-09-20

### Removed

- **`TELEGRAM_GROUP_NAME` is no longer read.** It was kept for one release as the old name of the display-only setting, so that an existing `config.env` did not have to be touched. `TELEGRAM_CHAT_NAME` is now the only name for it, and a file still carrying the old key falls back to "your Telegram chat" - cosmetic, and only in the alert window, the startup line and the test message. The two mentions left in this file are history and describe what 0.0.24 and 0.0.26 actually did.

## [0.0.26] - 2026-09-20

Three bugs from an audit of the bot, the alert sweep and the theme, and the wording stops assuming there is a group.

### Fixed

- **The bot answered a private command in the group.** 0.0.25 taught `handle()` to accept commands from `TELEGRAM_OWNER_ID`'s private chat, but `reply()` had no way to name a destination and every answer went to `TELEGRAM_CHAT_ID`. So a `/holding` typed in the private chat - the only place Telegram draws the Menu button, which is the whole reason that key exists - left that chat silent and put the position report in a room full of other people. `sendTelegramMessage` takes an optional `chatId` and the answer goes to the chat that asked.
- **A refused database read in the alert sweep took the server down.** `selectArmed()` sat outside the try whose stated job is that a sweep must never be the thing that stops the process. The sweep runs from a timer, so nothing handles its promise: a read refused for longer than the busy timeout - a second copy of the app checkpointing this same file will do it - became an unhandled rejection, which `uncaughtException` turned into `process.exit(1)`. The read is inside the try now, and a failed sweep logs and waits for the next tick.
- **Opening the ledger stopped the landing page following the system theme.** `boot()` called `applyTheme` only to draw the toggle's glyph, but that also writes `myaave-theme`, and the landing page follows the system only while that key is empty. One visit left the landing page and the 404 light on a dark machine, through a toggle nobody had touched. Boot draws the glyph without recording a choice; the toggle still persists.

### Changed

- **The wording no longer assumes a group.** Alerts go wherever `TELEGRAM_CHAT_ID` points, and a user id points at a private chat with the bot, which is the whole setup for someone who is the only one reading it - and the only arrangement that gets Telegram's menu button, since that is drawn in private chats and nowhere else. The alert window said "We will message the Telegram group X" regardless; it now says "We will send this to X on Telegram", and the startup and test-message lines lost the same assumption.
- **`TELEGRAM_CHAT_NAME` is the name of the display-only setting.** `TELEGRAM_GROUP_NAME` is still read and still works, so no existing `config.env` needs touching. The unset fallback is "your Telegram chat".
- `config.env.example` says what a chat id actually is, both ways round, and warns that a group's id is rewritten when it becomes a supergroup - which making the bot an administrator is enough to trigger, leaving the configured id matching nothing. The log already prints the id of every chat it ignores, which is where the new one can be read.
- The README says the private chat is an option rather than walking only through a group, and notes that pinning a message listing the commands gives a group something a menu button cannot: Telegram makes each `/command` in a message tappable.

## [0.0.25] - 2026-09-20

### Added

- **`TELEGRAM_OWNER_ID`, optional**, so the bot answers commands in your own private chat as well as in the group. Unset, which it is unless you say otherwise, nothing changes. It exists because Telegram's Menu button - the list that opens from the message box - is drawn in private chats and nowhere else, so there was no way to reach it while the group was the only chat answered. A group shows a `/` icon instead, which is the same list one keystroke further away.
- Alerts are unaffected and still go to `TELEGRAM_CHAT_ID` alone. The allowlist is the two ids and nothing else, and the log line for an ignored chat now names both keys.

## [0.0.24] - 2026-09-20

The bot answers back: five commands, in the group and nowhere else.

### Added

- **`/price`, `/holding`, `/summary`, `/watch` and `/unwatch`**, plus `/help` and `/start` which list them. `/holding` is one line per open position with the ETH, what was paid, the unrealised gain, the days held and the alert if there is one; `/summary` is the four figures above the table, built from the same `summarize()` the page uses so the two cannot disagree. `/watch` sends the price report every twenty minutes until `/unwatch`, survives a restart, and carries on from where it was rather than reporting on every boot.
- **`bot.js`**, reading commands by long polling. Nothing has to be reachable from the internet, which a webhook would have required of an app that binds loopback behind basic auth.
- **`report.js`** builds every message as a pure function, so the exact text can be printed with `node -e` before anyone receives it, and **`format.js`** holds the number and date formatting the bot and the alerts now share.
- `lib/calc.js` gains `unrealisedUsd`, moved out of `alerts.js` now that two callers want it. It takes the price as an argument, so the module stays as pure as the rest of it.

### Changed

- **One price source.** `eth.js` moves from `/simple/price` to `/coins/markets`, which answers with the 24h, 7d and 30d change alongside the price, in one keyless call. A second fetcher would have meant two cooldowns that know nothing of each other pointed at one shared rate limit. `eth_price` gains three nullable columns, added by the migration on open.
- `sendTelegramMessage` takes an optional `parseMode`. Alerts and the test message are unchanged plain text; only the bot's own tables ask for HTML, because Telegram draws message text proportionally and columns line up nowhere but inside a `pre`.
- Commands can only be named in letters, digits and underscore, so `/watch` and `/unwatch` rather than the `/price-on` and `/price-off` first asked for: a hyphen ends the command, and `/price-on` arrives as `/price` followed by the text `-on`.

### Security

- **Only `TELEGRAM_CHAT_ID` is answered.** A bot is discoverable by username and `/holding` is the whole of a position, so a command from any other chat is confirmed and dropped without a reply. One log line per unknown chat per run, which is what makes the two confusing cases legible: messaging the bot privately, and a group being upgraded to a supergroup, which changes its id.
- Nothing calls `setMyCommands` or `deleteWebhook`. Both change the bot for every chat it is in, and neither is this app's to decide.

## [0.0.23] - 2026-09-20

The app wears its own mark, and the name comes off the social card.

### Changed

- **The brand mark is Aave Loop's own logo.** The app had been wearing Aave's, in the header, on the landing page and on its 404. `AaveLoop_logo.png` is the master at 1254px, with `AaveLoop_logo_transparent.png` beside it for backgrounds that are not the violet tile. The pages load a 96px derivative: the mark is drawn at 24px, and the full-size file is 941KB, which was a megabyte a page load for a tile the size of a fingernail.
- **`favicon.ico` and the apple-touch icon are regenerated from that logo**, the ico at 16, 32 and 48 with the tile's corners rounded, the touch icon at 180, square and opaque because iOS applies its own mask and composites transparency onto black. Both still carried Aave's mark.
- **The social card is redrawn as `landing/og2.png`**, 1200x630 as before: the wordmark loses "Ledger", the mark is the new logo, and the second sentence of the subtitle starts on its own line rather than running on from the first. `og:image` and `twitter:image` name it. A new filename rather than an overwrite, because a scraper caches the image by URL; `og.png` stays where it is for the unfurls already pointing at it.
- **The README is half the length it was**, opens with a link to this file, and drops the "Landing page" and "Running behind a proxy" sections. Every formula, all six `config.env` steps and the layout block are unchanged.
- This file is a third shorter. The same 22 releases with the same facts; what went was the retelling, mostly in the Notes, which now say what was verified rather than how it felt to verify it.

### Removed

- `public/aaveLogo.png`, Aave's own mark, which nothing references any more.
- `landing/favicon.svg`, a hand-traced copy of the old glyph which had already drifted from the artwork once. The ico is an exact downscale of the real logo at every size a browser asks for, so the pages name it directly rather than keeping a tracing that has to be redrawn by hand whenever the mark moves.

## [0.0.22] - 2026-09-20

A trade whose ETH is still held can now say what price it is waiting for, and be told when it gets there.

### Added

- **Price alerts.** While a trade is HOLDING, the **Bought ETH** card carries a bell. It opens a window with what the trade cost, what was paid per ETH and what ETH is worth now, and takes one figure: the goal price. A Telegram group gets the message once ETH reaches it. One alert per trade; saving replaces and re-arms it, **Remove alert** deletes it.
- **The message is shown before it is sent**, built by the server from the same function that sends it and rebuilt as the price is typed. A group is a room full of other people, so nothing goes into it unread.
- **`config.env`, read by `config.js`:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and a display-only `TELEGRAM_GROUP_NAME`. `process.env` still wins over the file. Gitignored by name, with `config.env.example` committed in its place, and a warning at startup if the file is readable by other users.
- **`eth.js`**, the ETH spot price from CoinGecko, which answers without a key. Shaped like `fx.js`: a timeout, a cooldown after a failure, a cached value and a status object, with a ten-minute cooldown on a 429 that honours `Retry-After`.
- **`telegram.js`**, one message, plain text and no `parse_mode` - a group name with an underscore would otherwise fail the send silently. Every error string leaving it has the token redacted.
- **`alerts.js`**, the alerts and the timer that checks them every fifteen minutes. The tick counts what is armed first, so a ledger with no alerts on it never touches the network.
- `GET /api/alerts`, `PUT` and `DELETE /api/alerts/:id`, `GET /api/alerts/:id/preview` and `POST /api/alerts/test`. The bot token and the chat id are in none of them.
- **A setting-up section in the README**, six steps from making the bot to sending a test, including the two that fail like a broken app: `getUpdates` answers with nothing unless the message begins with a slash, because of Telegram's privacy mode, and the file is read once at startup. It also documents `MYAAVE_CONFIG`, which was in the code and nowhere else.

## [0.0.21] - 2026-09-20

### Changed

- **The app is called Aave Loop.** "Ledger" is dropped from the wordmark, the landing page and its 404, both page titles, the Open Graph and Twitter cards, the README, the startup log, the reset script's banner, the `package.json` description and the two prompts in `PROMPTS.md`. The 0.0.2 entry below keeps the old name, because that is what happened at 0.0.2.

## [0.0.20] - 2026-09-20

The four items 0.0.19 knowingly left open. One of them turned out to lose a save from the screen.

### Fixed

- **A save could be silently undone on screen.** **Fetch rates** reloads the whole ledger, and a stage saved while that reload was on the wire was put back when it landed: a trade saved as CLOSED reverted to SOLD, with no error, until the page was reloaded. The server had it right throughout. `loadTrades` now discards a reply that a newer load has overtaken, or that a write superseded in flight.
- **A cross-stage error named the wrong field, so no field was marked.** Moving an early stage past a later one passed the form and was caught only by the server, whose message names the stage it *collided with* rather than the one being edited. The form checks these from both sides now and flags the field being edited. Same-day stages are still allowed.
- **A dropped amount was read as if it had been typed.** `sanitizeNumeric` treated only `insertFromPaste` as a complete value, so a dropped or autofilled `32.000,00` recorded a 32,000 loan as 32 - the failure 0.0.7 fixed for pasting. Typing is unchanged.

### Changed

- **"Open positions" says when its total is incomplete**, carrying the same `no rate` chip as the rest of the app rather than printing a total that is short without saying so.
- "Total borrowed" states that a trade waiting on a rate is left out, in step with every other figure on that card.

## [0.0.19] - 2026-09-20

Five bugs from an audit of the money path, the date path and the forms.

### Fixed

- **"Gross gain" quoted a rate that did not produce it.** The figure is the proceeds at the sale's rate less the cost basis at the purchase's, and the line under it named the sale rate alone: 1,800.00 EURC read `+$2,228.40 at 1.1380`, and 1,800 × 1.1380 is 2,048.40. It quotes no rate now, as "Net gain" and "Loan cost" already did.
- **The two lines of *Borrowed* in the currency table counted different trades.** The dollar total included only trades whose rate was known while the total in the coin counted every trade, so a cell read `$155,225.00` over `210,000.00 EURC`. Both lines now cover the trades whose rate is known.
- **A field's error was painted over by a live hint while the field stayed flagged.** Typing in a sibling recomputed the hints, which are written into the slot the error occupies, leaving a red field showing a figure computed from the value just rejected. An invalid field keeps its error until that field is edited.
- **The stage preview converted at the rate belonging to the stage's old date.** Moving a repayment from 17 May to 15 July left the net gain converted at the 15 May rate and said nothing about it. The preview drops a stage's stored rate as soon as the form moves it to another day, as the server does, so it falls back and says "(converted on save)".
- **"Added" named the wrong day.** `created_at` is a UTC instant while every other date is a local calendar day, so slicing it put a trade added at 00:09 in Berlin on the day before. It follows `todayISO`'s convention now.

## [0.0.18] - 2026-09-19

### Changed

- **Tooltips are drawn by CSS instead of by the browser.** A native `title` waits a second, lands wherever the pointer is, and on a phone never appears at all. These appear at once, in place, and work on a tap, with no script on hover.
- The explanation marker is a real button, so it can be reached by keyboard and read out by a screen reader, which the `title` could not manage.

### Added

- **Every figure in the Summary says what it means:** all nine rows of the Performance card and all ten column headers of *By currency* and *By month closed*. Each names which trades it counts, since that is what makes two correct figures look inconsistent.
- The "no rate" chip carries its explanation the same way, wherever it lands.

### Fixed

- **"Of which currency" painted a saving red.** A negative figure there means the currency moved in your favour, but it was coloured from the gain palette. Only the colour changed.

## [0.0.17] - 2026-09-19

Eight bugs in the exchange rate lookup, found by auditing the path a euro trade's rate takes from the ECB to the dollar totals. No figure on a trade whose rate was already correct changes.

### Fixed

- 0.0.11 required a business day, but the ECB does not publish on its own holidays either, so Christmas, New Year's Day, Good Friday, Easter Monday and May Day were re-fetched on every refresh and counted as still missing, permanently. A rate published before the day it converts is now re-asked only while the real rate could still arrive, which is a few days.
- A stand-in cached under a date was served from the cache forever: the ECB publishes in the afternoon, so a trade saved in the morning was converted at the day before's rate and cached under today, and every later save was answered from that entry. Such a rate is re-asked while the day is recent.
- Nothing ever asked for a refresh: **Fetch rates** posted `refresh: false`, so the whole replacement path behind `tradesWithSubstitutedFx` was unreachable and a stand-in was permanent however often the button was pressed.
- That button only appeared when a trade had no rate at all, which is the one case a refresh is not for. It now also offers itself, without the warning colour, when a recent trade is converted at the day before's rate.
- `refresh` disabled the cache and the single day fallback for every date in the run, not just the ones being replaced, which made a refresh worse at filling in a rate that was simply missing.
- A refresh reported work it had not done and gaps that were not gaps: `filled` counted rates rewritten unchanged, `stillMissing` counted stages that already had a rate, and a run that found nothing to change reported itself as a failure.
- Span requests used the 2.5 second timeout meant for a single day, so a healthy service could time out and put every remaining lookup to sleep for a minute. Spans get fifteen seconds.
- A backfill grouped the days it needed by coin rather than by peg, so a second euro coin would have fetched the identical span twice. Latent today, since EURC is the only one.

## [0.0.16] - 2026-09-19

### Added

- **Every column in the history table sorts.** Click a header, click again to reverse. Trade sorts on the borrow date, Status on how far the loop has got, Net gain on the figure the cell actually shows.
- A row with no value sorts **last in both directions**, so ascending by net gain does not fill the first page with open trades. Ties break on id, so a re-render never reshuffles equal rows.
- **Pagination, 15 to a page.** Hidden below 16 trades, and windowed to first, last and the current page either side once there are more than seven, so it never wraps onto a second row.
- The chosen column and direction are remembered between visits. The page is not: coming back and landing on page 4 is disorienting.
- Below 760px the header row is hidden and a select stands in for it, as the nav already does at that width.

## [0.0.15] - 2026-09-19

### Fixed

- "Total borrowed" counted only closed, convertible trades while the by-currency table beneath it counted every trade, so on a ledger with capital still out the headline was smaller than the column under it.
- "Average hold" was measured over every closed trade while every money figure in the same card is measured over the convertible ones.

### Changed

- **"Average annualized" is now "Blended annualized".** It is the return on the capital actually deployed, weighted by how much and for how long, not the mean of the percentages in the table. A note on the row explains it.
- **"Best trade" and "Worst trade" are now "Biggest gain" and "Biggest loss"**, and say they are ranked by dollars. They always were, but showing the annualized rate alongside made the rate look like the ranking key. When every trade made money the second reads "Smallest gain".
- The wordmark in the app header links back to the public page.

### Added

- `PROMPTS.md`, with the bug-hunting prompt used on this codebase. It says explicitly not to invent findings to reach a number, and lists the deliberate decisions an auditor keeps re-reporting as bugs.
- Social preview cards: Open Graph and Twitter tags with a 1200x630 image at `landing/og.png`, so a shared link unfurls with the mark, the headline and the coins rather than a bare URL. The image URL is absolute, because a scraper has no page to resolve a relative one against.
- A real `favicon.ico` alongside the existing SVG, plus an apple-touch icon. The app carries `noindex`, since it sits behind a password.

## [0.0.14] - 2026-09-19

### Fixed

- The exchange-rate lines on a EURC trade's stage cards were clipped mid-word. The cards sit inside the expanded row's cell, which inherits the table's `white-space: nowrap`; the cell resets it now, and the converted figure and the rate that produced it take a line each - the part that makes a conversion checkable against the ECB's tables.
- The loan cost breakdown is two rows of its own rather than a run-on third line. It matters most when the cost is negative, which was the case cut off hardest: -$38.55 is $8.25 of interest less $46.80 the euro moved.

## [0.0.13] - 2026-09-19

### Security

- The app sent no framing policy, so an attacker's page could embed the app against a logged in session and place a click on **Delete trade**. `frame-ancestors 'none'` and `X-Frame-Options: DENY` are both sent, with `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. It stops at framing on purpose: a `script-src` policy would need `'unsafe-inline'` for the theme script that runs before first paint, which is most of the way back to no policy at all.
- `X-Powered-By: Express` is no longer advertised.

## [0.0.12] - 2026-09-19

### Changed

- The **Ask for Access** button carries an envelope, so it is clear it opens a mail client rather than another page. It is an inline SVG stroked in `currentColor`, so it takes the button's colour in both themes.

### Fixed

- The landing page footer still read v0.0.10 after the 0.0.11 release. It is hand-maintained, because `/api/version` sits behind auth.

## [0.0.11] - 2026-09-19

The four low severity items left open by the 0.0.7 audit, all in the rate lookup.

### Fixed

- A backfill asked for one span from the earliest date needing a rate to the latest, so two EURC trades six years apart pulled every business day in between: 2,435 days to fill two rates. The days are grouped into runs now, each opening a week early so a run starting at a weekend has a published day to carry forward from.
- A backfill had no bound on how long it could run, so a ledger with many scattered dates held the browser's request open for minutes. A run stops after twenty seconds and reports what it did not reach as still missing.
- A weekend trade is converted at Friday's rate permanently and correctly, but `tradesWithSubstitutedFx` matched on the dates alone, which put every weekend trade in the list of replaceable stand-ins forever. Only business days are listed now.
- `derive` reported an exchange rate source inside each of the four stages, but a row stores one `fx_source` for all of them. It is reported once for the row as `fxSource`.

## [0.0.10] - 2026-09-19

### Fixed

- The app answered every proxied request with `This ledger only answers on localhost.` The Host allow-list added in 0.0.7 assumed the app is only ever addressed on loopback, which stopped being true once nginx sat in front of it. `MYAAVE_ALLOWED_HOSTS` names the hosts a proxy may present; unset, behaviour is as before, and any hostname not on the list is still refused.
- An unknown path under `/api` fell through to Express's default handler and answered with an HTML error page, where every other API response is JSON.

### Added

- A 404 page at `landing/404.html`, in the landing page's design, served by nginx for a missing public file and by the app for an unknown path. The nginx handler needs `auth_basic off`, or the internal redirect re-runs auth and a missing file reports as a 401.

### Changed

- The landing page drops the self-hosting card, and the closing call to action gains an **Ask for Access** button.

## [0.0.9] - 2026-09-19

### Changed

- The Trade column states the span of a loop rather than only its start: `10 Jan 2026 - 13 Jan 2026`. The range appears only once a trade is repaid, since that is the only point at which it has a real end date.
- A trade in a currency other than the dollar carries its native amount on its own line, above the dates. The two used to share one line joined by a middot, which read as a run-on.
- In card mode the Trade label is aligned to the top of its cell rather than floating in the middle of a three line stack.

## [0.0.8] - 2026-09-19

### Added

- A public landing page at `/`, in `landing/`. It explains what the app does in a screen or two and carries a **Use Aave Loop** button that leads to the app, and therefore to the password prompt. Served by nginx as static files, which leaves the Node process with no publicly reachable route.
- The page shares the app's `myaave-theme` setting, so a dark session carries across both ways, and follows the system preference for a first time visitor.

## [0.0.7] - 2026-09-19

Twenty-two defects found by an audit of the maths, the database handling, the security surface, the interface and the error paths. No new features.

### Security

- The API answered any `Host` header, so a page on the internet could point its own hostname at `127.0.0.1` and reach the app as a same origin, reading and deleting every trade. The loopback bind is the whole of this app's protection, so a request has to be addressed to loopback as well.
- The backfill stored whatever the rate service sent: `resolveRange` never ran the check `resolveRate` applies to a single-day answer, so `-999999` was accepted as a rate and the day key from the response was rendered into the page unescaped. Both paths validate now, and `fmtDate` escapes its result.

### Fixed, crashes and races

- `GET /api/fx/rate` had no error handling: Express does not catch a rejected async handler, so any throw from the rate cache hung the request and exited the process. Editing or creating a borrow threw `ReferenceError: Cannot access 'c' before initialization` on every keystroke once an amount and an APR were both present, so the interest-per-day hint never appeared.
- `PATCH` became asynchronous when rate lookups moved into it, so two requests for one trade interleaved across the await and the second answered with a row missing the change just made; writes are serialized per trade now. A rate backfill could also pin a rate to a stage that had moved while it was away on the network, so it re-reads each row inside its transaction.

### Fixed, in the dates

- `todayISO()` returned the UTC date, which east of UTC is yesterday for part of the day: the forms prefilled yesterday and the browser then refused the user's own today as "in the future". Today is read from the local calendar on both sides now, and spans are unaffected because `parseDate` still builds UTC midnights. The server let a future date through anyway: its 36 hour slack was measured from `Date.now()` while a date parses to UTC midnight, so tomorrow always fell inside it.

### Fixed, in the maths

- Average annualized was weighted by loan size alone, so a one day flip that made $50 counted as heavily as a ninety day trade that made $900: two such trades read 109.5% where the honest figure is 38.1%. The weight is capital times time now.
- The by-currency table counted only closed trades towards Borrowed, so a currency with 50,000 still out showed a dash, contradicting the Open positions tile.
- A trade that came out exactly flat was counted as a loss, reporting a break-even ledger as 0% won; it is left out of the win rate now. A closed trade whose rate had not been fetched made the headline Realized net gain read `+$0.00`; the total is marked unknown rather than stated as zero.

### Fixed, in the numbers people paste

- A European amount was silently gutted: `32.000,00` became 32, `32000,50` became 3200050. A pasted amount is read for what it is now, while typing is unchanged, because `1,5` on its way to `1,500` cannot be read as a decimal comma. A half typed `1500.` was rejected as "must be a number" although the server accepted it.
- The form and the server disagreed about exponent notation: `1e5` was 15 in one and 100000 in the other. Both use one parser in `lib/calc.js` now, which refuses anything that is not a number instead of editing it. An APR sent as a single space was stored as 0%, a silent interest free loan; whitespace counts as blank.

### Fixed, in the interface

- An error raised when a field was left refocused that same field, so the value could not be tabbed away from until it was acceptable. Neither form disabled its button while a request was in flight, so a double click on Create trade posted the same borrow twice.
- Derived figures were a snapshot taken at page load, so a tab left open across midnight kept showing the day count and accrued interest from load time. A failed **Fetch rates** left the button reading "Fetching..." and disabled for good, because the re-render never happened.

### Fixed, on the server

- Clearing a stage's amounts through the API left a row labelled CLOSED whose net gain had become null, so it dropped out of every realized total while counting as an open position. 0.0.5 closed this for the dates only.
- An oversized request body was reported as a 500; it is a 413. A write that lost the lock race to a second instance was reported as a 500 as well, which read as data loss; it is a 503 saying to try again.
- Caching a span of rates committed once per day in the span. A wide backfill is thousands of days, so it is one transaction now.

## [0.0.6] - 2026-09-19

### Added

- EURC as a fifth borrowable currency, converted at the ECB euro reference rate published for the day of each transaction. Each stage is converted at its own date, so the euro's movement over the life of a loan lands in the dollar result rather than disappearing.
- The Repaid card splits the cost of a loan in another currency into the interest and what the currency did to the principal, so a loan that got cheaper in dollars reads as an explanation rather than a mistake.
- Rates are cached in the database and looked up once. A trade always saves whether or not a rate could be fetched; one without a rate is marked, left out of the totals, and filled in later by **Fetch rates**.
- `GET /api/fx/rate`, `GET /api/fx/status` and `POST /api/fx/backfill`. All three answer 200 when the network cannot be reached, since that is a result to show rather than a server fault.

### Fixed

- Every cross-currency total summed raw amounts as though one token were always one dollar, which would have reported a 50,000 EURC borrow as $50,000. The totals convert now, weighted by the dollar size of each loan.
- The ETH buy and sell price divided the amount spent by the ETH bought and labelled the result dollars, which on a trade in another currency is a euros-per-ETH figure under a dollar sign.
- Best and worst trade ranked native amounts against each other, which is not a comparison.

### Changed

- The database gains nine nullable columns and a rate cache table, added on first open. An existing ledger opens unchanged, with no migration to run by hand.
- Exchange rates are resolved by the server and rejected if submitted, so no request can move the dollar figures without touching an amount.
- "Stablecoin" reads "Currency" in the form and the summary table.

## [0.0.5] - 2026-09-19

### Added

- `resetDatabase.sh`, which empties the ledger. It asks twice, refuses to run while a server holds the file open, and keeps a timestamped backup unless told not to.

### Changed

- The four stage cards put the money on the second line and state it in the coin that was borrowed, so "32,000.00 USDT" reads in one go. ETH prices stay in dollars.
- Amount fields carry the stablecoin ticker instead of a dollar sign, and the ticker follows the dropdown while a new trade is being entered.

### Fixed, in the maths

- The Repaid card showed the theoretical accrued interest while the net gain used the interest actually paid, so the card did not add up. It shows what the loan really cost now.
- The live preview under the repayment field ran its own `proceeds - repaid` formula instead of the shared one: on a partial sale it read -4,028.77 where the saved result was +971.23.
- A repayment below the principal made the implied interest negative, which the net gain counted as profit - repaying 20,000 on a 32,000 loan reported a 14,824 gain. Such a repayment is rejected.
- A trade could be recorded as repaid without ever having been sold, a state the maths has no answer for. Stages must be filled in order, as the interface already required.
- `summarize` called every repaid trade closed while `summaryReport` required a net gain, so the two disagreed about the same row, and the by-stablecoin sort compared two nulls as `-Infinity - -Infinity`, giving NaN and an undefined order.
- A typed `0` was treated as an empty field, so a 0% borrow previewed nothing even though it is accepted, and a future dated trade produced a negative loan span, which quietly suppressed the interest and the annualized return. Future dates are refused.

### Fixed, in the interface

- Pasting an amount such as `12,000` or `$12000` left the field silently empty, because a number input discards what it cannot parse. Amounts are collected as text and tidied as they are typed.
- Negative amounts, a negative APR, an APR above 100 and future dates were all accepted by the form and only refused by the server, one round trip later.
- A blank form submitted blanks rather than saying what was missing. Every field is checked before anything is sent, and again when a field is left.
- An error stayed on screen and the field stayed red even after the value was corrected.
- Edits in progress were silently discarded when the view changed.
- The stage forms are validated against their siblings, so selling more ETH than was bought, or dating a sale before its purchase, is caught as it is entered.

## [0.0.4] - 2026-09-19

### Added

- A real Summary view behind the nav link, which until now only scrolled the page: performance by stablecoin, net gain by month closed, best and worst trade, interest paid, win rate, total borrowed and average hold time.
- The nav switches views, tracks the active link and supports deep links such as `#summary`.

### Fixed

- The nav was hidden below 760px, which left the Summary unreachable on a phone once the links did something. It drops to a segmented control on its own row.
- Grid tracks declared as `minmax(260px, 1fr)` cannot shrink below their floor, so on a narrow viewport they overflowed and the card's `overflow: hidden` clipped the values. The same flaw affected the stage cards and forms.
- API responses carried an ETag but no `Cache-Control`, so the browser could heuristically cache them and show a ledger that had already changed; they are `no-store` now. Static assets were served with `max-age=0`, which still allowed reuse from the memory cache; they are `no-cache`.
- `/favicon.ico` returned 404. It redirects to the app icon.

## [0.0.3] - 2026-09-19

### Changed

- Dropped the APR column from the trades table. The rate is still on the Borrowed card when a row is expanded.
- Broke the page subtitle across two lines.

## [0.0.2] - 2026-09-19

### Changed

- Renamed the app to Aave Loop Ledger.
- USD is shown to two decimals and ETH to four throughout.
- Footer is now right aligned and credits the author.
- The server binds to loopback only, so the app is not exposed to the network.

### Fixed

- Gross gain on a partial sale compared the proceeds against the whole purchase, turning a profitable sale into a large reported loss. It uses the cost basis of the ETH actually sold now, and the remaining ETH is shown.
- An annualized return was still produced when the dates ran backwards. Both that and accrued interest return nothing for a negative span.
- A borrow at 0% APR was rejected. Rates may be zero while amounts must still be positive.
- Clearing a required borrow field through the API failed as an opaque server error instead of a validation message.
- A repayment could be dated before the sale that funded it, and a malformed JSON body returned a server error rather than a bad request.
- The database is checkpointed and closed on shutdown, so committed rows no longer sit in a stray write ahead log, and a busy timeout makes a second instance wait for a write instead of failing at once.
- Prepared statements are cached rather than recompiled on every write.
- Dark mode never set `color-scheme`, so the native date picker and scrollbars stayed light.
- A failed delete and an unreachable server both failed silently in the interface.

## [0.0.1] - 2026-09-19

### Added

- Trade lifecycle in four stages: borrow, buy ETH, sell ETH, repay, with progressive entry, so a trade can sit at Open, Holding, Sold or Closed.
- Derived figures: ETH buy and sell price, gross gain, accrued interest, net gain, annualized return. The repaid amount is prefilled from the APR and the loan length, and is editable.
- SQLite storage with full history, plus view, edit and delete of past trades.
- Light and dark themes modelled on app.aave.com, with the choice remembered.
- `run_myAave.sh` launcher with dependency, port and Node checks.
