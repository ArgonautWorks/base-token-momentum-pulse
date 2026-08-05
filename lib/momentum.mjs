import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
export const RPC_URLS = Object.freeze([
  "https://mainnet.base.org",
  "https://base.drpc.org",
]);
export const WINDOW_BLOCKS = 300;
export const SEALED_BLOCKS = 2;
export const MAX_LIMIT = 10;
export const MAX_INVENTORY = 250;
export const RESOLVER_MAX_LIMIT = 5;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MULTICALL_POOL_CHUNK_SIZE = 75;
export const SWAP_TOPICS = Object.freeze({
  uniswap_v3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  aerodrome_slipstream: "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83",
  v2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
});
export const APPROVED_FACTORIES = Object.freeze({
  uniswap_v3: ["0x33128a8fC17869897dcE68Ed026d694621f6FDfD"],
  aerodrome_classic: ["0x420DD381b31aEf6683db6B902084cB0FFECe40Da"],
  aerodrome_slipstream: [
    "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
    "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a",
    "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  ],
});

const HEX_WORD = 64;
const POOL_ABI = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"]);
const TOKEN_ABI = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);

function cleanAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value ?? "")) ? String(value).toLowerCase() : null;
}

function toBlockNumber(hex) {
  if (!/^0x[\da-f]+$/i.test(String(hex))) throw new Error("RPC returned an invalid block number");
  const value = Number(BigInt(hex));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("RPC block number is unsafe");
  return value;
}

function paddedWord(data, index) {
  const raw = String(data ?? "").replace(/^0x/, "");
  const start = index * HEX_WORD;
  const word = raw.slice(start, start + HEX_WORD);
  return /^[\da-f]{64}$/i.test(word) ? word : null;
}

export function decodeUintWord(data, index) {
  const word = paddedWord(data, index);
  if (!word) throw new Error("event data is missing a uint256 word");
  return BigInt(`0x${word}`);
}

export function decodeIntWord(data, index) {
  const value = decodeUintWord(data, index);
  return value >= (1n << 255n) ? value - (1n << 256n) : value;
}

export function decodeV3Swap(data) {
  return { amount0: decodeIntWord(data, 0), amount1: decodeIntWord(data, 1) };
}

export function decodeV2Swap(data) {
  return {
    amount0In: decodeUintWord(data, 0),
    amount1In: decodeUintWord(data, 1),
    amount0Out: decodeUintWord(data, 2),
    amount1Out: decodeUintWord(data, 3),
  };
}

function abs(value) {
  return value < 0n ? -value : value;
}

function max(left, right) {
  return left > right ? left : right;
}

export function decodeApprovedSwap(log, pool) {
  const isV2 = String(log?.topics?.[0] ?? "").toLowerCase() === SWAP_TOPICS.v2;
  const usdcIndex = pool.token0 === BASE_USDC ? 0 : pool.token1 === BASE_USDC ? 1 : null;
  if (usdcIndex === null) throw new Error("approved pool does not include Base USDC");
  const nonUsdcIndex = usdcIndex === 0 ? 1 : 0;
  if (isV2) {
    const decoded = decodeV2Swap(log.data);
    const usdcIn = usdcIndex === 0 ? decoded.amount0In : decoded.amount1In;
    const usdcOut = usdcIndex === 0 ? decoded.amount0Out : decoded.amount1Out;
    const nonUsdcIn = nonUsdcIndex === 0 ? decoded.amount0In : decoded.amount1In;
    const nonUsdcOut = nonUsdcIndex === 0 ? decoded.amount0Out : decoded.amount1Out;
    return {
      usdcVolumeAtomic: max(usdcIn, usdcOut),
      direction: nonUsdcOut > 0n ? "buy" : nonUsdcIn > 0n ? "sell" : null,
    };
  }
  const decoded = decodeV3Swap(log.data);
  const usdcAmount = usdcIndex === 0 ? decoded.amount0 : decoded.amount1;
  const nonUsdcAmount = nonUsdcIndex === 0 ? decoded.amount0 : decoded.amount1;
  return {
    usdcVolumeAtomic: abs(usdcAmount),
    direction: nonUsdcAmount < 0n ? "buy" : nonUsdcAmount > 0n ? "sell" : null,
  };
}

