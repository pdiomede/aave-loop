# Next

What is left to do on the VPS, and what to build next. Written 20 Nov 2026, after
the day's bug hunt was pushed to `main`; brought up to date on 25 Nov.

## Where it stands (24 Nov)

Done on the VPS on 24 Nov:

- **Deployed 2.2.0** (`main` as of 24 Nov): WBTC as an asset to buy, the "no price"
  and "old price" notes, per-asset price ranges, and the repayment and `/price` fixes.
- **BotFather** command list pasted again, with `/holding` naming WBTC.
- **Checked from outside, without a password:** the footer reads v2.2.0;
  `landing/wbtc.png` and `landing/og6.png` answer 200 and `og5.png` 404; the page
  names `og6.png` only, and lists WBTC under "Buy and sell".
- **Step 2, the nginx hashes:** ETH Roundtrip's `script-src` now lists `'self'` and
  the two current hashes only, and they match the live landing page's inline
  scripts, so the theme button and the system theme work again. Changed with a
  `sed` anchored on the old `idlxi` hash: the same file has UrlReporter's
  `script-src 'self' https://www.googletagmanager.com`, which the broader command
  in step 2 below would also have replaced. The previous file is
  `all-sites.conf.bak` beside it. The comment above the line still speaks of four
  hashes and `public/index.html`; it is two, on the two landing pages.
- **The app behind its password, checked:** the header shows ETH and BTC only, and a
  trade's Bought card offers WBTC after cbBTC, with its logo.
