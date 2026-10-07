# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [1.5.1] - 2026-10-07

### Added

- **A Statement button on Stats** downloads the year's closing statement as a one-page PDF: logo linked to aaveloop.com, the period, then the overview, Performance, By currency and By month closed for the trades closed that year. Not offered on All or on a year with nothing closed.
- **Export CSV has a tooltip** saying what it downloads.
- **`npm run check` runs a fourth suite**, 13 checks of the statement, and the other suites gain eleven more.

### Fixed

Audits of every tab, script and document, each finding reproduced before its fix and re-run after.

Statement:

- **Open trades were on it**, in a tile, a column and Total borrowed ($67,000.00 for $47,000.00 closed). It is closed trades only.
- **It named no period**, a past year reading "As of 7 Oct 2026", and a year with nothing closed gave a page of dashes.
- **The app's version and the open-trades note** are gone from it.

Figures:

- **Totals and cards did not add up from their lines**, missing by a cent: By month closed came to $8,156.72 under $8,156.71, and so did about one euro trade card in four, Telegram's `/holding` and two fees of 1.005. Every figure is now built from amounts as printed.
- **The CSV's gas columns did not add up to its fees_usd** when a fee had three decimals. Amounts and fees are written as printed.

Interface:

- **On a touch screen the Statement and Export CSV tooltips stayed up after the tap.**
- **Alerts showed no firing on a reached goal waiting to be sent.** Fired at now shows its time and price.
- **`/help` called `/holding` the open positions**, though a trade sold and not repaid is not in it. It says "trades still holding ETH".
- **The landing and 404 pages ignored a dark system until their last script ran**, or for good without JavaScript: `<html>` was hard-coded to light. They follow the system from the first paint.
- **White on the landing page's violet buttons was 2.58:1**, under the 4.5:1 it needs. A darker violet gives 5.71:1.
- **The ledger set real information in its faintest grey**, 2.4 to 2.6:1 in the light theme: the rate under a converted figure, the "of which" labels, a field's unit, the `?` hint and "Not yet.". They use the muted grey, 4.2:1 and up; the faint one is for decoration.
- **The nav told a screen reader nothing about which view was showing**: only the underline marked it. The current tab carries `aria-current="page"`, as the pager's current page already did.

Tooling:

- **`run_myAave.sh` reinstalled everything after each release**, because a version bump made the lockfile look changed; offline that could leave nothing to start. It compares the installed packages with the lockfile instead.
- **`make-logo.mjs` did nothing, silently, from a path with a space in it.**
- **Four behaviours had no check**, so breaking them passed `npm run check`: the blended rate's weighting, a partial sale's cost in the coin, the CSV's formula defusing and a Telegram 429 being retried.
- **Four form rules had no check either**: an amount of 0, and editing an earlier stage past a later one (the borrow date after the purchase, the ETH below what was sold, the loan below what was repaid).

Documents:

- **The landing page** said the net gain was after interest alone, that a partial sale is never a loss, and that euro rates are each day's own; it is after fees too, only a profitable one, and a weekend takes the business day before.
- **The README is 44% shorter** and corrected in nine places, among them four check suites, ten alerts to a page and 7.2% (not 7%) over three days reading 876%.
- **`config.env.example`** called `TELEGRAM_CHAT_ID` the only chat the bot answers and a private chat the only way to the Menu button; `TELEGRAM_OWNER_ID` gives both.
- **`run_myAave.sh`'s help, the README and CLAUDE.md** said an earlier Aave Loop on the port is moved past; it is replaced, and only another program is.

## [1.5.0] - 2026-10-07

### Changed

- **Currency is a picker with each coin's icon and name**, alphabetical (DAI, EURC, GHO as Aave GHO, USDC, USDT), before Amount borrowed, by mouse, touch or keyboard. A new trade starts on DAI.
- **Gas on the borrow and the repayment is optional.** Blank is saved as not recorded; 0 is still none paid.
- **The swap fee is now Costs & Fees (swap)**: gas plus the DEX or aggregator fee, one dollar figure, still required.
- **The Telegram alert reads more clearly**: "ETH reached your goal" either way, the value lines set apart, and **Gain (%)** over what the ETH cost beside **Gain ($)**. Telegram says "fees", not "gas".
- **`npm run check` runs three suites**: 38 checks of `lib/calc.js`, 18 of the form input rules (moved to `lib/input.js` so the page and the checks run one file), and 20 of the server, the alert sweep and the bot against a throwaway database with Telegram and prices mocked. Run against the code before these fixes, 15 of them fail.

### Fixed

Three audits, every finding reproduced before its fix and re-run after.

Input:

- **A typed decimal comma was dropped**: "3,20" saved a $320 fee, "32.000,00" a loan of 32. The form keeps the separators and the server's parser reads them.
- **A paste or exponent was turned into another number**: "1.5 ETH ($5175)" saved 1.55175 ETH, "1e5" saved 15. Both are refused, as the server does.
- **Nothing checked the ETH price a purchase or sale implies**, so 80,773 ETH for 25,000 stored ETH at $0.31. Outside $1 to $1,000,000 is refused, and the form's lower bound for an alert goal now matches the server's.
- **Selling ETH withdrawn from Aave with its interest was refused** past 0.01% over the purchase. A sale may run 10% over.
- **Leaving a field checked it against the saved trade**, not what was typed, so a warning Save would not give appeared mid-edit.

Interface:

- **A slow save closed whichever stage editor was open** and lost what was typed there, and a failed one showed nowhere. It closes only its own and shows its error.
- **Escape anywhere threw away the stage editor**, from Stats, the new trade form, or the currency list in Safari and Firefox.
- **Save on one form did nothing while another was saving.** Each form has its own lock, and a late reply no longer rolls a row back.
- **Keyboard focus fell to the top of the page** after Save, Cancel, Escape or a delete. It returns to the stage's Edit button or the next row.
- **Deleting a trade another tab had deleted left it on screen**, and the Alerts view drew a bare "Trade #23" for one added there.
- **The currency list ran off a short window and swallowed Cmd and Ctrl shortcuts.** It fits and scrolls, and leaves modifiers to the browser.
- **Three tooltips misdescribed their figures**: Total fees paid (gas only), and the Alerts Trade and Status columns.
- **By month closed drew every bar short** when no month reached a dollar.

Math:

- **A sale within 0.01% of the purchase showed a full exit with a partial cost**, +$3,001.50 under a card adding to +$3,000.00.
- **The repayment preview counted to today** with the amount blank, not to the date in the form.
- **`/holding` gave the euro move for some trades under the total of all.**

Telegram and alerts:

- **A failed send was retried only if ETH was still past the goal**, so the message could be lost. It retries every check, up to three times, keeping the triggering price.
- **A wrong Telegram setup used up a reached alert**: a revoked or malformed token, a bot removed from the group or not allowed to post. It waits, armed, and goes once fixed. A refusal of the message itself is still final.
- **`/watch` timing**: the interval was rounded in `/help`, a one-minute report came every 100 seconds, and a bad timing setting made the bot poll every millisecond. Intervals are bounded, at least a minute, and kept.
- **The bot's plain-text fallback showed `&lt;` and `&amp;`.**

Server and database:

- **`DELETE /api/alerts/` with a trailing slash deleted every alert**, and an unknown `/API/...` path got the HTML 404 page.
- **With two copies of the app on one file**, Fetch rates failed at once, an edit could land on a row the other had changed, and an alert's failed sends could be miscounted. The backfill waits for the lock, an edit is written only to the row it was worked out from, and failures are counted in SQL.

## [1.4.2] - 2026-10-03

### Fixed

- **The landing page asked for a password in Edge, Firefox and Safari**, and showed no logo. Its logo loaded from the site root, which nginx routes to the ledger behind auth, so a browser with no saved credentials put up a login prompt over the public page. The landing and 404 pages now load every image from `/landing/`, the path nginx serves publicly.
- **The ledger opened light on a dark machine even with 1.3.5 deployed.** Production's Content-Security-Policy admits inline scripts by hash, and rewriting the theme script changed its hash, so the browser blocked it. The script is now `public/theme.js`, which the policy admits as a file from the site. `npm run check` fails if a landing page's inline script stops matching nginx's hashes, or if one appears on the ledger page.

