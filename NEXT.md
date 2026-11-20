# Next

What is left to do on the VPS, and what to build next. Written 20 Nov 2026, after
`bd30dc8` was pushed to `main`.

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

- **Back and Forward between views:** the app's nav uses `history.replaceState`, so
  Back leaves the app instead of returning to the previous view. Switch to
  `pushState` if that is wanted.
- **Follow the system theme live:** neither the ledger nor the landing page reacts
  when the system theme changes while the page is open.
- **320px phones:** in the app, the BTC ticker row wraps at 320px and the header
  (195px) is taller than the 180px scroll offset; the table's first 15px sit under it
  after a page turn.
- **Optional rename of internal names:** `MYAAVE_*` settings, `myaave-*` browser
  storage keys and the `myaave` package name still carry the old brand (the logo
  files and the checks' temp folder were renamed on 20 Nov). Renaming them needs the old names kept as a fallback, and the VPS
  service file updated.
- **Backfill tool for Morpho:** `scripts/set-platform.mjs` only knows `--etherfi`
  (everything else becomes Aave). A `--morpho <id>` flag would let old trades be
  marked as Morpho the same way.
- **A check for the `/landing/` rule:** CLAUDE.md says `npm run check` enforces that
  the public pages load only from `/landing/`, but only the CSP-hash rule has a check.
  Add one that fails when `landing/*.html` references an image, script or stylesheet
  outside `/landing/` (fonts from Google excepted).
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
- **Version:** 2.1.8 went out today, and the rule is one release a day. Work from
  tomorrow goes under `## [Unreleased]` and gets the next number.
