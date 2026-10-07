#!/usr/bin/env node
/**
 * Writes lib/logo.js from public/AaveLoop_logo_96.png, for the statement PDF.
 *
 * Run by hand when the logo changes; its output is committed, so nothing is
 * built at install or at start. `scripts/check-statement.mjs` fails if the two
 * have drifted apart.
 *
 * A PDF can take a PNG's image data as it is: the IDAT chunks are a zlib
 * stream of filtered scanlines, which is FlateDecode with the PNG predictors.
 * So there is nothing to decode here, only the chunks to lift out - provided
 * the PNG is 8-bit RGB, not interlaced, with no alpha, which is checked.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function logoFromPng(png) {
  if (png.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const [depth, colorType, , , interlace] = png.subarray(24, 29);
  if (depth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error(`need 8-bit RGB, not interlaced (depth ${depth}, type ${colorType}, interlace ${interlace})`);
  }
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return { width, height, data: Buffer.concat(idat).toString('base64') };
}

// Run, rather than imported by the checks. Compared as URLs: a path pasted
// after `file://` keeps its spaces where the URL has %20, so in a checkout
// whose path had one this was never true, and the script exited 0 having
// written nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = new URL('../public/AaveLoop_logo_96.png', import.meta.url);
  const { width, height, data } = logoFromPng(readFileSync(src));
  const lines = data.match(/.{1,100}/g).map((l) => `  '${l}'`).join(' +\n');
  writeFileSync(
    new URL('../lib/logo.js', import.meta.url),
    `/**
 * The app's logo, public/AaveLoop_logo_96.png, as the statement PDF embeds it:
 * the PNG's IDAT data in base64, which a PDF reads as FlateDecode with the PNG
 * predictors. Written by scripts/make-logo.mjs; do not edit by hand.
 */
export const LOGO = {
  width: ${width},
  height: ${height},
  data:
${lines},
};
`,
  );
  console.log(`lib/logo.js: ${width}x${height}, ${data.length} base64 characters`);
}