## [1.4.1] - 2026-10-03

### Added

- **Exchange rates fill themselves in.** The server re-asks every hour for a rate still missing or standing in for one the ECB has not published yet, and an open page picks the new figures up. The Stats banner and its **Fetch rates** button now appear only while a trade has no rate at all. `MYAAVE_FX_REFRESH_MS` sets the interval.

### Fixed

Four audits, of everything added this session and of `server.js`, `eth.js` and `telegram.js`, each finding reproduced or traced before its fix and re-run after. `telegram.js` came back clean. `npm run check` is at 32.

Added this session:

- **A ledger that failed to load stayed failed.** A trade created afterwards was saved and toasted, and never drawn. A load that works now clears it, and a failed boot shows the view the address names.
- **Rates arriving on their own redrew under the reader's hands**, moving an expanded row to another page and taking focus off a control. They wait for no row open, no form, no dialog and no focus on the page.
- **On a phone, `est` sat apart from its figure** at the far edge of the Net gain cell. They stay together.
- **Pressing on the alert window's backdrop and letting go inside it closed the window**, losing the goal. Both ends of the click must be on the backdrop.
- **The Fired at tooltip said "blank while armed"** though a closed alert shows a dash too.
- **A goal saved while the trade was sold was armed on a sold trade**, a delete in that moment answered 500, and a failed send could re-arm on a trade sold during it. The save checks again after its wait, and a failed send on a sold trade closes.
- **The CSV still rounded some half-cents differently from the page.** Gas of 1.005 read $1.01 on the page and 1,00 in the file. It now rounds with the page's own call.
- **An out-of-range interval in the environment made a timer fire every millisecond.** `MYAAVE_FX_REFRESH_MS=99999999999` sent 1,052 rate requests in three seconds. Intervals are now bounded, the alert and ticker ones too.
- **A euro trade's Gain line in alerts and `/holding` did not add up** from the lines above it, which price the purchase at its own rate. It now names the euro's move since: `bought at 1.0500: -$3,600.00`.

`eth.js`:

- **A price fetched while the cache refused the write was lost**, and the alert window fell back to one from days before, previewing "hit" for a goal the save filed as "fell to". The last price is kept in memory and the window uses the fetch's own answer.
- **A Retry-After given as a date was ignored.** Asked for 55 minutes, the app waited 10. Dates and seconds are both honoured.
- **A cached price stamped ahead of the clock read as fresh** until the clock caught up. It is stale.
- **Stepping the clock back stretched the rate-limit pause** past its one hour cap. The pause runs on the monotonic clock.
- **`MYAAVE_ETH_PRICE` was not checked.** -3450 was served as the price, and "3,450" silently went to the live network. It is read like a typed amount, and a value that is not a usable price is ignored with a warning.

`server.js`:

- **A stand-in rate cached on its own morning became final four days later** without anyone asking again, so a trade dated that day and entered later kept the day before's rate. A stand-in fetched while it could still change is asked about once more.
- **The rate lookup accepted any date.** 1990 put every rate lookup, saves included, to sleep for a minute, and a future date cached a stand-in. It takes a trade's own date bounds.
- **Fields sent as objects were coerced.** Notes `{"a":1}` stored "[object Object]", and a `toString` key answered 500. Dates, currency and notes must be text.
- **An alert goal under a dollar was saved**, reading "fell to your $0.00 goal", and the preview showed goals the save refused. Both take $1 to $1,000,000.

## [1.4.0] - 2026-10-03

### Changed

- **An alert closes when its trade sells.** It used to stay ARMED with a "not watched" note, so that undoing the sale brought it back, and closed trades kept armed goals in the Alerts list. It is now marked CLOSED, in grey, and kept as history. It closes on the save that records the sale, at each alert check, and at startup, which closes the ones already left behind. Undoing the sale does not revive it; the bell sets a new goal. A cleared purchase closes it too.

### Fixed

- **The Alerts table sat on the edge of its card.** The coin logo, TRADE and the Delete column had no gutter, on a wide screen or a phone. They get the table's usual padding now.

## [1.3.5] - 2026-10-03

The four smaller findings left over from the 1.3.3 audit.

### Fixed

- **Turning a page or choosing a sort on a phone sent keyboard focus to the top of the page.** Both put it back on the control, without scrolling the page back down to the pager.
- **The alert window called the purchase "Trade date" and "Trade amount"**, the table's name for the borrow. It now says *Bought on* and *Spent*, as the Bought ETH card does.
- **The ledger ignored a dark system setting** that the landing page follows. With no saved choice it follows the system now.
- **Interest paid and the four Biggest and Smallest tiles** did not say they leave out trades waiting on a rate. Their tooltips say so now.

A check of these four changes found one bug before release: putting focus back on the pager scrolled the page down to it, undoing the jump to the top of the table. Focus is now restored without scrolling.

## [1.3.4] - 2026-10-03

### Fixed

- **The Borrowed card said "Loan length 1 days".** It says "1 day" now, and "Running for 1 day" while the loan is open.

## [1.3.3] - 2026-10-03

### Fixed

An audit of the whole app's math, interface and server, in three independent parts, found these ten. Each was reproduced or traced through the code before the fix and re-checked after, and `npm run check` grew to 30 checks. The derive and total arithmetic held across 300 random ledgers.

- **A European amount with three decimals was read a thousand times too small.** "26.810,928" stored 26.81, and malformed groupings like "1,25.50" went through. With both separators the last one is now the decimal point, and grouping not in threes is refused.
- **The CSV rounded half-cent losses toward zero.** A net gain the page prints as -$1.38 was written -1,37 beside fees of 1,38. It now rounds the way the page does.
- **A trade printing -$0.01 was scored neither won nor lost** in Stats, for the same reason. It is a loss now.
- **Telegram put a plus on zero.** "+$0.00" and "24h +0.0%" now read "$0.00" and "0.0%", as on the page.
- **`/holding` called a dollar trade unpriced when it was dated the server's tomorrow**, which the server accepts from a reader ahead of UTC. The row read "-1d". Server messages now derive a trade on its own day when that is later.
- **Malformed requests answered 500.** A broken path encoding or body compression is now a 400.
- **A ledger that failed to load was drawn as empty.** One click on a tab showed "No trades yet" and a hero of zeros. Trades and Stats now say the ledger could not be loaded until the page is reloaded.
- **Letting go of a drag past the alert window closed it**, with the typed goal lost. Only a click that starts on the backdrop closes it now.
- **Closing the alert window sent keyboard focus to the top of the page.** It now goes back to the bell.
- **A new euro position waited up to five minutes for today's rate.** Recording the purchase now asks for it at once.

## [1.3.2] - 2026-10-03

### Fixed

- **Sorted by Net gain, held trades stayed last after the ETH price arrived.** The page loads before the price, so they sorted as having no figure, often onto another page. The table now re-sorts when a price or today's rate changes the order. It doesn't while a stage form, a row of the page, a dialog or focus in the table is open.
- **A euro trade estimated at today's rate lost its "no rate" cue.** When today's rate stands in for one the trade is missing, its `est` chip turns amber and says to use Fetch rates.

A bug hunt over the grid, the re-sort and the chip found two bugs in the re-sort, each traced through the code and fixed before release. No browser was available, so the layout itself is unseen.

- **An expanded row could jump to another page by itself.** A save leaves focus on the page, so a euro trade's first quote at today's rate re-sorted it from +$2,888 to -$723 and away. An expanded row on the page now holds the order.
- **A re-sort under the delete confirmation lost keyboard focus.** Cancel returned focus to a button the redraw had replaced, so it fell to the top of the page. An open dialog now holds the order too.

## [1.3.1] - 2026-10-03

### Changed

- **Open positions lists each estimate in a two-column grid**, ids and figures aligned, two positions to a row. The flowing line wrapped from four positions on and left a `·` dangling at the end of the first row.

