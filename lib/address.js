/**
 * Wallet addresses: how one typed or pasted into the Wallets tab is read, and what is
 * accepted. Served to the browser from /lib/address.js exactly as Node imports
 * it, so the form and the API refuse the same addresses with the same words.
 *
 * It imports nothing, ever, for the reason calc.js does not: the browser runs
 * this very file, and the moment it reaches for a package it stops loading
 * there. That is why Keccak-256 is written out below. EIP-55's checksum is a
 * Keccak-256 hash, which is not SHA3-256 (the padding differs), and Node's
 * crypto offers only the latter while the browser offers neither.
 *
 * The checksum is the point of the module. An address is forty characters
 * nobody reads, and one mistyped or cut short on a paste is still a perfectly
 * shaped address - of a wallet that is not yours. Its capitals are a checksum
 * over the rest, so a mixed-case address that does not match it is a typo,
 * caught here before it is saved.
 *
 * Pure and synchronous: no DOM, no fetch. `npm run check` covers it in
 * scripts/check-input.mjs, against the published test vectors.
 */

/* ------------------------------------------------------------ keccak-256 */

const MASK = (1n << 64n) - 1n;

// The round constants and the rho offsets in pi's order, as Keccak's reference
// lists them.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44].map(BigInt);
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

function keccakF(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round += 1) {
    // theta
    for (let i = 0; i < 5; i += 1) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (let i = 0; i < 5; i += 1) {
      const t = bc[(i + 4) % 5] ^ rotl(bc[(i + 1) % 5], 1n);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    // rho and pi
    let t = st[1];
    for (let i = 0; i < 24; i += 1) {
      const j = PILN[i];
      const next = st[j];
      st[j] = rotl(t, ROTC[i]);
      t = next;
    }
    // chi; `^ MASK` is a 64-bit NOT, since `~` on a BigInt goes negative
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i += 1) bc[i] = st[j + i];
      for (let i = 0; i < 5; i += 1) st[j + i] ^= (bc[(i + 1) % 5] ^ MASK) & bc[(i + 2) % 5];
    }
    // iota
    st[0] ^= RC[round];
  }
}

const RATE = 136; // bytes: 1600 bits less twice the 256-bit output

/**
 * Keccak-256 of `bytes` (a Uint8Array, or a string read as UTF-8), as 64 hex
 * digits. Keccak's own padding, 0x01 ... 0x80, which is what Ethereum hashes
 * with; SHA3-256 pads 0x06 and gives another digest for the same input.
 */
export function keccak256(bytes) {
  const msg = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const padded = new Uint8Array(Math.floor(msg.length / RATE + 1) * RATE);
  padded.set(msg);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let lane = 0; lane < RATE / 8; lane += 1) {
      let v = 0n;
      for (let b = 7; b >= 0; b -= 1) v = (v << 8n) | BigInt(padded[off + lane * 8 + b]);
      st[lane] ^= v;
    }
    keccakF(st);
  }

  let hex = '';
  for (let lane = 0; lane < 4; lane += 1) {
    for (let b = 0; b < 8; b += 1) hex += Number((st[lane] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  }
  return hex;
}

/* --------------------------------------------------------------- networks */

/**
 * Where an address lives. Ethereum mainnet only for now; the table stores the
 * network beside every address so another can be added without rebuilding it
 * (see `wallets` in db.js).
 */
export const NETWORKS = ['ethereum'];

export const NETWORK_META = {
  ethereum: { label: 'Ethereum', art: '/eth.png', explorer: 'https://etherscan.io/address/', explorerLabel: 'Etherscan' },
};

/* -------------------------------------------------------------- addresses */

/**
 * EIP-55: the address with each letter capitalised where the matching hex
 * digit of the Keccak-256 of its lowercase form is 8 or more. Takes `0x` and
 * forty hex digits in any case.
 */
export function toChecksumAddress(address) {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(lower);
  let out = '0x';
  for (let i = 0; i < 40; i += 1) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

const ZERO = `0x${'0'.repeat(40)}`;

/**
 * An address as typed or pasted, read: `{ address }` in its checksummed form,
 * or `{ error }` saying what is wrong with it in words the form can show.
 *
 * All lowercase or all capitals carries no checksum - plenty of tools print it
 * that way - so it is accepted and stored checksummed. Mixed case is a
 * checksum, and one that does not match is refused rather than corrected:
 * "correcting" it would save the address of whatever the typo spelled.
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') return { error: 'Address must be text.' };
  const text = raw.trim();
  if (text === '') return { error: 'Address is required.' };
  if (/\.eth$/i.test(text)) return { error: 'Paste the address itself: ENS names are not looked up.' };
  if (!/^0x/i.test(text)) return { error: 'An Ethereum address starts with 0x.' };
  const body = text.slice(2);
  if (!/^[0-9a-f]*$/i.test(body)) return { error: 'After the 0x an address holds only 0-9 and a-f.' };
  if (body.length !== 40) {
    return { error: `That is ${body.length} character${body.length === 1 ? '' : 's'} after the 0x; an address has 40.` };
  }
  // The prefix in either case, read as 0x: "0X" is no checksum.
  const typed = `0x${body}`;
  if (typed.toLowerCase() === ZERO) return { error: 'That is the zero address, which nobody holds.' };
  const address = toChecksumAddress(typed);
  const unchecked = body === body.toLowerCase() || body === body.toUpperCase();
  if (!unchecked && typed !== address) {
    return { error: "The capitals in this address don't match its checksum. Check it for a typo." };
  }
  return { address };
}

/** `0x1234…abcd`, for where the whole address does not fit. */
export const shortAddress = (address) =>
  typeof address === 'string' && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : String(address ?? '');

/* ------------------------------------------------------------------ names */

export const WALLET_NAME_MAX = 40;

// Counted as they are seen: a flag or a skin-toned emoji is one character, as
// it is for notes (`normalise` in server.js). Code points where Intl.Segmenter
// is missing, which only ever counts longer.
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const lengthSeen = (s) => (SEGMENTER ? [...SEGMENTER.segment(s)].length : [...s].length);

/**
 * A name as it is stored: trimmed, and every run of spaces, tabs or line
 * breaks one space, so a pasted name lands on one line and "Ledger  main"
 * cannot sit beside "Ledger main" as another wallet. Null for anything that is
 * not text.
 */
export const walletName = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : null);

/** What is wrong with a name, or null. Judged on `walletName`'s reading. */
export function walletNameError(raw) {
  const name = walletName(raw);
  if (name === null) return 'Name must be text.';
  if (name === '') return 'Name is required.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Name holds a character that cannot be shown.';
  if (lengthSeen(name) > WALLET_NAME_MAX) return `Keep the name to ${WALLET_NAME_MAX} characters.`;
  return null;
}