export function parseMomentumInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input must be an object");
  const unexpected = Object.keys(value).filter((key) => key !== "limit");
  if (unexpected.length) throw new Error(`unsupported field: ${unexpected[0]}`);
  const limit = value.limit === undefined ? 5 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return { limit };
}

export function parseResolverInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input must be an object");
  const unexpected = Object.keys(value).filter((key) => key !== "query" && key !== "limit");
  if (unexpected.length) throw new Error(`unsupported field: ${unexpected[0]}`);
  if (typeof value.query !== "string") throw new Error("query must be a string from 1 to 80 characters");
  const query = value.query.trim();
  if (query.length < 1 || query.length > 80) throw new Error("query must be a string from 1 to 80 characters");
  const limit = value.limit === undefined ? RESOLVER_MAX_LIMIT : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > RESOLVER_MAX_LIMIT) throw new Error(`limit must be an integer from 1 to ${RESOLVER_MAX_LIMIT}`);
  return { query, limit };
}

function factoryFamily(factory) {
  const normalized = cleanAddress(factory);
  if (!normalized) return null;
  return Object.entries(APPROVED_FACTORIES).find(([, addresses]) => addresses.map(cleanAddress).includes(normalized))?.[0] ?? null;
}

export function isApprovedPoolIdentity({ factory, token0, token1 }) {
  return Boolean(factoryFamily(factory) && cleanAddress(token0) && cleanAddress(token1)
    && (cleanAddress(token0) === BASE_USDC || cleanAddress(token1) === BASE_USDC));
}

export function blockscoutAddressUrl(address) {
  return `https://base.blockscout.com/address/${address}`;
}

export function blockscoutTokenUrl(address) {
  return `https://base.blockscout.com/token/${address}`;
}

export function createRpcClient(endpoint, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  let id = 0;
  return async function rpc(method, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json", "User-Agent": "ArgonautWorks/base-token-momentum-pulse" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Base RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`Base RPC ${body.error.code ?? "error"}: ${body.error.message ?? "unknown"}`);
    return body?.result;
  };
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function resultOrNull(result) {
  return result?.status === "success" ? result.result : null;
}

export function normalizePoolFee(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffff) return value;
  if (typeof value === "bigint" && value >= 0n && value <= 0xffffffn) return Number(value);
  return null;
}

export function topicMatchesFactory(log, pool) {
  const topic = String(log?.topics?.[0] ?? "").toLowerCase();
  return (pool.dexFamily === "uniswap_v3" && topic === SWAP_TOPICS.uniswap_v3)
    || (pool.dexFamily === "aerodrome_classic" && topic === SWAP_TOPICS.v2)
    || (pool.dexFamily === "aerodrome_slipstream" && topic === SWAP_TOPICS.aerodrome_slipstream);
}

export function factoryOwnershipMatches(pool, result) {
  return pool.dexFamily === "uniswap_v3"
    ? cleanAddress(result) === pool.address
    : result === true;
}