## [1.3.0] - 2026-10-03

One estimate for an open position, printed the same everywhere it appears.

### Added

- **The History table estimates held trades too.** Net gain shows the header's figure with the `est` chip, updated in place on every ETH quote so a stage form being typed into keeps focus. The column sorts on it.
- **A partial sale counts the ETH still held.** The estimate adds it at today's price less what it cost: 6 of 10 ETH sold read $1,800 short of closing today. A closed trade's net gain is unchanged.
- **`npm run check`**, 25 checks of the estimate math in `scripts/check-calc.mjs`, against hand-worked figures on a fixed date.

### Changed

- **Telegram `/holding` and price alerts use the page's estimate.** A euro trade is marked at today's ECB rate, and the line says so: `EURC at 1.1225 today`. Both used the purchase day's rate, so a 30,000 EURC trade read +$2,881.53 in an alert and +$698.91 on the page.
- **Every open euro position is marked at today's rate, sold or held.** The stored rates stand in only when today's is unavailable.
- **`CLAUDE.md` sets the release rules.** `minor` is for a feature and `patch` for fixes only. Every change gets its changelog line in its own commit.

### Fixed

A bug hunt over each addition found seven bugs, each reproduced before the fix and re-run after.

- **Selling a sliver of a euro position moved its estimate by thousands.** A sold trade fell back to its stored rates, so selling 0.01 ETH of 30,000 EURC bought at 1.05 jumped the estimate by $3,612 with the euro at 1.17.
- **A held euro trade with no rate showed a dash in the row** while the header said "no rate". The row says "no rate" now, and a dash only when the ETH price is what is missing.
- **The CSV comment called `net_gain_estimate_usd` the table's figure.** It no longer is. The comment now says it is the projection at stored rates.
- **`/holding` waited on a rate lookup with no ETH price**, when every figure would be a dash anyway.
- **The checks computed the expected interest with the function under test.** It is worked out by hand now.
- **The "imports nothing" check missed re-exports and dynamic imports.** It catches all three now.
- **`CLAUDE.md` said the bump renames the changelog heading.** It does not, and now says so.

## [1.2.4] - 2026-10-03

### Added

- **Estimated gain under Open positions.** The hero tile adds the total at today's ETH price, then each position, for example `Est. gain +$34,359.92` over `#914 +$15,056.36 · #915 +$19,303.56`. A held trade is its ETH at today's price less cost, interest so far and gas. A sold, unrepaid trade shows the table's estimate. A loan with nothing bought is left out. `openGainsUsd` in `lib/calc.js` takes the price and rates as arguments.

### Changed

- **The Repaid card rules off its result.** A line above Net gain, and Net gain and Annualized in bold.

### Fixed

A bug hunt over the estimate found six bugs, each reproduced against `lib/calc.js` before the fix and re-run after.

- **A euro position was marked at the purchase day's rate.** It now uses today's ECB rate from `/api/fx/rate`, asked at most every half hour, not a live quote. A EURC trade bought at 1.05 read +$13,302.98 at today's 1.17 instead of +$9,094.86.
- **A held euro position saved before its rates were fetched had no estimate.** It converts at today's rate now. The trade's stored rates stand in when today's is unavailable.
- **So did a sold, unrepaid euro trade with no rates.** It falls back to its coin result at today's rate.
- **With no ETH price the total counted only the sold trades.** It printed one position's gain as the whole, with no mark. It is a dash until a price arrives.
- **The Stats tile for this year showed a dash for good.** It was drawn once, often before the first price. The estimate is shown in the hero only, which follows every quote.
- **Many open positions widened the tile across the hero.** The per-position line has a measure and breaks between positions only.

## [1.2.3] - 2026-10-03

### Added

- **Export CSV on Stats.** A button on the line of the year tabs downloads the trades on that tab, filed by the same `statsYear` rule the cards use, as `aave-loop-trades-2026.csv` or `-all.csv`. One row per trade has the stage inputs, rates, fees and every figure `derive` works out. A stage not reached and a figure not known are empty cells, not 0. It is built in the browser by `lib/csv.js`, which Node imports unchanged.

### Changed

- **Gross gain and Net gain are right aligned**, both lines, on the Sold ETH and Repaid cards. Repaid also has space above Gas fee and Net gain.

### Fixed

Two bug hunts, every finding reproduced before the fix and re-run after.

- **A Stats tab drawn on 31 December and exported on 1 January dropped its open trades.** The export took a fresh date and filed them under the new year. It now uses the date the tab was drawn.
- **A comma after a leading 0 read as a thousands separator.** "0,125" typed or pasted as a gas fee stored $125. It is a decimal now, and "1,500" still reads as thousands.
- **A trade flat to the cent after gas counted as a loss.** Rounding left -1.09e-12, so Stats said 0% won. Wins and losses are counted in whole cents.
- **The Borrowed form showed the old coin after a re-render.** A currency changed in the form, then another row opened, left the amount labelled USDT beside an EURC hint.
- **Moving from one stage editor to another left focus on the page.** The new form takes focus now.
- **Enter on a trade row or a sort header sent focus to the top of the page.** Focus stays put, as on the year tabs.

## [1.2.2] - 2026-10-03

### Fixed

- **Long form hints ran off the stage card.** The forms sit in the trades table, whose cells do not wrap. Hints wrap now, the sale's *Gross* and the repayment's *annualized* rate each get their own line.
- **The stage cards ran the amount straight into the next row.** APR, Bought, Sold and Loan cost (Interest on a dollar loan) now have space above them, closing off each card's date and amount.

## [1.2.1] - 2026-10-03

Aave gas. A loop also pays gas to supply the ETH on Aave and to withdraw it, and neither reached the net gain.

### Added

- **Gas fee to lend on Bought ETH and Gas fee to unstake on Sold ETH.** Both are optional, and blank means none was paid, not *not recorded*. They are two nullable columns, `buy_lend_gas_usd` and `sell_unstake_gas_usd`, added to the DDL and the migration list. `derive` adds them to `feesUsd`, so Net gain, the estimate, the unrealised gain and Stats' Total fees paid all include them. For example, $3, $5, $4 and $0 of gas plus $2 to lend and $1.50 to unstake now take $15.50 off instead of $12.00.
- **A red dot on every required field and a `?` tooltip on every field**, in all four stage forms and the alert form.

### Changed

- **Gas fee is now *Gas fee to swap* on Bought ETH and Sold ETH**, in the form, on the card and in the server's error message.

A bug hunt over the new fields and over the fee and net gain figures in History and Stats found nothing to fix. Per-trade fees and net gains on a copy of the ledger summed exactly to Stats' Total fees paid and Realized net gain.

## [1.2.0] - 2026-10-03

Gas fees. Every stage is an on-chain transaction, and the ledger treated them as free, so every net gain was overstated.

### Added

- **A gas fee on every stage, in dollars.** Borrow, Buy ETH, Sell ETH and Repay each ask for a required *Gas fee*, typed in dollars whatever was borrowed (0 is accepted). Four nullable columns, `borrow_gas_usd` to `repay_gas_usd`, were added to the `CREATE TABLE` and the migration list.
- **Net gain is after fees, everywhere.** `derive` takes the fees off `netGainUsd`, so the table, the annualized rate, the hero, the Stats tiles and Telegram's `/summary` all follow. A sold trade's estimate and a held trade's unrealised gain take off the gas paid so far. Example: a USDT trade that made +$2,531.00 reads +$2,519.00 with $3, $5, $4 and $0 of gas.
- **Total fees paid on the Repaid card**, just above Net gain, and a *Gas fee* row at the foot of every stage card.
- **Total fees paid on Stats**, after Average hold, for the year on the tab or for All.

### Changed

