# Next

What is left to do on the VPS, and what to build next. Written 20 Nov 2026, after
`bd5771b` was pushed to `main`.

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

## To build next

Ideas that came up on 20 Nov and were left for later, not bugs:

- **Social preview images:** `landing/og4.png` (and og/og2/og3) still show the
  ETH-only story. Remake them to mention cbBTC and the three platforms, keeping
  1200x630.
- **Back and Forward between views:** the app's nav uses `history.replaceState`, so
  Back leaves the app instead of returning to the previous view. Switch to
  `pushState` if that is wanted.
- **Follow the system theme live:** neither the ledger nor the landing page reacts
  when the system theme changes while the page is open.
- **320px phones:** in the app, the BTC ticker row wraps at 320px and the header
  (195px) is taller than the 180px scroll offset; the table's first 15px sit under it
  after a page turn.
- **Optional rename of internal names:** `MYAAVE_*` settings, `myaave-*` browser
  storage keys, the `myaave` package name and `AaveLoop_logo*` files still carry the
  old brand. Renaming them needs the old names kept as a fallback, and the VPS
  service file updated.
