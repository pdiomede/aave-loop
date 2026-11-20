# Next

What is left to do on the VPS, and what to build next. Written 20 Nov 2026, after
the day's bug hunt was pushed to `main`.

## On the VPS

Do these in order. Production still runs the code from before 20 Nov.

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

The landing page's theme toggle script changed, so its hash changed. Until nginx
lists the new one, browsers block the toggle on `/` and on the 404 page; the rest of
those pages still works.

Find the line:

```bash
sudo grep -rn "Content-Security-Policy" /etc/nginx/
```

In its `script-src`, the hashes must be:

```
'sha256-idlxi/vmZQzRC4UbiGOUSbMaK2QEuIqX4WVbMpag3Bk='
'sha256-dzz2SlaFkPbn1IgItsnpY44ZeCgGSoyVsQVpQEPQtPk='
```

- The first is already there; leave it.
- Add the second.
- Remove these two old ones (or leave them; they do no harm):
  - `'sha256-4gctYiGTReoQs9WljWvM7zE5fYNvf1ArhhVsTPQedWU='`
  - `'sha256-0khB/vQfDtt4wssJcCymFCpQnpQAFWWDyDOe2sacm6I='`

Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Check it: open the landing page and click the sun/moon button. It should switch
theme, and the browser console should show no "Refused to execute inline script".

The hashes nginx must list are pinned in `scripts/check-calc.mjs` (`CSP_PINNED`).
`npm run check` fails if a page's inline script stops matching them.

### 3. Update the bot's `/` menu in Telegram

Send `/setcommands` to @BotFather, pick the bot, and paste:

```
price - ETH and BTC prices now, with 24h, 7d and 30d change
holding - trades still holding ETH or cbBTC, one line each
summary - realized gain, annualized, closed, open and held
watch - send the ETH and BTC prices every 20 minutes
unwatch - stop the price updates
help - what this bot can do
```

### 4. Quick check after the deploy

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

Ideas that came up on 20 Nov and were left for later, not bugs:

- **Follow the system theme live:** neither the ledger nor the landing page reacts
  when the system theme changes while the page is open.
- **320px phones:** in the app, the BTC ticker row wraps at 320px and the header
  (195px) is taller than the 180px scroll offset; the table's first 15px sit under it
  after a page turn.
- **Optional rename of internal names:** `MYAAVE_*` settings, `myaave-*` browser
  storage keys and the `myaave` package name still carry the old brand (the logo
  files and the checks' temp folder were renamed on 20 Nov). Renaming them needs the old names kept as a fallback, and the VPS
  service file updated.
- **Statement PDF and assets:** the Statement has no By asset table, because its
  fullest year already fills the A4 page to within a few points. Adding one means
  making room first (a narrower By month, or a second page).
- **Tiny cbBTC quantities in the CSV:** quantities are written raw, and JavaScript
  prints anything under 0.000001 in exponent form (`1e-7`). No real trade is that
  small, but a fixed-decimal writer would rule it out.

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
  - The alert goal form checks the bounds ($1 to $1,000,000) on the raw figure while
    the server rounds to the cent first, so a goal of 0.996 previews but the form
    refuses it.
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