- **A euro trade's Gross gain and Net gain lead with dollars**, with the EURC figure underneath, because every total adds up the dollar figure. The EURC net gain is after fees too: each dollar fee is converted at the rate of the stage it was paid on, the one place `lib/calc.js` divides by a rate.
- **A trade recorded before fees existed keeps its figures.** Its stages say *not recorded* rather than $0.00, and the Repaid card and the Stats tile count them. Editing a stage asks for that stage's fee only.
- **`isRealized` gates on the gross gain** rather than the native net gain. Otherwise a closed EURC trade still waiting on a rate would have been filed as open.
- **Opening a trade in History no longer closes the one already open.** `state.openId` is now a set, so two trades can be read side by side. The editor closes only when its own row is collapsed or its trade deleted, so a half typed sale is not thrown away.
- **Every tooltip is at least 30% shorter, and none uses a dash.** All 29 in `TIPS` were rewritten in short sentences and still say which trades they count. Total fees paid had run to eleven lines on a phone.

### Fixed

Two bug hunts over the new code before release found twenty bugs, each reproduced on a scratch ledger or against `lib/calc.js` before the fix and re-run after. The arithmetic came back clean. The second hunt also found security clean: column names in an UPDATE come only from the server's own list, `__proto__` keys are ignored, rates in a request are refused, and the Host allow-list holds.

- **The Telegram holding report said "after interest" under a figure that was also after gas.** It says "after interest and gas" whenever a held trade has a fee recorded. The price alert names both amounts.
- **Total fees paid counted only closed trades with a dollar result.** It left out gas on open trades and on rateless EURC trades, so $27.00 of fees read $12.00. It counts every trade on the tab now.
- **The tile's tooltip claimed every fee was already taken off the figures above it.** That stopped being true once open and rateless trades were counted. It now says the total can exceed the gas inside the realized figures.
- **The sale form previewed a euro gain beside a dollar price.** The preview now follows the card: dollars once both rates are known.
- **With only one rate known, the preview gave no sign of it.** The "(converted on save)" marker now follows either figure falling back to the coin.

History and storage:

- **Another website could press two of the app's buttons.** Behind basic auth, a form posted from another site carried your credentials and could send a Telegram test or start a rate lookup. Every write to `/api` must now arrive as JSON, so such a form gets 415.
- **A pasted decimal comma with four or more decimals lost the comma.** "8,0773" was stored as 80,773 ETH. A comma followed by four or more digits is now a decimal point, while "12,000" still reads as thousands.
- **The server refused today's date from a reader ahead of its timezone.** A reader in Rome was refused every night from midnight to two on a UTC server. The server now allows its own tomorrow.
- **Net gain said "no rate" on trades that have no gain yet.** The chip now appears only once the ETH is sold.
- **"of which currency" was coloured backwards.** A positive figure is extra cost, so a loan that cost $500.00 more showed green. It is now coloured by what it did to you.

Stats:

- **The best trade on a ledger of losses was called the biggest gain.** The first tile now reads "Smallest loss" when its figure is a loss.
- **Realized net gain put "no rate" on the wrong condition.** It followed any missing rate, open trades included. It now follows closed trades without a dollar result, and Telegram's `/summary` got the same fix.
- **Open positions printed "$0.00" for capital of unknown size.** It reads "1 no rate" now, and `summarize` answers null for the dollar figure.
- **Total borrowed was short without saying so.** It skipped trades with no borrow rate. It now carries the "no rate" chip when it is missing any.
- **Two tooltips described more trades than their figures count.** Average hold and the by-month Trades column say closed trades with a dollar result.

Alerts and Telegram:

- **A delivered alert was shown as "not sent".** The claim never cleared an earlier error, so a 500 then a 200 left a fired alert showing an error. The claim clears it.
- **A goal reached before Telegram was set up was used up.** The sweep claimed the alert and the failed send left it fired for good. The sweep now waits until there is somewhere to send it.
- **An alert could fire on a trade sold while the sweep ran.** Whether the trade still held ETH was checked before slow lookups. The claim now asks again in the same statement.
- **`/holding` blamed the exchange rate when the ETH price was missing.** It now says the ETH price is missing.
- **The bot answered commands addressed to another bot.** `/holding@SomeOtherBot` posted the position. The bot now asks Telegram its own name once and ignores commands naming another.
- **"not watched" said the ETH was sold when the purchase had been undone.** The tooltip now names both.

## [1.1.1] - 2026-09-27

An audit of the year tabs added in 1.1.0 found four bugs, each reproduced on a scratch ledger. The arithmetic came back clean on a random ledger of 300 trades across four years.

### Fixed

- **A year tab never said what that year made.** `summaryReport` computed the year's realized net gain and blended annualized rate, but nothing drew them. Each year tab now opens with an overview card of the hero's tiles, for example +$2,380.00 at 60.33% for 2025. Open positions shows on the current year only, and All has no overview. One `statTiles` draws both.
- **The rate banner blamed the wrong year.** On a year tab it said a rateless trade was left out of "the totals below" even when that trade belonged to another year. It now says how many are in that year, for example "It is not in 2026."
- **Choosing a year by keyboard threw focus to the top of the page.** The render replaces the pressed button. Focus now moves to the new copy, and only when the old one had it.
- **`#toString` was treated as an old name for a view.** The `#summary` alias lookup used `in`, which walks the prototype, so `#toString` and `#constructor` were rewritten to `#trades`. The lookup is own keys only now.

## [1.1.0] - 2026-09-27

Summary is now Stats, and Stats is kept year by year.

### Added

- **A tab per year on Stats, plus All.** Performance, By currency and By month closed are worked out for the year picked, newest year first, and All is the view as it was. A trade counts in the year it was repaid, so a loan opened on 15 December 2025 and repaid on 2 February 2026 is 2026's; an unrepaid trade counts in the current year. On a scratch ledger, 2025 reads +$2,380.00, 2026 reads +$2,440.00 and All reads +$4,820.00. `statsYear` in `lib/calc.js` asks `derive` whether a trade is repaid, because a date with no amount is not a repayment.

### Changed

- **Summary is called Stats**, in the nav, the view heading, the README and the "Fetch rates" hint. `#summary` still opens it and is rewritten to `#stats`, and the hero tiles move to `id="hero-stats"` so the address bar does not anchor to them. `/api/summary` and the Telegram `/summary` command are unchanged.
- **The exchange-rate banner stays ledger-wide** above the tabs. Its button fetches every missing rate at once, so a count scoped to one year would describe less than the button does.
- **Total borrowed says "the trades on this tab"** instead of "everything ever borrowed", which stopped being true on a year tab.

## [1.0.1] - 2026-09-20

Two lines on the landing page that were breaking in the wrong places.

### Fixed

- **The call to action wrapped with one word alone on a second line.** The sentence came to 54ch against `.cta__sub`'s 52ch measure, which stranded `ask.` underneath. It is now sized to its content with `fit-content`, which still wraps on a phone.

### Changed

- **The hero subtitle breaks between its two sentences.** "Borrow a stablecoin, buy ETH, sell it, repay the loan." now ends a line, as the ledger's own hero already does.

## [1.0.0] - 2026-09-20

The first stable release.

The version number catches up with what the app already is: the schema migrates forward from any earlier version, and the headline figures come from the same `lib/calc.js` the server uses. From here a change to the API, the database or a stored figure is a major one.

### Changed

- **Ten rows a page, on both tables.** History and Alerts read the same `PAGE_SIZE`, so the pagers agree.
- **The Summary note is one sentence again.** The dropped paragraph explained double currency conversion, which the figures already carry and most ledgers never use. `.summary__foot + .summary__foot` went with it.

## [0.0.41] - 2026-09-20

A recursive audit of every source file, 21 files and about 10,900 lines. Three bugs were found, each reproduced before the fix, and two other suspicions were dropped.

### Fixed

- **The landing page's calls to action answered with the 404 page.** The three "Use Aave Loop" buttons and the 404 page's "Open the ledger" point at `/app`, which nothing served without nginx. `/app` now serves the same file as `/`.
- **The Telegram summary could report a blended rate of `-0.00%`.** `pct2` was the one formatter in `format.js` not using `signOf`. It does now.
- **An alert could report `Gain: -$0.00`.** `alertMessage` built its own sign from the held value instead of using `signedUsd`. Half an ETH at 3.1% with goal 24,207.91 reproduced it, and the live preview showed it too.

### Removed