- **The social card refreshed:** LinkedIn's
  [Post Inspector](https://www.linkedin.com/post-inspector/) and Telegram's
  @WebpageBot fetched `https://ethroundtrip.com/` again and show `og6.png`; X
  refreshes on its own within about a week.

Nothing is left on the VPS for 2.2.0.

Done on the VPS on 20 Nov:

- **Deployed** `main` at `1d2c88b`: the service runs 2.1.8, Telegram is connected,
  and the app, Stats, the Statement and the bot were checked.
- **Settings renamed** in `/etc/systemd/system/aaveloop.service`: `ETHROUNDTRIP_DB`
  and `ETHROUNDTRIP_ALLOWED_HOSTS`, `Description=ETH Round Trip`. The startup log no
  longer lists old names.
- **BotFather** command list pasted.
- **Backups:** the 03:00 cron line (`cd /var/www/aave && ./backupDatabase.sh --dest
  /home/paolo/backup/aaveloop --keep 14`, in paolo's crontab) uses no `MYAAVE_*`
  setting, so it needs no change.

Left from 20 Nov: nothing. The backup check was confirmed on 24 Nov:
`/home/paolo/backup/aaveloop` holds one `myaave-...db` from 03:00 every night, 11 to
24 Nov, fourteen in all as `--keep 14` asks.

## 3.0.0 (28 Nov): Long or short on a trade, year tabs on Trades

Deployed on 28 Nov at 11:24 for Long/Short: every existing trade marked Long
(`set-side.mjs --apply`, after a backup), checked from outside (footer v3.0.0,
`og8.png` 200, `og7.png` 404). Still to do for Long/Short: ask @WebpageBot
(Telegram) and LinkedIn's Post Inspector to fetch `https://ethroundtrip.com/` again.

**The year tabs went into 3.0.0 later the same day** (one release a day), so the
footer still reads v3.0.0 after they are deployed. Pull and restart as usual;
nothing to run. The new `market_close` table is created by itself on the first
start (no migration). The first time a past year's tab is opened, the server asks
CoinGecko for that year's 31 Dec close once per market (five requests) and keeps
them; a coin CoinGecko has no history for then (PSOL may not) reads "No PSOL price
for 31 Dec" under the estimate. No new setting, no inline script, so nginx is
untouched. Check after the deploy: Trades opens on 2026 with 2025 and All beside
it; 2025 shows its closed trades and the loans still open on 31 Dec; All matches
what the header showed before.

## 2.3.0 (27 Nov): History filters by status

Not deployed yet. Nothing on the VPS beyond the usual pull and restart: no
migration, no new setting, no inline script, so nginx's CSP is untouched. The
filter is kept in each browser's storage (`ethroundtrip-trade-filter`), not on
the server.

## 2.2.2 (26 Nov): Onchain Data fixes, Stats totals, Addresses icons

Deployed on 26 Nov, with `69bf4d2`. The service now runs on Rome's calendar, so the
bot counts days as the page does: `/etc/systemd/system/aaveloop.service.d/override.conf`
holds

```
[Service]
Environment=TZ=Europe/Rome
```

and the startup log reads "Dates: today is ... on Europe/Rome time." Before it, the
VPS ran on UTC, and from midnight to 1am in Rome `/holding` and `/summary` were a
day's interest behind the page. In `systemctl edit`, the lines go between the two
`###` comments at the top; everything under the second is discarded. It takes a
`daemon-reload` before the restart.

## 2.2.1 (25 Nov): Wallets, and a trade's wallet

Done on the VPS by 26 Nov, keys and BotFather menu included. The hash audit ran on
26 Nov: 30 hashes, 26 OK, 4 CHECK, 0 WRONG, so no `--apply` was needed. The four
CHECKs are worth a look on the explorer: #10 and #16 Sold move no asset token out
of the wallet (native ETH, or a CoW Swap order); #29 and #30 Borrowed (#30 on
Solana) also move the asset (collateral supplied in the loan's transaction?).

What it needed: Deploy as in step 1 below (`git pull`, restart). No nginx, BotFather
or settings change: no inline script changed and no command was added. The first
start adds `trades.wallet_id` and the `wallets` table by itself; every existing trade
starts with no wallet. Then check, behind the password:

- The fourth tab reads **Wallets**; an old `#settings` link opens it.
- Add your wallets there, then name each old trade's wallet from its Borrowed card's
  Edit (the picker is after Platform). A new trade picks it after the platform.
- Deleting a wallet a trade names is refused, naming the trade.
- In both themes, an idle field has a visible edge.
- Wallets > Onchain Data lists every trade under its wallet, then No wallet.
- **Chains:** existing wallets are Ethereum (the column's default). A wallet used on
  Base, Arbitrum or Optimism is added again with its chain. Arbitrum is searched on
  Etherscan's free plan and Optimism on its public node; Base needs `BASE_RPC_URL` in
  config.env (a node with a token, e.g. from publicnode/allnodes) or its hashes pasted.
- **Audit the stored hashes** after the pull: those found before today's matching fixes
  were never rechecked. `cd /var/www/aave && sudo -u myaave node scripts/audit-hashes.mjs`
  reports each one (OK, CHECK, WRONG); look up any CHECK on the explorer, and run it
  again with `--apply` to forget the WRONG searched ones, then Get onchain data.
- **Etherscan:** add `ETHERSCAN_API_KEY=...` (your key from etherscan.io > API Keys)
  to `/var/www/aave/config.env`, then restart. Without it the magnifier on a
  trade's stages says the key is missing. Then open a trade in Onchain Data, holding
  or closed, and press each magnifier: each hash should open its transaction.

Running 2.2.0 beside 2.2.1 on one database is safe (2.2.0 never names the column),
but a 2.2.0 page cannot show or set a wallet.

**Solana, later the same day (still 2.2.1):** SOL and PSOL to buy, Jupiter and Kamino
to run on, Solana wallets, and SOL in the header.

- **Never run an older copy on this database once it has a SOL or PSOL trade**, and
  never restore a newer backup onto an older install: an older copy reads `sol` and
  `psol` as ETH, values them at ETH's price and closes their alerts as off market.
- Add `HELIUS_API_KEY=...` (a free key from helius.dev > Dashboard > API Keys) to
  `/var/www/aave/config.env` with `sudoedit`, then restart. Without it a Solana wallet's
  magnifiers say the key is missing; pasting a signature still works.
- Re-paste the bot's `/` menu (step 4): `/price` and `/watch` now name BTC, ETH and SOL.
- The social card is now `og7.png`; `og6.png` is gone. Ask @WebpageBot (Telegram) and
  LinkedIn's Post Inspector to fetch `https://ethroundtrip.com/` again.
- Check: the header shows BTC, ETH and SOL, each on its own row; the landing page lists
  Jupiter and Kamino under "Run the loop on" and SOL and PSOL under "Buy and sell";
  `curl -sI https://ethroundtrip.com/landing/og7.png | head -1` answers 200.
- Add the Solana wallet under Wallets (chain: Solana), name it on the Solana trades,
  and press a magnifier in Onchain Data: the hash opens on Solscan.

## 2.2.0 (24 Nov): WBTC as an asset to buy

Deployed on 24 Nov (see above); kept as the record of what it needed. Deploy as
in step 1 below (`git pull`, restart). No nginx or settings change: no inline
script changed, and `wbtc.png` sits in `landing/` beside the other logos.
In BotFather, paste the command list from step 4 below again: `/holding` now says
"ETH, cbBTC or WBTC". Then check:

- The Bought card's asset picker offers WBTC after cbBTC, with its logo; a WBTC
  quantity keeps all 8 places. The header still shows ETH and BTC only.
- The landing page's "Buy and sell" row shows WBTC, with no password asked
  (`curl -sI https://ethroundtrip.com/landing/wbtc.png` answers 200).
- The social card is redrawn as `og6.png`, with WBTC under Buys; `og5.png` is gone.
  Check it is served with no password asked, and the only one the page names:

  ```bash
  curl -sI https://ethroundtrip.com/landing/og6.png | head -5      # 200, image/png
  curl -s https://ethroundtrip.com/ | grep -o 'landing/og[0-9]*\.png' | sort -u   # og6.png only
  ```

  Then have the sites that cached `og5.png` fetch the new one, as on 20 Nov (step 5
  below): LinkedIn's [Post Inspector](https://www.linkedin.com/post-inspector/), and
  for Telegram send the link to @WebpageBot. X refreshes on its own within about a
  week.

Work over SSH from the Mac's Terminal, not the Hetzner web console: the console drops
the Shift key, so `&`, `|`, `*`, `"`, `+` and capital letters come out wrong (`&&`
arrived as `77`).

## On the VPS

Steps 1, 3 and 4 were done on 20 Nov, step 2 on 24 Nov (see above).

### 1. Deploy `main`

```bash
cd <the checkout>          # the folder the service runs from
git pull
sudo systemctl restart <the service>
```

Not sure of the service's name? `systemctl list-units --type=service | grep -i -e roundtrip -e aave -e node`
lists the likely ones.

On its first start the database updates itself:

- every existing trade is marked as ETH;
- existing alerts are read as ETH goals;
- the cached ETH price is carried over.

The version shown is 2.1.8.

Make sure no 2.1.7 copy is still running against the same database (the restart
replaces the service's own): an older copy knows only ETH, and would judge a cbBTC
trade's BTC goal against the ETH price and send it at once.

Then reload any browser tab that had the app open from before the deploy. Such a
tab still saves trades and alerts correctly, but its ETH price stops updating:
it asks `/api/eth`, which became `/api/prices`. Tested on 20 Nov against a
database written by 2.1.7: every trade, total, CSV figure, Statement line and
bot reply came out the same after the upgrade, alerts kept their state, and
`/watch` stayed on.

Within the first hour the rate refresher asks once more about every euro stage
that took the day before's rate (a stand-in) and whose day the cache never
confirmed. Most settle as they are; a weekday that was saved before the ECB
published, and never refreshed in time, gets its real rate, so a EURC trade's
dollar figures can move by a little. The log says `Exchange rates: filled in N.`
when that happens.

### 2. Update nginx's Content-Security-Policy

Both inline scripts on the landing page changed on 20 Nov (the theme follows the
system live, and is saved under the new `ethroundtrip-theme` key), so both their
hashes changed. Until nginx lists the new ones, browsers block the theme on `/` and
on the 404 page; the rest of those pages still works.

The line is the `add_header Content-Security-Policy` in
`/etc/nginx/sites-available/all-sites.conf`. In its `script-src`, the hashes must be
exactly these two:

```
'sha256-ydfKTROXhrKp+JMGg4E0f5iPi3jzeU8+11xdzEbfRvs='
'sha256-W9be3A+UEXvbL09tjpkkWtuJt36Q7WGeXBruE3mVoH0='
```

Remove any other `sha256-` hash in that list. They are all older versions of
these two scripts and no longer match anything (they do no harm if left, but
nothing needs them): `idlxi...`, `dzz2...`, `kcXx...`, `ncgL...`, `4gct...`, `0khB...`.

The quickest way, keeping `'self'` and the rest of the line, with a backup first:

```bash
sudo grep -o "script-src[^;]*" /etc/nginx/sites-available/all-sites.conf
```

(it shows two lines: UrlReporter's, `'self' https://www.googletagmanager.com`, which
stays as it is, and ETH Roundtrip's, with only `'self'` and `'sha256-...'` values; if
that one holds anything else, edit it by hand instead)

```bash
sudo cp /etc/nginx/sites-available/all-sites.conf /etc/nginx/sites-available/all-sites.conf.bak
```

Careful: the same file also holds UrlReporter's `script-src 'self'
https://www.googletagmanager.com`, so a pattern on `script-src 'self'` alone
rewrites that one too. Anchor it on ETH Roundtrip's own first hash, whatever it is
now (the `grep` above shows it: `idlxi` until 24 Nov, `ydfK` since):

```bash
sudo sed -i -E "s#script-src 'self' 'sha256-ydfK[^;]*;#script-src 'self' 'sha256-ydfKTROXhrKp+JMGg4E0f5iPi3jzeU8+11xdzEbfRvs=' 'sha256-W9be3A+UEXvbL09tjpkkWtuJt36Q7WGeXBruE3mVoH0=';#" /etc/nginx/sites-available/all-sites.conf
```

Run the `grep` again to see the two hashes, then:

```bash
sudo nginx -t
```

```bash
sudo systemctl reload nginx
```

Reload only if the test says ok; otherwise copy the `.bak` back and look at the
error. The comment above that line in the file still speaks of four hashes and
`public/index.html`; it is out of date (two scripts, both on the landing pages).

Check it: open the landing page and click the sun/moon button. It should switch
theme, and the browser console should show no "Refused to execute inline script".
In a private window (no theme saved), switch the Mac between Light and Dark in
System Settings: the open landing page and the app should follow.

The hashes nginx must list are pinned in `scripts/check-calc.mjs` (`CSP_PINNED`).
`npm run check` fails if a page's inline script stops matching them.

### 3. Rename the settings in the service file (when convenient)

Settings are now `ETHROUNDTRIP_*`. The old `MYAAVE_*` names keep working, so nothing
breaks if you skip this; the startup log lists any still in use:

```bash
sudo journalctl -u <the service> -n 20 | grep "Old setting names"
```

To rename them, edit the unit (`sudo systemctl edit --full <the service>`, or the
`Environment=` lines wherever they live), change each `MYAAVE_` to `ETHROUNDTRIP_`
(for example `MYAAVE_DB` to `ETHROUNDTRIP_DB`), then:

```bash
sudo systemctl daemon-reload && sudo systemctl restart <the service>
```

Do the same in any cron line that runs `backupDatabase.sh` with `MYAAVE_DB` or
`MYAAVE_BACKUP_DIR`. The ledger file keeps its name, `data/myaave.db`; nothing is
moved.

### 4. Update the bot's `/` menu in Telegram

Send `/setcommands` to @BotFather, pick the bot, and paste:

```
price - BTC, ETH and SOL prices now, with 24h, 7d and 30d change
holding - trades still holding ETH, cbBTC, WBTC, SOL or PSOL, one line each
summary - realized gain, annualized, closed, open and held
watch - send the BTC, ETH and SOL prices every 20 minutes
unwatch - stop the price updates
help - what this bot can do
```

### 5. Quick check after the deploy

- `/app` loads. The header shows ETH and BTC, a row each.
- A new trade offers Aave, Ether.fi and Morpho.
- Ether.fi shows its new logo, a violet outline on a white disc (`etherfi.png`; the
  black `etherfi.jpg` is gone): in the new trade's platform picker, on an Ether.fi
  trade's Borrowed card, on Stats, and in the landing page's "Run the loop on" row.
  A broken image or the old black one means the pull did not land, or the browser
  kept the old file; `curl -sI https://ethroundtrip.com/landing/etherfi.png` should
  answer 200 without a password.
- The Bought card offers ETH and cbBTC.
- `/price` in Telegram answers with both prices.
- The new social card is served, with no password asked: it lives under `/landing/`,
  which nginx serves without basic auth.

  ```bash
  curl -sI https://ethroundtrip.com/landing/og5.png | head -5      # 200, image/png
  curl -s https://ethroundtrip.com/ | grep -o 'landing/og[0-9]*\.png' | sort -u   # og5.png only
  ```

  A 401 means nginx's open location does not cover it; a 404 means the pull did not
  land. Then paste `https://ethroundtrip.com/` into
  [opengraph.xyz](https://www.opengraph.xyz) or a private Telegram chat: the preview
  should show the card with Aave, Ether.fi, Morpho, ETH and cbBTC. Sites that
  already cached the old card (`og4.png`, gone now) refetch it on request: LinkedIn's
  [Post Inspector](https://www.linkedin.com/post-inspector/), and for Telegram send
  the link to @WebpageBot. X refreshes on its own within about a week.
- The logo shows in the app's header and on the landing page. The files were renamed
  from `AaveLoop_logo*` to `ETHRoundtrip_logo*`; if it is missing, look for the old
  name in nginx's config: `sudo grep -rn AaveLoop /etc/nginx/`.

## To build next

- **Onchain Data checks each stage against its transaction** (planned 26 Nov, a
  minor: 2.3.0). Onchain Data finds a stage's hash but keeps only the hash; this
  reads the transaction's figures and says where the trade disagrees with them, so a
  typo in an amount or quantity is caught.
  - **Server:** `GET /api/trades/:id/tx/:stage/check` runs what the hash audit
    already does, `txTransfers` then `auditStage` (etherscan.js), and answers the
    verdict with the chain's figures: the coin moved, the asset quantity, the time.
    `auditStage` is extended to return those figures, not only its notes.
  - **No database change.** A confirmed transaction never changes, so each is cached
    in memory once read; the verdict is worked out afresh against the trade every
    time, so an edit re-checks at once and nothing stored goes stale.
  - **Page:** each Onchain Data stage card with a hash shows "Matches the chain"
    (within a cent or 0.05%, the search's own rule), or in amber "Chain: 30,012.40
    EURC, you typed 30,021.40" with a **Use 30,012.40** button. That saves as the
    stage editor does (`base`, the 409 conflict flow); nothing is changed unasked.
    A date that differs is shown, not offered: the typed date is local, the
    chain's UTC.
  - **Get onchain data** also checks the hashes already stored; its report adds "N
    don't match the chain", and each wallet's heading counts its stages that differ.
  - **Not in the first version: gas.** The receipt gives the gas paid, but Costs &
    Fees is gas plus the swap fee, so it cannot be filled from it, and it needs ETH's
    price on that day. Later, perhaps, a hint under the field: "gas on chain: $1.84".
  - **Checks** (`check-server.mjs`, mocked Etherscan): a hash that matches; an
    amount typo, reported with the chain's figure; the Use button's save; an edit
    that re-checks; a chain that cannot be reached reads "not checked", never
    "matches".
  - **Cost:** two Etherscan calls per hash the first time (about 3 minutes for 200
    stages on the free plan), then from the cache until a restart. Solana the same
    way, through Helius.
- **The wallet everywhere (done 26 Nov).** Stats has By wallet, the CSV the wallet's
  name, address and chain, and `/holding` a wallet column and a line per wallet.

## Known limits and loose ends

Accepted for now, worth knowing:

- **A command may be answered twice after a restart.** When the app stops in the
  middle of a reply, the bot rewinds to that command so nothing is lost. That command
  can get its answer twice.
- **Saving a goal on an old price:** with no recent price, the alert's direction
  (rise or fall) comes from the purchase price. The alert window now says so.
- **The old `eth_price` table stays in the database,** unused since prices moved to
  `market_price`, so an older copy of the app sharing the file keeps working. It can
  be dropped once no older copy runs anywhere.
- **Not demonstrated, so not fixed:**
  - On the very first visit to Alerts, a stage save landing during the list's first
    request might leave it on "Loading alerts" until the next visit.
  - Two copies of the app refreshing rates at once: one could write an older
    stand-in over a real rate the other had just written. The next refresh corrects
    it, so at worst it lasts an hour.
- **Small thing seen and left:** a PATCH with a bad body to a trade that does not
  exist answers 400, not 404.
- **Bug hunt coverage:** on 20 Nov every area was hunted: Stats, CSV and PDF;
  alerts; trades; Telegram; the database; the interface and pagination; the price
  banner; the landing page; the upgrade from 2.1.7; exchange rates; the API; the
  config and shell scripts; cbBTC end to end; keyboard, screen reader and phones.
- **Version:** 2.2.0 went out on 24 Nov, and the rule is one release a day. Work from
  the next day goes under `## [Unreleased]` and gets the next number.
