/**
 * Write the version in package.json into the two pages that print it.
 *
 * Run by npm's `version` lifecycle, so `npm version patch` bumps package.json,
 * bumps the lockfile, runs this, and commits all four together. Nothing here is
 * meant to be run by hand.
 *
 * The app's own footer is repainted from /api/version at boot, so a stale
 * number there is invisible and was never noticed. The landing page has no
 * runtime source at all, and nginx serves it directly in production, so it is
 * the one a visitor reads and the one a missed edit sticks to. Both are
 * stamped, because the invisible one is what makes the visible one easy to
 * forget.
 *
 * A pattern that no longer matches is an error rather than a silent skip: the
 * failure this replaces is precisely a version that was left behind quietly.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.npm_package_version;
if (!version) {
  console.error('stamp-version: no npm_package_version; run this through `npm version`.');
  process.exit(1);
}

/** Each entry is the file, what to find, and what to put back around the number. */
const TARGETS = [
  {
    file: 'public/index.html',
    find: /(<span id="version">v)[\d.]+(<\/span>)/,
    what: 'the footer version span',
  },
  {
    file: 'landing/index.html',
    find: /(&middot; v)[\d.]+( - Built by)/,
    what: 'the footer version',
  },
];

let failed = false;

for (const { file, find, what } of TARGETS) {
  const before = readFileSync(file, 'utf8');
  if (!find.test(before)) {
    console.error(`stamp-version: ${file} - could not find ${what}.`);
    failed = true;
    continue;
  }
  const after = before.replace(find, `$1${version}$2`);
  if (after !== before) writeFileSync(file, after);
  console.log(`stamp-version: ${file} -> v${version}`);
}

if (failed) process.exit(1);
