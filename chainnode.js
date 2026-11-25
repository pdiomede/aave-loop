/**
 * A chain's token transfers read straight from one of its nodes, for the
 * chains Etherscan's free plan refuses (Base, Optimism). Server-only. Answers
 * rows in the shape Etherscan's `account/tokentx` gives - hash, timeStamp,
 * contractAddress, from, to, value, tokenDecimal - so etherscan.js matches
 * them by the same rules whatever they came from.
 *
 * Plain JSON-RPC: a block for a time is searched for with
 * `eth_getBlockByNumber`, and the transfers are `eth_getLogs` for the ERC-20
 * Transfer event on the coin's and the asset's contracts, the wallet as sender
 * and as receiver, in spans the node allows. Found on 25 Nov 2026:
 * mainnet.optimism.io answers old blocks, 10,000 at a time, with no key, so
 * Optimism is searched there unless OPTIMISM_RPC_URL names another node. No
 * free keyless node answers Base's old blocks (mainnet.base.org refuses log
 * queries, publicnode asks for a token for them, others cap a query at 50
 * blocks or sit behind a bot check), so Base is searched only once
 * BASE_RPC_URL names one, a token in its URL if it needs one.
 *
 * Base's blocks went from 2 s to 0.2 s, so a block is never worked out from a
 * block time: it is searched for, by the times of the blocks around it.
 */
import { nodeUrl } from './config.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const GAP_MS = 250;
const TIMEOUT_MS = 20_000;

// How many blocks one eth_getLogs may span, to begin with: halved whenever a
// node says the range is too wide, so a node with a tighter limit still works.
const SPAN = { optimism: 10_000, base: 50_000 };

/** A node failure, tagged as etherscan.js tags its own (`kind`). */
export class NodeError extends Error {
  constructor(message, kind = 'busy') {
    super(message);
    this.kind = kind;
  }
}

/** The node a chain is searched on, or null: Etherscan is asked instead. */
export const nodeFor = (network) => nodeUrl(network);

// The node's URL can carry a token: nothing leaving here names it.
const hide = (text, url) => {
  let s = String(text ?? '');
  if (url) s = s.split(url).join('<node>');
  return s.replace(/https?:\/\/\S+/g, '<node>');
};

const queues = new Map();

/** One JSON-RPC call, one at a time per node, spaced. */
function rpc(url, method, params) {
  const prev = queues.get(url) ?? { chain: Promise.resolve(), lastAt: 0 };
  const run = prev.chain.then(async () => {
    const wait = prev.lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    prev.lastAt = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NodeError(err?.name === 'TimeoutError' ? 'The node did not answer in time.' : 'The node could not be reached.');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new NodeError(`The node answered ${res.status} with something that is not JSON-RPC.`);
    }
    if (body?.error) {
      const said = hide(body.error.message ?? `error ${body.error.code}`, url);
      if (/range|too large|too many (results|logs)|limited to|response size|exceed/i.test(said)) {
        throw new NodeError(said, 'range');
      }
      if (/archive|token|unauthori[sz]ed|forbidden|api key/i.test(said)) {
        throw new NodeError(`The node refuses old blocks: ${said.slice(0, 120)}`, 'unsupported');
      }
      throw new NodeError(`The node answered: ${said.slice(0, 160)}`);
    }
    return body.result;
  });
  prev.chain = run.catch(() => {});
  queues.set(url, prev);
  return run;
}

const hex = (n) => `0x${n.toString(16)}`;
const num = (h) => Number(BigInt(h));

const blockTimes = new Map();

async function blockTime(url, n) {
  const k = `${url}:${n}`;
  if (blockTimes.has(k)) return blockTimes.get(k);
  const b = await rpc(url, 'eth_getBlockByNumber', [hex(n), false]);
  if (!b?.timestamp) throw new NodeError('The node gave no block there.');
  const at = num(b.timestamp) * 1000;
  blockTimes.set(k, at);
  return at;
}