- `PROMPTS.md`. The audit prompts have done their work, and their findings are in the entries above.

## [0.0.40] - 2026-09-20

Eight bugs across the three views, each reproduced against a seeded ledger before the fix.

### Fixed

- **A sold trade went on advertising a price alert nothing was watching.** `selectArmed` requires the trade to still hold ETH, but `armedAlerts` did not, so the Bought ETH card kept naming the goal. The card now applies `derive`'s own test.
- **The Alerts table called the same alert ARMED.** With the trade sold the sweep selects nothing, yet the table read ARMED. It now carries a "not watched" note saying restoring the trade puts it back under watch.
- **The bell and the Alerts table contradicted each other once an alert fired.** `loadAlertLog` left `state.alerts` stale, so a lit bell sat beside a FIRED row. The armed map is now rebuilt from the same answer with no second request.
- **"Biggest loss" was a label the ledger had not earned.** It tested `< 0` alone, so a trade printing `$0.00` or a brand new ledger announced a loss. Both now agree with the digits shown.
- **By currency: Avg annualized took its colour from net gain.** A rate that rounds to 0.00% is no longer painted green by the dollar figure behind it, the same defect fixed in the Trades table in 0.0.39.
- **By month: the share bar disagreed with the figure beside it.** A month netting under half a cent showed `$0.00` next to a red sliver. The bar now uses the printed value, and `.bar__fill--flat` draws it neutral.
- **The rate banner said more than it meant.** It claimed a trade is left out of the totals, but only its result is left out. The banner and `TIPS.totalBorrowed` now say so.
- **`extremeCard` was dead.** It was unused since `perfExtreme` replaced it in 0.0.35 and still coloured a rate from a dollar figure, so it is removed.

## [0.0.39] - 2026-09-20

Four bugs in the Trades view, each reproduced against a seeded ledger before the fix. A fifth candidate was dropped as unreachable.

### Fixed

- **A figure too small to show carried a minus and a colour.** A trade level to within half a cent printed `-$0.00` in red, for example 30,000 USDC at 4% with a partial sale netting -0.0043. `usd`, `signedUsd`, `money`, `signedMoney`, `pct` and `gainClass` now share the one helper that decides from the printed figure.
- **Annualized took its colour from the dollar gain, not from the rate beside it.** A green `+$0.01` sat next to 0.00%. The column and the card row now use `pctClass(d.pct)`.
- **A saved stage did not follow its row to another page.** With 23 trades sorted oldest first, moving one trade date to today sent it to page 2 while the toast said saved and the row vanished. The view now follows the row, as `submitBorrow` already did.
- **The table pushed the whole page sideways on a tablet.** The eight columns need about 980px, but the card layout starts at 760, so a 768px iPad dragged the page 252px sideways. The table now scrolls inside its own card between 761 and 1080px only, so tooltips above that are not clipped.

## [0.0.38] - 2026-09-20

A quality pass over 0.0.37, with four findings: two facts written twice, one needless await and three misleading comments.

### Changed

- **The version lifecycle stages what it changed, not a list of what it expected to change.** `package.json` and `scripts/stamp-version.mjs` each named the same two pages, so a third page could be stamped and left out of the commit. `git add -u` is safe because `npm version` refuses a dirty tree.
- **The footer's version is no longer awaited before the ledger loads.** `boot()` held every other request behind `/api/version`, which only corrects an older build. The four requests now start together.
- **`stamp-version.mjs` finds the pages the way the rest of the repo finds a file.** It resolved paths against the working directory instead of `import.meta.url`, so a failure would be a raw `ENOENT`.

## [0.0.37] - 2026-09-20

The Summary note says which figures were converted, and the app gets a link style of its own. Fourteen findings from a review of 0.0.36, each reproduced before the fix.

### Fixed

- **The Summary note said every figure was converted at an ECB rate.** Splitting it in 0.0.36 dropped "Amounts in a currency other than the dollar are". Four of five currencies are pegged and `rateOf` returns 1, so a USDC ledger was told it was converted twice. Both sentences are scoped again.
- **The note said "for the day of each transaction".** The ECB publishes on business days, so a Sunday trade carries Friday's rate. It now says "or for the last business day before it".
- **The link's dotted underline is solid.** Dotted is `.th-tip`, which means a header that explains itself. The underline now uses `--text-muted`, since `--text-faint` was 2.5:1 and failed the 3:1 of WCAG 1.4.11.
- **The note announces that it opens a new tab.**

### Changed

- **The note is two paragraphs, not one with a `<br />`.** The break depended on `max-width: 108ch` matching the prose. The measure is back to 68ch, chosen for reading.
- **A base `a` rule.** The stylesheet had only container-scoped link rules, and the note's anchor copied `.th-tip`'s declarations. One generic rule now exists, and the scoped rules override it unchanged.
- **`npm version` stamps the version everywhere it is written.** It was hand-edited in three files, and `package-lock.json` had drifted 31 releases to 0.0.5. The lock is back in step.

## [0.0.36] - 2026-09-20

### Changed

- **The Summary note links to the ECB's rates and reads as two lines.** The phrase now links to the ECB's euro foreign exchange reference rates page, which has the daily rates and CSV, XML and SDMX history. The consequence starts on its own line.
- **The link sits on the existing phrase.** "European Central Bank reference rate" is unchanged and now points to where the rates are published, as `db.js`, `fx.js` and the README already claim.

## [0.0.35] - 2026-09-20

What ETH costs, in the header on every tab, and a Performance card that ranks a gain two ways.

### Added

- **The ETH price in the header**, with the 1h, 24h and 7d change. It refreshes every five minutes, pauses while the tab is hidden, and keeps the last figure if the price service is unreachable.
- **`GET /api/eth`**, its own route. Polling `/api/alerts` for one number was the wrong shape, the same argument that split out the alert log in 0.0.33.
- **The 1h window.** It rides in the same `/coins/markets` call, so there is no second request. `eth_price` gains a nullable `change_1h`.
- **Biggest and smallest gain in %**, ranked on the annualized rate beside the two ranked on dollars. A four day trade that made $75 can be the best return and the smallest cheque at once.

### Changed

- **The Performance card is three tiles then four.** The second row reads gain, loss, gain, loss, so the dollar and rate pairs line up.
- **Win rate is gone** from the card. `winRate`, `wins` and `losses` stay on `GET /api/summary`.
- **"Biggest gain" and "Smallest gain" say in USD**, and both pairs still flip to "Biggest loss" once a losing trade exists.
- **The ranking tooltips are rewritten.** The rate ones warn that a same-day trade is scaled to a full year and can post an enormous figure on a small gain.
- **`MYAAVE_ETH_POLL_MS` overrides the ticker interval.** The page refuses anything under thirty seconds.

### Fixed

- **The header and the alert window could show two ETH prices.** The window read $3,333.00 under a header reading $3,000.00. `/api/alerts` now carries the change windows, so one answer feeds both and the newer wins.
- **The same figure was drawn in two colours.** -0.04% and +0.02% both print `0.0%`, one red and one green. Colour now follows the printed figure, so a tiny movement is drawn flat.
- **The row could not be read out or copied.** Flex hid the gaps, giving `ETH: $3,000.001h+1.4%24h-1.5%`. The spaces are now in the markup.
- **Every switch back to the tab fired a request.** It now asks on return only when its figure is due.

## [0.0.34] - 2026-09-20

An audit of the three views. Nine findings, each reproduced before the fix and again after.

### Fixed

- **A deleted alert came back.** A delete during the log request was undone by the reply. `loadAlertLog` now discards a reply that a newer load overtook or a write superseded, like `loadTrades` since 0.0.20.
- **A message that never went could be filed as sent.** A retryable failure re-armed the old alert beside a newer goal, which the unique index refuses, leaving the row `fired` with no error. Re-arming is now refused when a newer goal is watching, so the "not sent" note shows.
- **One bad alert cost the whole sweep.** A throw skipped every later alert for fifteen minutes. Each alert is now tried on its own.
- **The sweep and the page disagreed about "still holding".** `stages()` needs date, amount and ETH for a sale, but the query checked `sell_date` alone. Both halves are now spelled out, here and in `/holding`.
- **On an upright tablet, Delete was off the edge of the screen.** The "not sent" note widened Status. It now sits under the pill and the table padding tightens between 760px and wider widths.
- **"Total borrowed" said it did not know.** It only showed once a trade was repaid, though it counts open trades too. The gate is fixed.
- **A zero was written two ways in one table.** *By currency* printed "0" under Closed and a dash under Open.
- **Escape in the price alert window threw away the form behind it.** The alert window now stops the key, as the confirmation window has since 0.0.33.

