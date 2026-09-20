/**
 * Write the version in package.json into the two pages that print it.
 *
 * Run by npm's `version` lifecycle, so `npm version patch` bumps package.json,
 * bumps the lockfile, runs this, and commits all four together. Nothing here is
 * meant to be run by hand.
 *
 * Both pages are stamped because a reader sees both numbers. The landing page
 * has no runtime source at all and nginx serves it directly in production, so a
 * missed edit there simply stands. The app's footer is repainted from
 * /api/version once the page is up, but that repaint is not awaited and can
 * fail, so the stamped number is the one that renders on every load and the one
 * that stays when the call never lands.
 *
 * A pattern that no longer matches is an error rather than a silent skip: the
 * failure this replaces is precisely a version that was left behind quietly.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to this file rather than to the working directory, the way server.js,
// config.js and db.js all locate a repo file. npm runs lifecycle scripts from the
// package root, so cwd would work today; this does not depend on it.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const target = path.join(root, file);
  const before = readFileSync(target, 'utf8');
  if (!find.test(before)) {
    console.error(`stamp-version: ${file} - could not find ${what}.`);
    failed = true;
    continue;
  }
  // A function replacer rather than a replacement string, where $$, $&,
  // $` and $' each mean something other than themselves. Interpolating
  // the version between two group references produced text of the shape
  // $1<version>$2, which parsed correctly only because there is no group 10
  // to claim the digit after $1 - right by a fallback rule rather than by
  // what the line appeared to say. Nothing a function returns is special.
  const after = before.replace(find, (_, lead, tail) => lead + version + tail);
  if (after !== before) writeFileSync(target, after);
  console.log(`stamp-version: ${file} -> v${version}`);
}

if (failed) process.exit(1);
