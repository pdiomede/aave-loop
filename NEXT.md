# Next

What is left to do on the VPS, and what to build next. Written 20 Nov 2026, after
the day's bug hunt was pushed to `main`.

## Where it stands (20 Nov, evening)

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

Left:

- **Monday 23 Nov, 19:00 CET: step 2, the nginx hashes** (a reminder is scheduled in
  the Claude app). Until then only the landing page's theme button is blocked; the
  app is unaffected.
- **21 Nov:** check that the night's backup ran: `ls -lt /home/paolo/backup/aaveloop`
  should show a `myaave-...db` from about 03:00 UTC, and its log no error.

Work over SSH from the Mac's Terminal, not the Hetzner web console: the console drops
the Shift key, so `&`, `|`, `*`, `"`, `+` and capital letters come out wrong (`&&`
arrived as `77`).

## On the VPS

Steps 1, 3 and 4 were done on 20 Nov; step 2 is left (see above).

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

(it should show only `'self'` and `'sha256-...'` values; if anything else is there,
edit by hand instead)

```bash
sudo cp /etc/nginx/sites-available/all-sites.conf /etc/nginx/sites-available/all-sites.conf.bak
```

```bash
sudo sed -i -E "s#script-src 'self'[^;]*;#script-src 'self' 'sha256-ydfKTROXhrKp+JMGg4E0f5iPi3jzeU8+11xdzEbfRvs=' 'sha256-W9be3A+UEXvbL09tjpkkWtuJt36Q7WGeXBruE3mVoH0=';#" /etc/nginx/sites-available/all-sites.conf
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
price - ETH and BTC prices now, with 24h, 7d and 30d change
holding - trades still holding ETH or cbBTC, one line each
summary - realized gain, annualized, closed, open and held
watch - send the ETH and BTC prices every 20 minutes
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

Nothing is waiting: every idea from 20 Nov was built that day.

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
- **Small things seen and left:** a PATCH with a bad body to a trade that does not
  exist answers 400, not 404; and the repayment error quotes the borrowed amount as
  typed (10,000.005), where the card prints 10,000.01.
- **A stage form left open while the same trade is edited elsewhere saves over
  that edit** (last write wins); only the alert window checks that the trade still
  is what it was drawn for. Seen in the 20 Nov bug hunt and left: one user, one tab
  is the normal case.
- **Bug hunt coverage:** on 20 Nov every area was hunted: Stats, CSV and PDF;
  alerts; trades; Telegram; the database; the interface and pagination; the price
  banner; the landing page; the upgrade from 2.1.7; exchange rates; the API; the
  config and shell scripts; cbBTC end to end; keyboard, screen reader and phones.
- **Version:** 2.1.8 went out today, and the rule is one release a day. Work from
  tomorrow goes under `## [Unreleased]` and gets the next number.