### Changed

- **The expanded row names the trade's own id.** It showed the sort position instead of `#N`. It now reads `Trade #7 · row 4 of 10 · added 1 Aug 2026`.

## [0.0.33] - 2026-09-20

An Alerts view, and a fired alert that is kept rather than overwritten.

### Added

- **An Alerts view**, third after Summary. It lists every alert, newest first, fifteen to a page, with the fired date, time and price. Each row deletes, and **Delete all alerts** clears the list. Both ask first, and the delete-all text names how many are still armed.
- **A fired alert is kept.** A new goal can be set on the same trade while the fired one stays in the view. Before, a second goal overwrote the only record of the first.
- **New endpoints and dialog.** `GET /api/alerts/log`, `DELETE /api/alerts` and a `confirmDialog()` in a second `<dialog>`, now used by Delete trade too. No browser `confirm()` remains.

### Changed

- **Alerts have an id of their own.** The table is rebuilt once on open, detected by shape and re-checked in an immediate transaction. At most one *armed* alert per trade is now a partial unique index, which stops the sweep and `/holding` double-counting.
- **The alert routes are scoped to an alert, and two moved** to `PUT /api/trades/:id/alert` and `GET /api/trades/:id/alert/preview`. An old tab now gets 404 instead of deleting another trade's alert with a 204.
- **The Performance card is six tiles.** Realized net gain, Blended annualized and "Of which currency" are dropped, since they already lead every view.
- **The landing page hero carries the real logo**, the 96px derivative, instead of a hand-traced glyph.

### Fixed

- **A failed send would have rewritten a trade's alert history.** The follow-up statements in `fire()` used `WHERE trade_id` with no status filter and would re-arm every fired alert. Both now key on the alert's own id.
- **Two clicks on Delete in one tick left no confirmation.** `close()` queues its event, so the handler wiped and closed the reopened window. Nothing was deleted.
- **Neither dialog ever cleared its markup.** An engine need not dispatch `close` for a script `close()`, so a typed goal stayed in the document. Both now clear on the way out.

## [0.0.32] - 2026-09-20

An audit of every file. Twenty-two findings across twelve of them.

### Fixed

- **A Telegram 429 was filed as permanent.** A flood-controlled alert stayed `fired` and was never sent. 429 is now retryable like 5xx.
- **`eth.js` threw from a function documented not to.** `cachedEthPrice` did not guard its statement, so a refused read rejected the promise. It is now a cache miss.
- **A failed cache write threw away a good price.** The write is now best effort and the price is returned either way.
- **Four callers, four requests.** One `ethPrice` request is now shared by everyone waiting: one HTTP request for four concurrent callers.
- **`fx.js` could walk from 1970.** `resolveRange` coerced an unreadable date to 0. The bounds are checked first, and the loop uses `DAY_MS`.
- **The rate cache could throw on the save path**, fixed like `eth.js`.
- **`/api` exactly answered with the browser's HTML error page.** The 404 handler matched only `/api/`.
- **`n2` and `n4` returned the string "NaN"** for non-numbers. They now return "-" like the other formatters.
- **A figure too small to show still carried a minus sign**, as `-$0.00` in red. The sign now comes from the printed figure.
- **`.card--warn` coloured nothing.** Cards draw a ring, not a border. It is a ring now.
- **The bot sat on its lease after stopping itself.** A rejected token blocked other instances until it expired. The lease is now released.
- **Commands past the per-batch cap vanished silently.** They are still dropped, but the log says how many.
- **`holdingMessage` and `summaryMessage` read the database outside any try.** A chat command now says the ledger could not be read.

### Removed

- **The `/favicon.ico` route**, which `express.static` already answered.
- **`dataDir` in `db.js`**, which created `data/` even when `MYAAVE_DB` pointed elsewhere.
- **Unused declarations:** `AMOUNT_FIELDS` and the `annualizedPct` import in `public/app.js`, the `n2` import in `report.js`, and `--mono` in the stylesheet.
- **Dead landing CSS:** an overridden `padding-top` and a second `.step__body` block.

## [0.0.31] - 2026-09-20

### Changed

- **`/summary` is a table rather than a paragraph.** Labels carry a colon and the figures line up inside a `pre` block, because Telegram draws text proportionally. The open-positions footnote is gone.

## [0.0.30] - 2026-09-20

### Fixed

- **An unreadable `config.env` was reported as missing.** `readFile` returned null for a missing file and a refused one alike, so a wrongly owned file got "No config.env yet". It now says the file is unreadable and to check who owns it.

## [0.0.29] - 2026-09-20

### Fixed

- **"send this to your Telegram chat on Telegram."** The fallback chat name repeated the word Telegram. It is "your chat" now.

## [0.0.28] - 2026-09-20

### Changed

- **The social card is referenced as `landing/og3.png`.** It is a new filename because a scraper caches the image by URL. `og.png` and `og2.png` stay in place.

## [0.0.27] - 2026-09-20

### Removed

- **`TELEGRAM_GROUP_NAME` is no longer read.** `TELEGRAM_CHAT_NAME` is the only name, and a file with the old key falls back to "your Telegram chat".

## [0.0.26] - 2026-09-20

Three bugs from an audit of the bot, the alert sweep and the theme, and the wording stops assuming there is a group.

### Fixed

- **The bot answered a private command in the group.** `reply()` could not name a destination, so a `/holding` typed privately went to `TELEGRAM_CHAT_ID`. `sendTelegramMessage` takes an optional `chatId`, and the answer goes to the chat that asked.
- **A refused database read in the alert sweep took the server down.** `selectArmed()` sat outside the try, so a refused read became an unhandled rejection and `process.exit(1)`. It is inside the try now, and a failed sweep waits for the next tick.
- **Opening the ledger stopped the landing page following the system theme.** `boot()` called `applyTheme`, which also wrote `myaave-theme`. Boot now draws the glyph without recording a choice.

### Changed

- **The wording no longer assumes a group.** Alerts go wherever `TELEGRAM_CHAT_ID` points, so the alert window now says "We will send this to X on Telegram".
- **`TELEGRAM_CHAT_NAME` names the display-only setting.** `TELEGRAM_GROUP_NAME` still works. The unset fallback is "your Telegram chat".
- **`config.env.example` explains chat ids.** It warns that a group's id is rewritten when it becomes a supergroup.
- **The README treats the private chat as an option.** It notes that a pinned list of commands makes each `/command` tappable.

## [0.0.25] - 2026-09-20

### Added

- **`TELEGRAM_OWNER_ID`, optional.** The bot answers commands in your private chat as well as the group, since Telegram draws its Menu button only in private chats. Unset, nothing changes.
- **Alerts are unaffected.** They still go to `TELEGRAM_CHAT_ID` alone.

## [0.0.24] - 2026-09-20

The bot answers back: five commands, in the group and nowhere else.

### Added

- **`/price`, `/holding`, `/summary`, `/watch` and `/unwatch`**, plus `/help` and `/start`. `/summary` uses the page's `summarize()`. `/watch` sends the price report every twenty minutes until `/unwatch` and survives a restart.
- **`bot.js` reads commands by long polling**, so nothing has to be reachable from the internet.
- **`report.js` builds every message as a pure function**, and **`format.js`** holds formatting shared by the bot and alerts.
- **`lib/calc.js` gains `unrealisedUsd`**, moved out of `alerts.js`. It takes the price as an argument.

### Changed