export function createMulticallReader(endpoint, { timeoutMs = 12_000 } = {}) {
  const client = createPublicClient({ chain: base, transport: http(endpoint, { timeout: timeoutMs, retryCount: 0 }) });
  const factoryAbi = parseAbi(["function isPool(address) view returns (bool)", "function getPool(address,address,uint24) view returns (address)"]);
  async function call(contracts, allowFailure) {
    return client.multicall({ contracts, allowFailure, multicallAddress: MULTICALL3 });
  }
  return {
    async poolIdentities(addresses) {
      const preliminaries = [];
      for (const group of chunks(addresses, MULTICALL_POOL_CHUNK_SIZE)) {
        const results = await call(group.flatMap((address) => ["factory", "token0", "token1", "fee"].map((functionName) => ({ address, abi: POOL_ABI, functionName }))), true);
        for (let index = 0; index < group.length; index += 1) {
          const offset = index * 4;
          const factory = cleanAddress(resultOrNull(results[offset]));
          const token0 = cleanAddress(resultOrNull(results[offset + 1]));
          const token1 = cleanAddress(resultOrNull(results[offset + 2]));
          const fee = normalizePoolFee(resultOrNull(results[offset + 3]));
          const dexFamily = factoryFamily(factory);
          if (dexFamily && isApprovedPoolIdentity({ factory, token0, token1 }) && (dexFamily !== "uniswap_v3" || fee !== null)) {
            preliminaries.push({ address: group[index], factory, dexFamily, token0, token1, fee });
          }
        }
      }
      const validated = [];
      for (const group of chunks(preliminaries, MULTICALL_POOL_CHUNK_SIZE)) {
        const results = await call(group.map((pool) => pool.dexFamily === "uniswap_v3"
          ? { address: pool.factory, abi: factoryAbi, functionName: "getPool", args: [pool.token0, pool.token1, pool.fee] }
          : { address: pool.factory, abi: factoryAbi, functionName: "isPool", args: [pool.address] }), false);
        for (let index = 0; index < group.length; index += 1) {
          const pool = group[index];
          const valid = factoryOwnershipMatches(pool, results[index]);
          if (valid) validated.push(pool);
        }
      }
      return validated;
    },
    async tokenMetadata(addresses) {
      const metadata = new Map();
      for (const group of chunks(addresses, MULTICALL_POOL_CHUNK_SIZE)) {
        const results = await call(group.flatMap((address) => ["symbol", "name", "decimals"].map((functionName) => ({ address, abi: TOKEN_ABI, functionName }))), true);
        for (let index = 0; index < group.length; index += 1) {
          const offset = index * 3;
          const symbol = resultOrNull(results[offset]);
          const name = resultOrNull(results[offset + 1]);
          const decimals = resultOrNull(results[offset + 2]);
          metadata.set(group[index], {
            address: group[index],
            symbol: typeof symbol === "string" ? symbol : null,
            name: typeof name === "string" ? name : null,
            decimals: typeof decimals === "number" ? decimals : typeof decimals === "bigint" && decimals <= 255n ? Number(decimals) : null,
            blockscout_url: blockscoutTokenUrl(group[index]),
          });
        }
      }
      return metadata;
    },
  };
}

export function aggregateApprovedLogs(logs, pools, tokenMetadata = new Map()) {
  const byPool = new Map(pools.map((pool) => [pool.address, pool]));
  const byToken = new Map();
  for (const log of logs) {
    const pool = byPool.get(cleanAddress(log?.address));
    if (!pool || !topicMatchesFactory(log, pool)) continue;
    let decoded;
    try {
      decoded = decodeApprovedSwap(log, pool);
    } catch {
      continue;
    }
    if (decoded.usdcVolumeAtomic <= 0n) continue;
    const tokenAddress = pool.token0 === BASE_USDC ? pool.token1 : pool.token0;
    const record = byToken.get(tokenAddress) ?? {
      token_address: tokenAddress,
      usdc_volume_atomic: 0n,
      swap_count: 0,
      tx_hashes: new Set(),
      buys: 0,
      sells: 0,
      first_swap_block: null,
      last_swap_block: null,
      pools: new Map(),
    };
    const block = toBlockNumber(log.blockNumber);
    record.usdc_volume_atomic += decoded.usdcVolumeAtomic;
    record.swap_count += 1;
    if (typeof log.transactionHash === "string") record.tx_hashes.add(log.transactionHash.toLowerCase());
    if (decoded.direction === "buy") record.buys += 1;
    if (decoded.direction === "sell") record.sells += 1;
    record.first_swap_block = record.first_swap_block === null ? block : Math.min(record.first_swap_block, block);
    record.last_swap_block = record.last_swap_block === null ? block : Math.max(record.last_swap_block, block);
    record.pools.set(pool.address, { address: pool.address, factory: pool.factory, dex_family: pool.dexFamily, blockscout_url: blockscoutAddressUrl(pool.address) });
    byToken.set(tokenAddress, record);
  }
  return [...byToken.values()]
    .sort((left, right) => right.usdc_volume_atomic > left.usdc_volume_atomic ? 1 : right.usdc_volume_atomic < left.usdc_volume_atomic ? -1 : right.tx_hashes.size - left.tx_hashes.size || left.token_address.localeCompare(right.token_address))
    .map((record, index) => ({
      rank: index + 1,
      token: tokenMetadata.get(record.token_address) ?? { address: record.token_address, symbol: null, name: null, decimals: null, blockscout_url: blockscoutTokenUrl(record.token_address) },
      usdc_volume_atomic: record.usdc_volume_atomic.toString(),
      usdc_volume: formatUnits(record.usdc_volume_atomic, 6),
      swap_count: record.swap_count,
      unique_transaction_count: record.tx_hashes.size,
      buys: record.buys,
      sells: record.sells,
      first_swap_block: record.first_swap_block,
      last_swap_block: record.last_swap_block,
      participating_pools: [...record.pools.values()].sort((left, right) => left.address.localeCompare(right.address)),
    }));
}

