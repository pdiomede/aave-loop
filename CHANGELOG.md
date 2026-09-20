# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

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

### Notes

- Alerts, the test message and the `/watch` report are unchanged and still go to `TELEGRAM_CHAT_ID` alone. The watch switch is one row with no chat on it, so a `/watch` asked for privately is confirmed privately and still reports to `TELEGRAM_CHAT_ID`.
- Verified by execution: a stubbed Telegram API answering a batch of four messages - the group, the private chat twice, and a third chat - with every reply's `chat_id` checked; the sweep driven from a timer with its table dropped, which crashed the process before and logged after; and the whole server through create, each stage, a partial sale, repay, the alert endpoints, the 400/403/404/413 paths and SIGTERM.

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

### Notes

- **Telegram hands each update to one caller of `getUpdates` and refuses the second**, so the two instances this app already tolerates would have stolen each other's commands. A lease in `bot_state`, taken with the same conditional UPDATE the alerts use to claim a firing, settles which one polls; the other never calls Telegram at all. Verified with two instances against one database: one reply to one command, and takeover within seconds of killing the holder.
- **The offset lives in the database, and is committed before a command is answered**, so a handover resumes where the last holder got to rather than from whatever a variable happened to say. At-most-once on purpose: a crash between the two loses a command, which costs six keystrokes, where the other order could put the same message in the group twice.
- **A long poll is aborted on shutdown.** There is no `unref` for a fetch, so without that, stopping the app waited out the rest of a fifty second request. Measured: 0.3s against a server that never answers.
- Commands older than ten minutes are confirmed and not answered, so coming back from an afternoon of downtime does not fire an afternoon of replies.
- A rejected token stops the loop after one attempt rather than retrying forever; a 409 backs off and, when it names a webhook, says how to remove it.
- `README.md` step 3 gained a warning: `curl .../getUpdates` to find the chat id only works before the app is running, or with `MYAAVE_BOT_OFF=1`, because the app is now the other reader of that queue.
- Verified by execution: every command including `@name`, capitals, arguments and nonsense; a foreign chat; a stale backlog; the lease and its handover; shutdown mid-poll; 401 and 409; a trade with no exchange rate showing a dash rather than being summed; and an alert still sending plain text with no `parse_mode`.

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

### Notes

- `MYAAVE_ALLOWED_HOSTS` left the README with the proxy section it was documented in. It is still read and still needed behind nginx; 0.0.10 below is what explains it now.
- The footers read 0.0.23. The landing page's is hand-maintained, because `/api/version` sits behind auth, and the app's is a static fallback for the same reason.

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

### Notes

- **An alert is claimed before the message is sent**, by a conditional `UPDATE ... WHERE status = 'armed'`, so two copies of the app polling one database cannot both send it. Verified with two instances at a fast poll: one message, over nine ticks.
- **An armed alert is only checked while the trade is still holding ETH** - the purchase recorded in full and no sale - so selling disarms it without deleting it and undoing a sale brings it back. Asking only whether it had been sold let an alert on an undone purchase send "Bought 0.0000 ETH for 0.00 USDC".
- A timeout leaves delivery genuinely unknown, so the alert re-arms and is retried up to three times; a refusal such as "no such chat" will say the same next time, so it stays fired with the reason on the card.
- **Which way an alert reads is decided against ETH's current price, not what was paid for it.** With ETH at 3,000 and a purchase at 2,500, a goal of 2,600 means "tell me if it falls back"; against the purchase price it is an upward goal already met, and the next tick fired it. The fallback is `buyPriceUsd`, never `buyPrice`, which on a EURC loan is euros per ETH.
- **Without `config.env` the app is what it was**: it boots, the bell works, goals are saved, and the window says what is missing. `.gitignore` did not cover the file - `.env.*` matches a file beginning `.env.` - so it would have been committed with a live token.
- Smaller: the window fetches the alert and a fresh price each time it opens rather than once at page load; `Retry-After` is honoured upward, bounded at an hour; a variable exported empty no longer masks a filled-in `config.env`; a stale preview is discarded; a failed **Remove alert** says so; and the alert keeps no copy of the trade's amount, date or purchase price, any of which an edit can move.
- The alert window is the first modal, and lives in the page shell rather than in the card that opens it, because the trades table is rebuilt wholesale on every render. `.modal` sets `color` explicitly, since a `dialog` is given near-black `CanvasText`.
- Verified by execution: the fire path, no second message after firing, two instances against one database, the disarm on sale, cascade delete, a clean shutdown mid-sweep, and both themes at 1440px and 375px.

## [0.0.21] - 2026-09-20

### Changed

- **The app is called Aave Loop.** "Ledger" is dropped from the wordmark, the landing page and its 404, both page titles, the Open Graph and Twitter cards, the README, the startup log, the reset script's banner, the `package.json` description and the two prompts in `PROMPTS.md`. The 0.0.2 entry below keeps the old name, because that is what happened at 0.0.2.

### Notes

- The lowercase "ledger" is left alone where it is the ordinary word for what the app holds, since that is a description and not a name.
- The landing page footer is hand-maintained, because `/api/version` sits behind auth. It reads 0.0.21, as does the static fallback in the app's own footer.

## [0.0.20] - 2026-09-20

The four items 0.0.19 knowingly left open. One of them turned out to lose a save from the screen.

### Fixed