- **One price source.** `eth.js` moves from `/simple/price` to `/coins/markets`, which also returns 24h, 7d and 30d change. `eth_price` gains three nullable columns.
- **`sendTelegramMessage` takes an optional `parseMode`.** Only the bot's tables ask for HTML, since columns line up only inside a `pre`.
- **Commands are `/watch` and `/unwatch`, not `/price-on` and `/price-off`.** A hyphen ends a command name.

### Security

- **Only `TELEGRAM_CHAT_ID` is answered.** Commands from other chats are dropped silently, with one log line per unknown chat per run.
- **Nothing calls `setMyCommands` or `deleteWebhook`.** Both change the bot for every chat.

## [0.0.23] - 2026-09-20

The app wears its own mark, and the name comes off the social card.

### Changed

- **The brand mark is Aave Loop's own logo.** The app had worn Aave's. Pages load a 96px derivative of `AaveLoop_logo.png` instead of the 941KB master.
- **`favicon.ico` and the apple-touch icon are regenerated from that logo.** The touch icon is square and opaque because iOS applies its own mask.
- **The social card is redrawn as `landing/og2.png`.** The wordmark loses "Ledger" and uses the new logo. It is a new filename because a scraper caches by URL.
- **The README is half the length.** It drops the "Landing page" and "Running behind a proxy" sections.
- **This file is a third shorter.** Same releases, same facts, less retelling.

### Removed

- **`public/aaveLogo.png`**, which nothing references any more.
- **`landing/favicon.svg`**, a hand-traced copy that had drifted from the artwork. The pages name the ico directly.

## [0.0.22] - 2026-09-20

A trade whose ETH is still held can now say what price it is waiting for, and be told when it gets there.

### Added

- **Price alerts.** While a trade is HOLDING, the **Bought ETH** card carries a bell that takes a goal price. A Telegram group gets a message once ETH reaches it. There is one alert per trade, and **Remove alert** deletes it.
- **The message is shown before it is sent**, built by the same function that sends it, so nothing goes into a group unread.
- **`config.env`, read by `config.js`:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and a display-only `TELEGRAM_GROUP_NAME`. `process.env` wins. The file is gitignored, with `config.env.example` committed.
- **`eth.js` fetches the ETH spot price from CoinGecko** with no key. It has a timeout, a failure cooldown, a cache, and a ten-minute cooldown on a 429 that honours `Retry-After`.
- **`telegram.js` sends plain text** with no `parse_mode`, since an underscore in a group name would fail silently. The token is redacted from errors.
- **`alerts.js` holds the alerts and a fifteen-minute timer.** A ledger with no armed alerts never touches the network.
- **New endpoints:** `GET /api/alerts`, `PUT` and `DELETE /api/alerts/:id`, `GET /api/alerts/:id/preview` and `POST /api/alerts/test`.
- **A setting-up section in the README.** Six steps, including two that fail like a broken app: `getUpdates` is empty unless the message starts with a slash, and the file is read once at startup. It documents `MYAAVE_CONFIG`.

## [0.0.21] - 2026-09-20

### Changed

- **The app is called Aave Loop.** "Ledger" is dropped from the wordmark, pages, cards, README, startup log, `package.json` and `PROMPTS.md`. The 0.0.2 entry keeps the old name.

## [0.0.20] - 2026-09-20

The four items 0.0.19 knowingly left open. One of them turned out to lose a save from the screen.

### Fixed

- **A save could be silently undone on screen.** A stage saved during a **Fetch rates** reload was put back when it landed, so a CLOSED trade reverted to SOLD. `loadTrades` now discards a reply that a newer load overtook.
- **A cross-stage error named the wrong field.** The server's message names the stage collided with. The form now checks both sides and flags the field being edited.
- **A dropped amount was read as if typed.** `sanitizeNumeric` treated only `insertFromPaste` as complete, so a dropped `32.000,00` became 32. Typing is unchanged.

### Changed

- **"Open positions" says when its total is incomplete**, with the same `no rate` chip as elsewhere.
- **"Total borrowed" states that a trade waiting on a rate is left out.**

## [0.0.19] - 2026-09-20

Five bugs from an audit of the money path, the date path and the forms.

### Fixed

- **"Gross gain" quoted a rate that did not produce it.** The line named only the sale rate, so 1,800.00 EURC read `+$2,228.40 at 1.1380`. It quotes no rate now.
- **The two lines of *Borrowed* counted different trades.** The dollar total used only known rates while the coin total counted all. Both now cover known-rate trades.
- **A live hint painted over a field's error.** An invalid field keeps its error until that field is edited.
- **The stage preview used the old date's rate.** Moving a repayment from 17 May to 15 July kept the 15 May rate. The preview now drops the stored rate and says "(converted on save)".
- **"Added" named the wrong day.** `created_at` is UTC, so a trade added at 00:09 in Berlin showed the day before. It follows `todayISO` now.

## [0.0.18] - 2026-09-19

### Changed

- **Tooltips are drawn by CSS.** They appear at once and work on a tap, unlike native `title`.
- **The explanation marker is a real button.** Keyboards and screen readers can now reach it.

### Added

- **Every Summary figure says what it means.** Performance rows and *By currency* and *By month closed* headers name the trades they count.
- **The "no rate" chip carries its explanation** the same way.

### Fixed

- **"Of which currency" painted a saving red.** A negative figure means the currency moved in your favour, so only the colour changed.

## [0.0.17] - 2026-09-19

Eight bugs in the exchange rate lookup. Trades whose rate was already correct do not change.

### Fixed

- **ECB holidays counted as missing forever.** Days like Christmas were re-fetched on every refresh. They are now re-asked only for a few days.
- **A stand-in rate was cached forever.** Such rates are now re-asked while the day is recent.
- **Nothing ever asked for a refresh.** **Fetch rates** posted `refresh: false`, so `tradesWithSubstitutedFx` was unreachable.
- **The Fetch rates button hid when needed.** It now also appears for a recent stand-in rate.
- **`refresh` disabled the cache for every date.** It now touches only replaced dates.
- **A refresh misreported its work.** `filled` and `stillMissing` counted wrongly.
- **Span requests timed out too soon.** Spans now get fifteen seconds, not 2.5.
- **A backfill grouped days by coin, not peg.** A second euro coin would have fetched the same span twice.

## [0.0.16] - 2026-09-19

### Added

- **Every history column sorts.** Click a header, click again to reverse.
- **Rows with no value sort last in both directions.** Ties break on id, so rows never reshuffle.
- **Pagination, 15 to a page.** Hidden below 16 trades, and windowed once there are more than seven pages.
- **The chosen sort is remembered between visits.** The page is not.
- **Narrow screens get a sort select.** Below 760px it replaces the header row.

## [0.0.15] - 2026-09-19

### Fixed

- **"Total borrowed" disagreed with the by-currency table.** It counted only closed trades. It now counts every trade.
- **"Average hold" used a different set of trades** than the money figures. They now match.

### Changed

- **"Average annualized" is now "Blended annualized".** It weights capital by amount and time.
- **"Best trade" and "Worst trade" are now "Biggest gain" and "Biggest loss".** They are ranked by dollars.
- **The header wordmark links to the public page.**

### Added

- **`PROMPTS.md`.** It holds the bug-hunting prompt.
- **Social preview cards.** Open Graph and Twitter tags with a 1200x630 image at `landing/og.png`.
- **A real `favicon.ico` and an apple-touch icon.** The app also carries `noindex`.

## [0.0.14] - 2026-09-19

### Fixed

- **Exchange-rate lines on EURC stage cards were clipped.** The cell now resets `white-space: nowrap`.
- **The loan cost breakdown ran on in a third line.** It is now two rows.

## [0.0.13] - 2026-09-19

### Security

