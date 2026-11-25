/**
 * A Solana wallet's token movements, read from a Solana node, for finding a
 * trade's transactions (etherscan.js) and auditing a stored one
 * (scripts/audit-hashes.mjs). Server-only: the node's URL carries a key.
 *
 * Solana has no Etherscan to list a wallet's transfers, and Solscan's API is
 * paid, so this asks plain JSON-RPC - Helius's node with HELIUS_API_KEY, or
 * any node SOLANA_RPC_URL names (`solanaNode` in config.js):
 * `getSignaturesForAddress` for the wallet's transactions, newest first, paged
 * back until they are older than the window, then `getTransaction` for each
 * one in it that succeeded.
 *
 * Each transaction is turned into rows in the shape Etherscan's
 * `account/tokentx` answers - hash, timeStamp, contractAddress, from, to,
 * value, tokenDecimal - so etherscan.js matches them by the same rules. A row
 * is the wallet's net change in one token: its token accounts' balances
 * before and after (`pre/postTokenBalances`, by owner), so a swap routed
 * through ten pools is one leg in and one leg out, as a wallet sees it. SOL
 * itself moves as lamports, not as a token: its row, contract `native:sol`,
 * is the wallet's balance change with the fee it paid put back - the fee is
 * no part of what was bought or sold. A Solana value is never folded to
 * lowercase: its capitals are part of it.
 */
import { solanaNode } from './config.js';

export const NATIVE_SOL = 'native:sol';
// 0.01 SOL in lamports: below it a change of SOL is rent or a tip.
const DUST = 10_000_000n;

const GAP_MS = 150;
const TIMEOUT_MS = 20_000;
const RATE_RETRIES = 2;
const PAGE = 1000;
// Pages of signatures read back from now before giving up: 20,000
// transactions, years of a personal wallet's history.
const MAX_PAGES = 20;

/** A node failure, tagged as etherscan.js tags its own (`kind`). */
export class SolanaError extends Error {
  constructor(message, kind = 'busy') {
    super(message);
    this.kind = kind;
  }
}

// The key or the whole URL, out of anything said.
const hide = (text, secret) => {
  let s = String(text ?? '');
  if (secret) s = s.split(secret).join('<key>');
  return s.replace(/https?:\/\/\S+/g, '<node>');
};

let queue = Promise.resolve();
let lastAt = 0;