- **A save could be silently undone on screen.** **Fetch rates** reloads the whole ledger, and a stage saved while that reload was on the wire was put back when it landed: a trade saved as CLOSED reverted to SOLD, with no error, until the page was reloaded. The server had it right throughout. `loadTrades` now discards a reply that a newer load has overtaken, or that a write superseded in flight.
- **A cross-stage error named the wrong field, so no field was marked.** Moving an early stage past a later one passed the form and was caught only by the server, whose message names the stage it *collided with* rather than the one being edited. The form checks these from both sides now and flags the field being edited. Same-day stages are still allowed.
- **A dropped amount was read as if it had been typed.** `sanitizeNumeric` treated only `insertFromPaste` as a complete value, so a dropped or autofilled `32.000,00` recorded a 32,000 loan as 32 - the failure 0.0.7 fixed for pasting. Typing is unchanged.

### Changed

- **"Open positions" says when its total is incomplete**, carrying the same `no rate` chip as the rest of the app rather than printing a total that is short without saying so.
- "Total borrowed" states that a trade waiting on a rate is left out, in step with every other figure on that card.

### Notes

- Verified by execution, with the 0.0.19 suite re-run unchanged: both FX invariants across 40,000 generated trades and 200 portfolios, aggregate reconciliation, the server bounds matrix, and no overflow at 1440px or 390px in either theme.

## [0.0.19] - 2026-09-20

Five bugs from an audit of the money path, the date path and the forms.

### Fixed

- **"Gross gain" quoted a rate that did not produce it.** The figure is the proceeds at the sale's rate less the cost basis at the purchase's, and the line under it named the sale rate alone: 1,800.00 EURC read `+$2,228.40 at 1.1380`, and 1,800 × 1.1380 is 2,048.40. It quotes no rate now, as "Net gain" and "Loan cost" already did.
- **The two lines of *Borrowed* in the currency table counted different trades.** The dollar total included only trades whose rate was known while the total in the coin counted every trade, so a cell read `$155,225.00` over `210,000.00 EURC`. Both lines now cover the trades whose rate is known.
- **A field's error was painted over by a live hint while the field stayed flagged.** Typing in a sibling recomputed the hints, which are written into the slot the error occupies, leaving a red field showing a figure computed from the value just rejected. An invalid field keeps its error until that field is edited.
- **The stage preview converted at the rate belonging to the stage's old date.** Moving a repayment from 17 May to 15 July left the net gain converted at the 15 May rate and said nothing about it. The preview drops a stage's stored rate as soon as the form moves it to another day, as the server does, so it falls back and says "(converted on save)".
- **"Added" named the wrong day.** `created_at` is a UTC instant while every other date is a local calendar day, so slicing it put a trade added at 00:09 in Berlin on the day before. It follows `todayISO`'s convention now.

### Notes

- Verified by execution: both FX invariants - `loanCostUsd === interestPaidUsd + principalFxUsd`, and `netGainUsd === netGain × rate` under a flat rate - across 40,000 generated trades and 200 portfolios, with stage-rate attribution, null propagation and partial-sale reconciliation.
- The landing page footer had been left at v0.0.17 through the 0.0.18 release, the same slip 0.0.12 recorded. Audited and found clean: `derive`, the weighted-average maths, the date helpers across DST and leap days, `fx.js` caching and backfill, server-side validation, `esc()` coverage and layout in both themes.

## [0.0.18] - 2026-09-19

### Changed

- **Tooltips are drawn by CSS instead of by the browser.** A native `title` waits a second, lands wherever the pointer is, and on a phone never appears at all. These appear at once, in place, and work on a tap, with no script on hover.
- The explanation marker is a real button, so it can be reached by keyboard and read out by a screen reader, which the `title` could not manage.

### Added

- **Every figure in the Summary says what it means:** all nine rows of the Performance card and all ten column headers of *By currency* and *By month closed*. Each names which trades it counts, since that is what makes two correct figures look inconsistent.
- The "no rate" chip carries its explanation the same way, wherever it lands.

### Fixed

- **"Of which currency" painted a saving red.** A negative figure there means the currency moved in your favour, but it was coloured from the gain palette. Only the colour changed.

### Notes

- A card no longer clips its overflow, which is what lets a tooltip on the last row out. The bubble is hidden with `display`, not `visibility`, because a hidden bubble is still laid out and a wide one gave the phone layout a horizontal scrollbar while nothing was hovered.
- Each bubble anchors to a box wide enough to hold it rather than to the 14px marker, which is why it cannot run off an edge and why there is no caret. Verified in Chromium at 1440px, 1100px and 390px in both themes.

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

### Notes

- Sorting works on a copy, so the Summary and the hero tiles are unaffected by what the table is showing. Creating a trade jumps to the page it landed on, and changing sort or page closes an open stage editor.
- Verified against an independently written comparison: all eight columns, both directions, every page, nulls last.

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

### Notes

- Presentation only; `lib/calc.js` is untouched. Verified by asserting that nothing inside the stage cards has `scrollWidth` greater than `clientWidth` at 1440px and 390px in both themes: twelve elements failed before the change, none after.

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

### Notes

- Presentation only: `/api/trades` and `/api/summary` return byte-identical responses before and after. The first column narrowed rather than widening, because splitting the figures removed the longest string in it.

## [0.0.8] - 2026-09-19

### Added

- A public landing page at `/`, in `landing/`. It explains what the app does in a screen or two and carries a **Use Aave Loop** button that leads to the app, and therefore to the password prompt. Served by nginx as static files, which leaves the Node process with no publicly reachable route.
- The page shares the app's `myaave-theme` setting, so a dark session carries across both ways, and follows the system preference for a first time visitor.

### Notes

- The page is self contained rather than linking the app's stylesheet: `/styles.css` sits behind basic auth, so a public visitor would get a 401 and an unstyled page. Its text colour is a darker violet than the fills, because `#9896ff` measures 3.6:1 on the soft violet behind the status badges and fails contrast for small bold type.
- The footer states that this is an independent tool and not affiliated with Aave, since the page borrows enough of their look that the question is worth answering.

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