/**
 * The first block at or after `ms` ('after'), or the last at or before it
 * ('before'). Interpolated between the bracketing blocks' times, then halved
 * once the bracket is narrow: a dozen calls, where halving alone took thirty.
 */
async function blockAt(url, ms, closest) {
  const latest = num(await rpc(url, 'eth_blockNumber', []));
  const latestAt = await blockTime(url, latest);
  if (ms >= latestAt) return latest;
  if (ms <= (await blockTime(url, 0))) return 0;
  // Start between the nearest blocks already known on either side - the day
  // before's boundaries, as a scan reads day after day - not from genesis.
  let [lo, loAt, hi, hiAt] = [0, await blockTime(url, 0), latest, latestAt];
  const prefix = `${url}:`;
  for (const [k, at] of blockTimes) {
    if (!k.startsWith(prefix)) continue;
    const n = Number(k.slice(prefix.length));
    if (n > latest) continue;
    if (at < ms && n > lo) [lo, loAt] = [n, at];
    if (at >= ms && n < hi) [hi, hiAt] = [n, at];
  }
  while (hi - lo > 1) {
    let mid =
      hi - lo > 64 ? Math.round(lo + ((ms - loAt) * (hi - lo)) / (hiAt - loAt)) : Math.floor((lo + hi) / 2);
    mid = Math.min(hi - 1, Math.max(lo + 1, mid));
    const at = await blockTime(url, mid);
    if (at < ms) [lo, loAt] = [mid, at];
    else [hi, hiAt] = [mid, at];
  }
  // lo is before ms, hi at or after it.
  return closest === 'after' ? hi : hiAt === ms ? hi : lo;
}

const pad = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
const unpad = (topic) => `0x${String(topic).slice(26).toLowerCase()}`;

/**
 * The wallet's transfers of `contracts` between two times, as Etherscan's
 * rows. `decimals` maps each contract to its places.
 */
export async function nodeTransfersBetween(network, address, fromMs, toMs, contracts, decimals) {
  const url = nodeUrl(network);
  if (!url) throw new NodeError(`No node is set for ${network}.`, 'unsupported');
  try {
    const start = await blockAt(url, fromMs, 'after');
    const end = await blockAt(url, toMs, 'before');
    const seen = new Map();
    let span = SPAN[network] ?? 10_000;
    for (let a = start; a <= end; ) {
      const b = Math.min(end, a + span - 1);
      let logs;
      try {
        logs = [];
        for (const topics of [[TRANSFER, pad(address)], [TRANSFER, null, pad(address)]]) {
          logs.push(...(await rpc(url, 'eth_getLogs', [{ address: contracts, fromBlock: hex(a), toBlock: hex(b), topics }])));
        }
      } catch (err) {
        if (err.kind === 'range' && span > 100) {
          span = Math.floor(span / 2);
          continue;
        }
        throw err;
      }
      for (const log of logs) seen.set(`${log.transactionHash}:${log.logIndex}`, log);
      a = b + 1;
    }
    const rows = [];
    for (const log of seen.values()) {
      const contract = String(log.address).toLowerCase();
      const at = log.blockTimestamp ? num(log.blockTimestamp) * 1000 : await blockTime(url, num(log.blockNumber));
      rows.push({
        hash: String(log.transactionHash).toLowerCase(),
        timeStamp: String(Math.floor(at / 1000)),
        contractAddress: contract,
        from: unpad(log.topics[1]),
        to: unpad(log.topics[2]),
        value: BigInt(log.data === '0x' ? 0 : log.data).toString(),
        tokenDecimal: String(decimals[contract] ?? 18),
      });
    }
    return rows.sort((x, y) => Number(x.timeStamp) - Number(y.timeStamp));
  } catch (err) {
    if (err instanceof NodeError) throw new NodeError(hide(err.message, url), err.kind === 'range' ? 'busy' : err.kind);
    throw new NodeError('The node search failed.');
  }
}