/** One JSON-RPC call, one at a time, spaced; a rate limit is waited out twice. */
async function rpc(method, params) {
  const node = solanaNode();
  if (!node.url) throw new SolanaError(node.reason, 'setup');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpcOnce(node, method, params);
    } catch (err) {
      if (!(err instanceof SolanaError) || err.kind !== 'limited' || attempt >= RATE_RETRIES) {
        if (err instanceof SolanaError && err.kind === 'limited') throw new SolanaError(err.message, 'busy');
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
}

function rpcOnce(node, method, params) {
  const run = queue.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    let res;
    try {
      res = await fetch(node.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SolanaError(err?.name === 'TimeoutError' ? 'The Solana node did not answer in time.' : 'The Solana node could not be reached.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new SolanaError('The Solana node refused the HELIUS_API_KEY (or SOLANA_RPC_URL) in config.env.', 'setup');
    }
    if (res.status === 429) throw new SolanaError("The Solana node's rate limit was reached. Try again in a moment.", 'limited');
    let body;
    try {
      body = await res.json();
    } catch {
      throw new SolanaError(`The Solana node answered ${res.status} with something that is not JSON-RPC.`);
    }
    if (body?.error) {
      const said = hide(body.error.message ?? `error ${body.error.code}`, node.secret);
      if (/rate limit|too many requests/i.test(said)) throw new SolanaError("The Solana node's rate limit was reached.", 'limited');
      if (/api key|unauthori[sz]ed|forbidden/i.test(said)) {
        throw new SolanaError(`The Solana node refused the key: ${said.slice(0, 120)}`, 'setup');
      }
      throw new SolanaError(`The Solana node answered: ${said.slice(0, 160)}`);
    }
    if (!body || !('result' in body)) throw new SolanaError('The Solana node answered without a result.');
    return body.result;
  });
  queue = run.catch(() => {});
  return run;
}

// A transaction never changes once it is in a block: each is fetched once
// per process. Bounded, oldest out first.
const txCache = new Map();
const TX_CACHE_MAX = 5000;

async function transaction(signature) {
  if (txCache.has(signature)) return txCache.get(signature);
  const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (tx) {
    txCache.set(signature, tx);
    if (txCache.size > TX_CACHE_MAX) txCache.delete(txCache.keys().next().value);
  }
  return tx;
}

const keyOf = (k) => (typeof k === 'string' ? k : k?.pubkey);

/**
 * One transaction's rows for `address`: a row per token whose balance the
 * wallet's accounts changed, and one for SOL itself. Pure.
 */
export function rowsOf(tx, signature, address) {
  if (!tx?.meta || tx.blockTime == null) return [];
  const timeStamp = String(tx.blockTime);
  const rows = [];
  const row = (contract, delta, decimals) => {
    if (delta === 0n) return;
    const into = delta > 0n;
    rows.push({
      hash: signature,
      timeStamp,
      contractAddress: contract,
      from: into ? 'other' : address,
      to: into ? address : 'other',
      value: (into ? delta : -delta).toString(),
      tokenDecimal: String(decimals),
    });
  };
  // Token balances by mint, summed over every account the wallet owns.
  const sum = (list) => {
    const out = new Map();
    for (const b of list ?? []) {
      if (b.owner !== address || !b.mint) continue;
      const prev = out.get(b.mint) ?? { amount: 0n, decimals: b.uiTokenAmount?.decimals ?? 0 };
      prev.amount += BigInt(b.uiTokenAmount?.amount ?? '0');
      out.set(b.mint, prev);
    }
    return out;
  };
  const pre = sum(tx.meta.preTokenBalances);
  const post = sum(tx.meta.postTokenBalances);
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(mint)?.amount ?? 0n;
    const after = post.get(mint)?.amount ?? 0n;
    row(mint, after - before, (post.get(mint) ?? pre.get(mint)).decimals);
  }
  // SOL: the wallet's lamports, with the fee it paid as the first signer put
  // back, since the fee was neither bought nor sold. Under 0.01 SOL it is the
  // rent of an account opened or closed, or a tip, and no purchase or sale:
  // kept, it made nearly every loan read as one that also moved the asset.
  const keys = (tx.transaction?.message?.accountKeys ?? []).map(keyOf);
  const i = keys.indexOf(address);
  if (i >= 0 && tx.meta.preBalances?.[i] != null && tx.meta.postBalances?.[i] != null) {
    let delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    if (i === 0) delta += BigInt(tx.meta.fee ?? 0);
    if (delta >= DUST || delta <= -DUST) row(NATIVE_SOL, delta, 9);
  }
  return rows;
}

/**
 * The wallet's rows between two times. Signatures are read back from now -
 * the node has no "since" by time - and only those in the window, and not
 * failed, are fetched.
 */
export async function solanaRows(address, fromMs, toMs) {
  const sigs = [];
  let before;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new SolanaError(`More than ${MAX_PAGES * PAGE} transactions since that day: too far back to read.`);
    const list = await rpc('getSignaturesForAddress', [address, { limit: PAGE, ...(before ? { before } : {}) }]);
    if (!Array.isArray(list)) throw new SolanaError('The Solana node answered without a list of transactions.');
    let older = false;
    for (const s of list) {
      const at = s.blockTime == null ? null : s.blockTime * 1000;
      if (at !== null && at < fromMs) older = true;
      else if (at !== null && at <= toMs && s.err == null) sigs.push(s.signature);
    }
    if (older || list.length < PAGE) break;
    before = list[list.length - 1].signature;
  }
  const rows = [];
  for (const sig of sigs.reverse()) rows.push(...rowsOf(await transaction(sig), sig, address));
  return rows;
}

/**
 * A stored signature's transaction, for the audit: `{ ok, at, rows }`, or
 * null when the node knows no such transaction.
 */
export async function solanaTx(signature, address) {
  const tx = await transaction(signature);
  if (!tx) return null;
  return { ok: tx.meta?.err == null, at: (tx.blockTime ?? 0) * 1000, rows: rowsOf(tx, signature, address) };
}

/** Anything said about the node, with its key or URL taken out. */
export const hideSolana = (text) => hide(text, solanaNode().secret);
