import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_FACTORIES,
  BASE_USDC,
  SWAP_TOPICS,
  aggregateApprovedLogs,
  createMomentumLoader,
  decodeApprovedSwap,
  decodeIntWord,
  decodeV2Swap,
  factoryOwnershipMatches,
  isApprovedPoolIdentity,
  MAX_INVENTORY,
  normalizePoolFee,
  parseMomentumInput,
  parseResolverInput,
  resolveSnapshot,
  topicMatchesFactory,
} from "../lib/momentum.mjs";

const TOKEN_A = "0x00000000000000000000000000000000000000aa";
const TOKEN_B = "0x00000000000000000000000000000000000000bb";
const POOL_A = "0x0000000000000000000000000000000000000a01";
const POOL_B = "0x0000000000000000000000000000000000000b01";
const V3_POOL = { address: POOL_A, factory: APPROVED_FACTORIES.uniswap_v3[0].toLowerCase(), dexFamily: "uniswap_v3", token0: BASE_USDC, token1: TOKEN_A };
const V2_POOL = { address: POOL_B, factory: APPROVED_FACTORIES.aerodrome_classic[0].toLowerCase(), dexFamily: "aerodrome_classic", token0: TOKEN_B, token1: BASE_USDC };
const SAMPLE_SNAPSHOT = { window: { start_block: 1, end_block: 300 }, source: { state: "healthy" }, methodology: "test", limitations: [], tokens: [], fresh_ttl_ms: 10, stale_ttl_ms: 100 };

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function signedWord(value) {
  return (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");
}

function v3Log({ address = POOL_A, block = 100, hash = "0xhash", amount0 = 2_000_000n, amount1 = -4_000_000_000_000_000_000n } = {}) {
  return { address, blockNumber: `0x${block.toString(16)}`, transactionHash: hash, topics: [SWAP_TOPICS.uniswap_v3], data: `0x${signedWord(amount0)}${signedWord(amount1)}${word(0)}${word(0)}${word(0)}` };
}

test("validates only a bounded optional limit", () => {
  assert.deepEqual(parseMomentumInput(), { limit: 5 });
  assert.deepEqual(parseMomentumInput({ limit: "10" }), { limit: 10 });
  assert.throws(() => parseMomentumInput({ limit: 11 }), /limit/);
  assert.throws(() => parseMomentumInput({ chain: "base" }), /unsupported/);
});

test("validates a tightly bounded resolver query and rejects undeclared fields", () => {
  assert.deepEqual(parseResolverInput({ query: "  Token  " }), { query: "Token", limit: 5 });
  assert.deepEqual(parseResolverInput({ query: "0xabc", limit: "1" }), { query: "0xabc", limit: 1 });
  assert.throws(() => parseResolverInput({}), /query/);
  assert.throws(() => parseResolverInput({ query: "" }), /query/);
  assert.throws(() => parseResolverInput({ query: "x".repeat(81) }), /query/);
  assert.throws(() => parseResolverInput({ query: "x", limit: 6 }), /limit/);
  assert.throws(() => parseResolverInput({ query: "x", chain: "base" }), /unsupported/);
});

test("decodes signed V3 amounts and V2 USDC max-in-or-out exactly", () => {
  const minusOne = `0x${"f".repeat(64)}`;
  assert.equal(decodeIntWord(minusOne, 0), -1n);
  const v3 = decodeApprovedSwap(v3Log(), V3_POOL);
  assert.equal(v3.usdcVolumeAtomic, 2_000_000n);
  assert.equal(v3.direction, "buy");
  const v2Data = `0x${word(4_000_000n)}${word(0)}${word(0)}${word(3_000_000n)}`;
  assert.deepEqual(decodeV2Swap(v2Data), { amount0In: 4_000_000n, amount1In: 0n, amount0Out: 0n, amount1Out: 3_000_000n });
  const v2 = decodeApprovedSwap({ topics: [SWAP_TOPICS.v2], data: v2Data }, V2_POOL);
  assert.equal(v2.usdcVolumeAtomic, 3_000_000n);
  assert.equal(v2.direction, "sell");
});

test("requires approved factory and native Base USDC, verifies factory ownership, and rejects mismatched topics", () => {
  assert.equal(normalizePoolFee(3_000), 3_000);
  assert.equal(normalizePoolFee(3_000n), 3_000);
  assert.equal(normalizePoolFee(0x1_000000), null);
  assert.equal(isApprovedPoolIdentity(V3_POOL), true);
  assert.equal(isApprovedPoolIdentity({ ...V3_POOL, factory: "0x0000000000000000000000000000000000000001" }), false);
  assert.equal(isApprovedPoolIdentity({ ...V3_POOL, token0: TOKEN_A, token1: TOKEN_B }), false);
  assert.equal(factoryOwnershipMatches(V3_POOL, POOL_A), true);
  assert.equal(factoryOwnershipMatches(V3_POOL, POOL_B), false);
  assert.equal(factoryOwnershipMatches(V2_POOL, true), true);
  assert.equal(factoryOwnershipMatches(V2_POOL, false), false);
  assert.equal(topicMatchesFactory(v3Log(), V3_POOL), true);
  assert.equal(topicMatchesFactory({ ...v3Log(), topics: [SWAP_TOPICS.v2] }, V3_POOL), false);
  assert.equal(topicMatchesFactory({ topics: [SWAP_TOPICS.v2] }, V2_POOL), true);
});

test("aggregates BigInt USDC volume across every approved pool and ranks by volume, unique transactions, then token address", () => {
  const lowCountHighVolume = v3Log({ address: POOL_A, hash: "0xhigh", amount0: 9_007_199_254_740_993n });
  const lowerVolumeOne = v3Log({ address: "0x0000000000000000000000000000000000000c01", hash: "0xlow1", amount0: 2_000_000n });
  const lowerVolumeTwo = v3Log({ address: "0x0000000000000000000000000000000000000c01", hash: "0xlow2", amount0: 2_000_000n });
  const poolC = { ...V3_POOL, address: "0x0000000000000000000000000000000000000c01", token1: TOKEN_B };
  const metadata = new Map([[TOKEN_A, { address: TOKEN_A, symbol: "A", name: "Alpha", decimals: 18 }], [TOKEN_B, { address: TOKEN_B, symbol: "B", name: "Beta", decimals: 18 }]]);
  const rows = aggregateApprovedLogs([lowCountHighVolume, lowerVolumeOne, lowerVolumeTwo], [V3_POOL, poolC], metadata);
  assert.equal(rows[0].token.address, TOKEN_A);
  assert.equal(rows[0].usdc_volume_atomic, "9007199254740993");
  assert.equal(rows[0].unique_transaction_count, 1);
  assert.equal(rows[1].token.address, TOKEN_B);
  assert.equal(rows[1].unique_transaction_count, 2);
  const ties = aggregateApprovedLogs([v3Log({ address: POOL_A, hash: "0xa", amount0: 1_000_000n }), v3Log({ address: POOL_B, hash: "0xb", amount0: -1_000_000n, amount1: 2_000_000_000_000_000_000n, block: 101 })], [V3_POOL, { ...V3_POOL, address: POOL_B, token1: TOKEN_B }]);
  assert.deepEqual(ties.map((row) => row.token.address), [TOKEN_A, TOKEN_B]);
});

test("serves bounded stale cache after a refresh failure", async () => {
  let clock = 1_000;
  let fail = false;
  let calls = 0;
  const loader = createMomentumLoader({
    rpcUrls: ["https://invalid.test"],
    now: () => clock,
    ttlMs: 10,
    staleTtlMs: 100,
    loadFromRpcImpl: async (_endpoint, input) => {
      calls += 1;
      if (fail) throw new Error("offline");
      return { ...SAMPLE_SNAPSHOT, limit: input.limit, observed_at: new Date(clock).toISOString() };
    },
  });
  const [fresh, coalesced] = await Promise.all([loader(), loader({ limit: 1 })]);
  assert.equal(fresh.cache.status, "fresh");
  assert.equal(coalesced.cache.status, "fresh");
  assert.equal(calls, 1);
  clock += 20;
  fail = true;
  const stale = await loader();
  assert.equal(stale.cache.status, "stale");
  assert.equal(stale.cache.age_ms, 20);
  clock += 100;
  await assert.rejects(() => loader(), /offline/);
});

test("caches the full supported inventory when a small request arrives first", async () => {
  let clock = 1_000;
  const requestedLimits = [];
  const allTokens = Array.from({ length: 10 }, (_, index) => ({
    rank: index + 1,
    token: { address: `0x${String(index + 1).padStart(40, "0")}` },
  }));
  const loader = createMomentumLoader({
    rpcUrls: ["https://rpc.test"],
    now: () => clock,
    loadFromRpcImpl: async (_endpoint, input) => {
      requestedLimits.push(input.limit);
      return { ...SAMPLE_SNAPSHOT, limit: input.limit, observed_at: new Date(clock).toISOString(), tokens: allTokens.slice(0, input.limit) };
    },
  });

  const firstSmall = await loader({ limit: 1 });
  const thenLarge = await loader({ limit: 10 });
  assert.equal(firstSmall.tokens.length, 1);
  assert.equal(thenLarge.tokens.length, 10);
  assert.deepEqual(requestedLimits, [MAX_INVENTORY]);

  clock += 61_000;
  const [concurrentSmall, concurrentLarge] = await Promise.all([loader({ limit: 1 }), loader({ limit: 10 })]);
  assert.equal(concurrentSmall.tokens.length, 1);
  assert.equal(concurrentLarge.tokens.length, 10);
  assert.deepEqual(requestedLimits, [MAX_INVENTORY, MAX_INVENTORY]);
});

test("resolver orders exact address, metadata, prefix, and substring matches with deterministic activity ties", async () => {
  const tokens = [
    { rank: 1, token: { address: "0x0000000000000000000000000000000000000001", symbol: "same", name: "Alpha" }, usdc_volume_atomic: "10", unique_transaction_count: 2 },
    { rank: 2, token: { address: "0x0000000000000000000000000000000000000002", symbol: "same", name: "Alphabet" }, usdc_volume_atomic: "10", unique_transaction_count: 2 },
    { rank: 3, token: { address: "0x0000000000000000000000000000000000000003", symbol: "ALPINE", name: "Other" }, usdc_volume_atomic: "99", unique_transaction_count: 1 },
    { rank: 4, token: { address: "0x00000000000000000000000000000000000000ab", symbol: "ZZ", name: "contains alpha" }, usdc_volume_atomic: "999", unique_transaction_count: 9 },
  ];
  const snapshot = { ...SAMPLE_SNAPSHOT, observed_at: new Date(1_000).toISOString(), tokens, fresh_ttl_ms: 60_000, stale_ttl_ms: 300_000 };
  const same = resolveSnapshot(snapshot, parseResolverInput({ query: "same" }), 1_000, false);
  assert.deepEqual(same.candidates.map((item) => item.token.address), [tokens[0].token.address, tokens[1].token.address]);
  assert.deepEqual(same.candidates.map((item) => item.match_method), ["exact_symbol_or_name", "exact_symbol_or_name"]);
  const prefix = resolveSnapshot(snapshot, parseResolverInput({ query: "alp", limit: 5 }), 1_000, false);
  assert.deepEqual(prefix.candidates.map((item) => item.match_method), ["prefix", "prefix", "prefix", "substring"]);
  const address = resolveSnapshot(snapshot, parseResolverInput({ query: tokens[3].token.address.toUpperCase() }), 1_000, false);
  assert.equal(address.candidates[0].match_method, "exact_address");
  assert.equal(address.candidates.length, 1);
});

test("resolver and momentum share one full-inventory refresh", async () => {
  let calls = 0;
  const tokens = Array.from({ length: 12 }, (_, index) => ({ rank: index + 1, token: { address: `0x${String(index + 1).padStart(40, "0")}`, symbol: `T${index + 1}`, name: `Token ${index + 1}` }, usdc_volume_atomic: String(12 - index), unique_transaction_count: 1 }));
  const loader = createMomentumLoader({
    rpcUrls: ["https://rpc.test"],
    loadFromRpcImpl: async (_endpoint, input) => { calls += 1; return { ...SAMPLE_SNAPSHOT, limit: input.limit, observed_at: new Date().toISOString(), tokens: tokens.slice(0, input.limit) }; },
  });
  const [momentum, resolved] = await Promise.all([loader({ limit: 10 }), loader.resolve({ query: "token" })]);
  assert.equal(calls, 1);
  assert.equal(momentum.tokens.length, 10);
  assert.equal(resolved.candidates.length, 5);
});