export function formatUnits(value, decimals) {
  const amount = BigInt(value);
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const fraction = (amount % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function loadFromRpc(endpoint, input, options) {
  const rpc = createRpcClient(endpoint, options);
  const multicall = createMulticallReader(endpoint, options);
  const latest = toBlockNumber(await rpc("eth_blockNumber"));
  const endBlock = latest - SEALED_BLOCKS;
  const startBlock = endBlock - WINDOW_BLOCKS + 1;
  if (startBlock < 0) throw new Error("Base chain is too short for the configured window");
  const [startHeader, endHeader, ...topicLogs] = await Promise.all([
    rpc("eth_getBlockByNumber", [`0x${startBlock.toString(16)}`, false]),
    rpc("eth_getBlockByNumber", [`0x${endBlock.toString(16)}`, false]),
    ...Object.values(SWAP_TOPICS).map((topic) => rpc("eth_getLogs", [{ fromBlock: `0x${startBlock.toString(16)}`, toBlock: `0x${endBlock.toString(16)}`, topics: [topic] }])),
  ]);
  const logs = topicLogs.flat();
  const observedAddresses = [...new Set(logs.map((log) => cleanAddress(log?.address)).filter(Boolean))].sort();
  const approvedPools = await multicall.poolIdentities(observedAddresses);
  if (!approvedPools.length) throw new Error("no approved Base-USDC pools in sampled window");
  const activeLogs = logs.filter((log) => approvedPools.some((pool) => pool.address === cleanAddress(log?.address) && topicMatchesFactory(log, pool)));
  const tokenAddresses = [...new Set(approvedPools.map((pool) => pool.token0 === BASE_USDC ? pool.token1 : pool.token0))];
  const metadata = await multicall.tokenMetadata(tokenAddresses);
  const rankings = aggregateApprovedLogs(activeLogs, approvedPools, metadata);
  if (!rankings.length) throw new Error("no validated Base-USDC swap activity in sampled window");
  return {
    limit: input.limit,
    observed_at: new Date(options.now()).toISOString(),
    window: {
      blocks: WINDOW_BLOCKS,
      sealed_blocks_behind_latest: SEALED_BLOCKS,
      start_block: startBlock,
      end_block: endBlock,
      start_timestamp: startHeader?.timestamp ? new Date(Number(BigInt(startHeader.timestamp)) * 1_000).toISOString() : null,
      end_timestamp: endHeader?.timestamp ? new Date(Number(BigInt(endHeader.timestamp)) * 1_000).toISOString() : null,
    },
    source: {
      type: "direct_base_mainnet_json_rpc",
      endpoint,
      state: "healthy",
      swap_topics: SWAP_TOPICS,
      approved_factories: APPROVED_FACTORIES,
      base_usdc: BASE_USDC,
      scanned_logs: logs.length,
      observed_pools_checked: observedAddresses.length,
      approved_usdc_pools: approvedPools.length,
    },
    methodology: "Scans only the sealed 300-block Base window for listed swap topics, validates pool factory/token0/token1 onchain, accepts only approved factories paired with native Base USDC, then ranks non-USDC tokens by exact USDC-side swap volume, unique transaction count, and token address.",
    limitations: [
      "Sampled 300-block window only; this is not a complete market view.",
      "Only approved pools with native Base USDC are included.",
      "Raw onchain activity can include bots or wash trading.",
      "No safety, quality, or return judgment is made.",
      "Not investment advice.",
    ],
    tokens: rankings.slice(0, MAX_INVENTORY),
  };
}

function projectSnapshot(snapshot, input, now, stale) {
  return {
    ...snapshot,
    limit: input.limit,
    tokens: snapshot.tokens.slice(0, input.limit),
    cache: { status: stale ? "stale" : "fresh", stale, age_ms: Math.max(0, now - Date.parse(snapshot.observed_at)), fresh_ttl_ms: snapshot.fresh_ttl_ms, stale_ttl_ms: snapshot.stale_ttl_ms },
  };
}

function compareActivity(left, right) {
  const volume = BigInt(right.usdc_volume_atomic) - BigInt(left.usdc_volume_atomic);
  if (volume !== 0n) return volume > 0n ? 1 : -1;
  return right.unique_transaction_count - left.unique_transaction_count || left.token.address.localeCompare(right.token.address);
}

export function resolveSnapshot(snapshot, input, now, stale) {
  const needle = input.query.toLowerCase();
  const candidates = snapshot.tokens
    .map((item) => {
      const address = item.token.address.toLowerCase();
      const symbol = String(item.token.symbol ?? "").toLowerCase();
      const name = String(item.token.name ?? "").toLowerCase();
      let match = null;
      if (address === needle) match = { quality: 0, method: "exact_address" };
      else if (symbol === needle || name === needle) match = { quality: 1, method: "exact_symbol_or_name" };
      else if (address.startsWith(needle) || symbol.startsWith(needle) || name.startsWith(needle)) match = { quality: 2, method: "prefix" };
      else if (address.includes(needle) || symbol.includes(needle) || name.includes(needle)) match = { quality: 3, method: "substring" };
      return match ? { ...item, match } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.match.quality - right.match.quality || compareActivity(left, right))
    .slice(0, input.limit)
    .map(({ match, ...candidate }) => ({ ...candidate, match_method: match.method }));
  return {
    query: input.query,
    limit: input.limit,
    search_scope: "Only tokens observed with validated approved-factory native Base-USDC swap activity in this same sealed 300-block snapshot; not a complete or general token resolver.",
    search_methodology: "Matches lowercase exact address first, exact symbol/name second, prefix third, substring fourth; ties rank by exact USDC-side volume, unique transaction count, then token address.",
    observed_at: snapshot.observed_at,
    window: snapshot.window,
    source: snapshot.source,
    methodology: snapshot.methodology,
    limitations: snapshot.limitations,
    candidates,
    cache: { status: stale ? "stale" : "fresh", stale, age_ms: Math.max(0, now - Date.parse(snapshot.observed_at)), fresh_ttl_ms: snapshot.fresh_ttl_ms, stale_ttl_ms: snapshot.stale_ttl_ms },
  };
}

export function createMomentumLoader({
  rpcUrls = RPC_URLS,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = 60_000,
  staleTtlMs = 300_000,
  timeoutMs = 12_000,
  loadFromRpcImpl = loadFromRpc,
} = {}) {
  let cache = null;
  let inFlight = null;
  async function refresh() {
    let lastError;
    const attempts = [];
    for (const endpoint of rpcUrls) {
      try {
        const snapshot = await loadFromRpcImpl(endpoint, { limit: MAX_INVENTORY }, { fetchImpl, now, timeoutMs });
        attempts.push({ endpoint, state: "healthy" });
        cache = {
          ...snapshot,
          source: { ...snapshot.source, rpc_attempts: attempts },
          fresh_ttl_ms: ttlMs,
          stale_ttl_ms: staleTtlMs,
        };
        return cache;
      } catch (error) {
        lastError = error;
        attempts.push({ endpoint, state: "unavailable" });
      }
    }
    throw lastError ?? new Error("all Base RPC endpoints failed");
  }
  async function loadSnapshot(rawInput, parseInput, project) {
    const input = parseInput(rawInput);
    const current = now();
    if (cache && current - Date.parse(cache.observed_at) <= ttlMs) return project(cache, input, current, false);
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    try {
      return project(await inFlight, input, now(), false);
    } catch (error) {
      if (cache && current - Date.parse(cache.observed_at) <= staleTtlMs) return project(cache, input, current, true);
      throw error;
    }
  }
  async function loadMomentum(rawInput = {}) {
    return loadSnapshot(rawInput, parseMomentumInput, projectSnapshot);
  }
  loadMomentum.resolve = async function loadResolver(rawInput = {}) {
    return loadSnapshot(rawInput, parseResolverInput, resolveSnapshot);
  };
  return loadMomentum;
}

export const activityLoader = createMomentumLoader();
export const loadMomentum = activityLoader;
export const loadResolver = activityLoader.resolve;
