/**
 * The theme, applied before first paint so a dark session never flashes white.
 * With no choice saved it follows the system, as the landing page does: only a
 * saved choice used to be read, so a dark machine went from a dark landing page
 * to a light ledger.
 *
 * Its own file rather than inline in index.html. Production's Content Security
 * Policy admits inline scripts only by their SHA-256 hash, which nginx holds,
 * so editing this when it was inline changed its hash and the browser blocked
 * it - the ledger opened light on a dark machine with the fix deployed. A file
 * from the app's own origin is admitted by `script-src 'self'` whatever it says.
 *
 * Loaded with a plain, synchronous <script src> in <head>, not as a module and
 * not deferred: either would run after the page had been painted once.
 */
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('myaave-theme');
  } catch (e) {}
  try {
    if (!theme) theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (e) {}
  if (theme) document.documentElement.dataset.theme = theme;
})();