- **The app could be framed.** `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are now sent.
- **`X-Powered-By: Express` is no longer advertised.**

## [0.0.12] - 2026-09-19

### Changed

- **The Ask for Access button carries an envelope.** It shows that it opens a mail client.

### Fixed

- **The landing page footer still read v0.0.10.** It now shows the current version.

## [0.0.11] - 2026-09-19

The four low severity items left open by the 0.0.7 audit, all in the rate lookup.

### Fixed

- **A backfill pulled every day between distant trades.** Two trades six years apart fetched 2,435 days. Days now group into runs.
- **A backfill had no time limit.** It now stops after twenty seconds and reports the rest as still missing.
- **Weekend trades were listed as replaceable stand-ins forever.** Only business days are listed now.
- **`derive` reported the rate source once per stage.** It is now reported once as `fxSource`.

## [0.0.10] - 2026-09-19

### Fixed

- **Every proxied request got `This ledger only answers on localhost.`** `MYAAVE_ALLOWED_HOSTS` now names the hosts a proxy may present.
- **Unknown paths under `/api` returned an HTML error page.** They now return JSON.

### Added

- **A 404 page at `landing/404.html`.** The nginx handler needs `auth_basic off`.

### Changed

- **The landing page drops the self-hosting card** and gains an **Ask for Access** button.

## [0.0.9] - 2026-09-19

### Changed

- **The Trade column shows the loop's span,** such as `10 Jan 2026 to 13 Jan 2026`, once the trade is repaid.
- **A non-dollar trade shows its native amount on its own line** above the dates.
- **In card mode the Trade label aligns to the top of its cell.**

## [0.0.8] - 2026-09-19

### Added

- **A public landing page at `/`, in `landing/`.** It has a **Use Aave Loop** button and nginx serves it statically.
- **The page shares the app's `myaave-theme` setting.** First time visitors get the system preference.

## [0.0.7] - 2026-09-19

Twenty-two defects found by an audit. No new features.

### Security

- **The API answered any `Host` header.** Requests must now be addressed to loopback.
- **The backfill stored whatever the rate service sent.** `resolveRange` skipped the check `resolveRate` applies, so `-999999` was accepted. Both now validate, and `fmtDate` escapes its result.

### Fixed, crashes and races

- **`GET /api/fx/rate` had no error handling.** A throw hung the request and exited the process.
- **Editing a borrow threw `ReferenceError: Cannot access 'c' before initialization`.** The interest-per-day hint never appeared.
- **Two `PATCH` requests for one trade interleaved.** Writes are now serialized per trade.
- **A rate backfill could pin a rate to a stage that had moved.** It now re-reads each row inside its transaction.

### Fixed, in the dates

- **`todayISO()` returned the UTC date.** Today now comes from the local calendar.
- **The server let a future date through.** Its slack let tomorrow through.

### Fixed, in the maths

- **Average annualized was weighted by loan size alone.** The weight is now capital times time, so 109.5% becomes 38.1%.
- **The by-currency table left open trades out of Borrowed.** It now counts them.
- **A flat trade was counted as a loss.** Flat trades are now left out of the win rate.
- **A closed trade without a rate made Realized net gain read `+$0.00`.** The total is now marked unknown.

### Fixed, in the numbers people paste

- **A European amount was gutted.** `32.000,00` became 32. Pasted amounts are now read correctly.
- **A half typed `1500.` was rejected.** The form now accepts it.
- **The form and server disagreed on `1e5`.** Both now use one parser in `lib/calc.js` that refuses non-numbers.
- **A single space APR was stored as 0%.** Whitespace now counts as blank.

### Fixed, in the interface

- **An error refocused the same field.** It no longer does.
- **Double clicking Create trade posted the borrow twice.** Buttons now disable during a request.
- **Derived figures were a snapshot from page load.** They now stay current across midnight.
- **A failed Fetch rates left the button stuck on "Fetching...".** It now resets.

### Fixed, on the server

- **Clearing a stage's amounts left a CLOSED row with null net gain.** It dropped out of realized totals.
- **An oversized request body returned a 500.** It is now a 413.
- **Losing the lock race to a second instance returned a 500.** It is now a 503 saying to try again.
- **Caching a span of rates committed once per day.** It is now one transaction.

## [0.0.6] - 2026-09-19

### Added

- **EURC as a fifth borrowable currency.** Uses the ECB rate for each stage's date.
- **Cost split on the Repaid card.** Splits interest from currency effect.
- **Cached exchange rates.** A trade without a rate is marked, left out of totals, and filled in by **Fetch rates**.
- **New endpoints.** `GET /api/fx/rate`, `GET /api/fx/status` and `POST /api/fx/backfill` answer 200 offline.

### Fixed

- **Cross-currency totals treated a token as a dollar.** A 50,000 EURC borrow showed as $50,000.
- **ETH buy and sell price had the wrong unit.** It showed euros under a dollar sign.
- **Best and worst trade compared native amounts.** Now compared in dollars.

### Changed

- **Schema additions.** Nine nullable columns and a rate cache table, added on first open.
- **Rates are server-side only.** Submitted exchange rates are rejected.
- **Label rename.** "Stablecoin" is now "Currency".

## [0.0.5] - 2026-09-19

### Added

- **`resetDatabase.sh`.** Empties the ledger, asks twice, keeps a backup.

### Changed

- **Stage cards state money in the borrowed coin.** For example "32,000.00 USDT".
- **Amount fields show the ticker.**

### Fixed, in the maths

- **Repaid card showed theoretical interest.** It now shows interest actually paid.
- **Repayment preview used its own formula.** On a partial sale it read -4,028.77, not +971.23.
- **Repayment below principal counted as profit.** Repaying 20,000 on a 32,000 loan showed a 14,824 gain.
- **A trade could be repaid without being sold.** Stages must be filled in order.
- **`summarize` and `summaryReport` disagreed on closed trades.** The sort also gave NaN from two nulls.
- **A typed `0` counted as empty, and future dates broke interest.** Future dates are now refused.

### Fixed, in the interface

- **Pasted amounts like `$12000` left the field empty.** Amounts are now collected as text.
- **Invalid values only failed at the server.** Now caught in the form.
- **A blank form submitted blanks.** Fields are now checked first.
- **Errors stayed after correction.**
- **Edits in progress were lost when the view changed.**
- **Stage forms ignored each other.** Selling more ETH than bought is now caught.

## [0.0.4] - 2026-09-19

### Added

- **A real Summary view.** Shows performance by stablecoin, net gain by month, win rate and more.
- **Nav switches views.** It supports deep links such as `#summary`.

### Fixed

- **Nav hidden below 760px.** It is now a segmented control.
- **Grid tracks overflowed on narrow screens.** `minmax(260px, 1fr)` clipped values.
- **Stale ledger from browser caching.** API responses are now `no-store`, static assets `no-cache`.
- **`/favicon.ico` returned 404.** It redirects to the app icon.

## [0.0.3] - 2026-09-19

### Changed

- **APR column dropped from the trades table.**
- **Page subtitle** is broken across two lines.

## [0.0.2] - 2026-09-19

### Changed

- **Renamed** the app to Aave Loop Ledger.
- **Number formats.** USD shows two decimals, ETH four.
- **Footer** is right aligned and credits the author.
- **Loopback only.** The server no longer exposes the app to the network.

### Fixed

- **Gross gain on a partial sale** compared proceeds to the whole purchase. It now uses the cost basis of the ETH sold.
- **Annualized return with backwards dates.** It now returns nothing for a negative span.
- **0% APR was rejected.** Rates may be zero.
- **Clearing a required borrow field via the API** gave a server error. It now gives a validation message.
- **Bad dates and bad JSON.** A repayment could precede its sale; malformed JSON gave a server error.
- **Stray write ahead log.** The database is checkpointed on shutdown, and a second instance waits on a busy timeout.
- **Prepared statements** are cached.
- **Dark mode** now sets `color-scheme`.
- **Silent failures.** A failed delete and an unreachable server now show.

## [0.0.1] - 2026-09-19

### Added

- **Four-stage trade lifecycle.** Borrow, buy ETH, sell ETH, repay; a trade can be Open, Holding, Sold or Closed.
- **Derived figures.** Gross gain, accrued interest, net gain, annualized return.
- **SQLite storage** with history, plus view, edit and delete.
- **Light and dark themes** modelled on app.aave.com.
- **`run_myAave.sh` launcher** with dependency, port and Node checks.
