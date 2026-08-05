import express from "express";
import { randomUUID } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { APPROVED_FACTORIES, BASE_USDC, RPC_URLS, SEALED_BLOCKS, SWAP_TOPICS, WINDOW_BLOCKS, loadMomentum as defaultLoadMomentum, loadResolver as defaultLoadResolver, parseMomentumInput, parseResolverInput } from "./lib/momentum.mjs";

const PAY_TO = "0x5e2023b1D1366d6366E768fe432AD627bfAa5d57";
const NETWORK = "eip155:8453";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
const MOMENTUM_PRICE = "$0.004";
const RESOLVER_PRICE = "$0.002";
const PUBLIC_SOURCE = "https://github.com/ArgonautWorks/base-token-momentum-pulse";
const SERVICE_VERSION = "0.3.0";
const SERVICE_DESCRIPTION = "Trending Base token data ranked by exact USDC swap volume and buy/sell activity, plus a bounded active-token lookup, derived from a sealed 300-block window of validated direct onchain logs.";
const MOMENTUM_DESCRIPTION = "Find trending Base tokens by exact native-USDC DEX volume, swaps, unique transactions, and buy/sell activity in a sealed 300-block validated onchain snapshot.";
const RESOLVER_DESCRIPTION = "Look up a Base token by address, symbol, or name within the current validated native-USDC active-pool snapshot; this is not a complete or general token directory.";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());
const momentumInputSchema = { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, additionalProperties: false };
const resolverGetInputSchema = { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 5, default: 5 } }, additionalProperties: false };
const resolverPostInputSchema = { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 5, default: 5 } }, additionalProperties: false };
const outputExample = { limit: 5, window: { start_block: 40_000_000, end_block: 40_000_299 }, tokens: [{ rank: 1, token: { address: "0xexample", symbol: "TOKEN" }, usdc_volume_atomic: "1234567", usdc_volume: "1.234567" }] };
const resolverOutputExample = { query: "token", limit: 5, candidates: [{ token: { address: "0xexample", symbol: "TOKEN", name: "Example Token" }, match_method: "prefix", usdc_volume_atomic: "1234567", unique_transaction_count: 9, participating_pools: [] }] };
function agentCashCommands(origin) {
  return {
    trending_base_tokens: `npx -y agentcash fetch '${origin}/api/v1/momentum?limit=5' --payment-network base --max-amount 0.004 --yes --format json`,
    token_lookup: `npx -y agentcash fetch '${origin}/api/v1/resolve?query=cbBTC&limit=5' --payment-network base --max-amount 0.002 --yes --format json`,
    token_lookup_post: `npx -y agentcash fetch '${origin}/api/v1/resolve' --method POST --body '{"query":"WETH","limit":5}' --header 'content-type: application/json' --payment-network base --max-amount 0.002 --yes --format json`,
  };
}
const momentumGetDiscovery = declareDiscoveryExtension({ input: { limit: 5 }, inputSchema: momentumInputSchema, output: { example: outputExample } });
const momentumPostDiscovery = declareDiscoveryExtension({ input: { limit: 5 }, inputSchema: momentumInputSchema, bodyType: "json", output: { example: outputExample } });
const resolverGetDiscovery = declareDiscoveryExtension({ input: { query: "token", limit: 5 }, inputSchema: resolverGetInputSchema, output: { example: resolverOutputExample } });
const resolverPostDiscovery = declareDiscoveryExtension({ input: { query: "token", limit: 5 }, inputSchema: resolverPostInputSchema, bodyType: "json", output: { example: resolverOutputExample } });
function paidResource({ price, description, extensions, tags }) {
  return {
    accepts: [{ scheme: "exact", price, network: NETWORK, payTo: PAY_TO }],
    description,
    mimeType: "application/json",
    serviceName: "ArgonautWorks Base Token Momentum Pulse",
    tags,
    extensions,
  };
}

export function createRetriableInitializer(initialize, { maxAttempts = 3, retryDelayMs = 100 } = {}) {
  let initialized = false;
  let inFlight = null;
  return async function ensureInitialized() {
    if (initialized) return;
    if (!inFlight) inFlight = (async () => {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try { await initialize(); initialized = true; return; } catch (error) { lastError = error; if (attempt < maxAttempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt)); }
      }
      throw lastError;
    })();
    try { await inFlight; } finally { if (!initialized) inFlight = null; }
  };
}

function paymentInfo(amount) {
  return { price: { mode: "fixed", currency: "USD", amount }, protocols: [{ x402: {} }] };
}

export function createApp({ loadMomentum = defaultLoadMomentum, loadResolver = defaultLoadResolver, initializeFacilitator = () => resourceServer.initialize(), facilitatorInitOptions } = {}) {
  const app = express();
  const ensureFacilitatorInitialized = createRetriableInitializer(initializeFacilitator, facilitatorInitOptions);
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2kb" }));

  app.use("/api/v1/momentum", async (request, response, next) => {
    if (!["GET", "POST"].includes(request.method)) return next();
    try { request.momentumInput = parseMomentumInput(request.method === "POST" ? request.body : request.query); } catch (error) { return response.status(400).json({ error: error.message, charged: false }); }
    try { request.momentumPulse = await loadMomentum(request.momentumInput); } catch { return response.status(503).json({ error: "base_rpc_or_validated_inventory_unavailable", charged: false }); }
    try { await ensureFacilitatorInitialized(); } catch { response.set("Retry-After", "1"); return response.status(502).json({ error: "payment_facilitator_unavailable", charged: false }); }
    return next();
  });
  app.use("/api/v1/resolve", async (request, response, next) => {
    if (!["GET", "POST"].includes(request.method)) return next();
    try { request.resolverInput = parseResolverInput(request.method === "POST" ? request.body : request.query); } catch (error) { return response.status(400).json({ error: error.message, charged: false }); }
    try { request.resolution = await loadResolver(request.resolverInput); } catch { return response.status(503).json({ error: "base_rpc_or_validated_inventory_unavailable", charged: false }); }
    try { await ensureFacilitatorInitialized(); } catch { response.set("Retry-After", "1"); return response.status(502).json({ error: "payment_facilitator_unavailable", charged: false }); }
    return next();
  });
  app.use(paymentMiddleware({
    "GET /api/v1/momentum": paidResource({ price: MOMENTUM_PRICE, description: MOMENTUM_DESCRIPTION, tags: ["trending-base-tokens", "base-token-data", "dex-volume", "usdc-volume", "buy-sell-activity", "onchain", "x402"], extensions: momentumGetDiscovery }),
    "POST /api/v1/momentum": paidResource({ price: MOMENTUM_PRICE, description: MOMENTUM_DESCRIPTION, tags: ["trending-base-tokens", "base-token-data", "dex-volume", "usdc-volume", "buy-sell-activity", "onchain", "x402"], extensions: momentumPostDiscovery }),
    "GET /api/v1/resolve": paidResource({ price: RESOLVER_PRICE, description: RESOLVER_DESCRIPTION, tags: ["base-token-lookup", "token-resolver", "token-address", "token-symbol", "active-tokens", "usdc-pools", "x402"], extensions: resolverGetDiscovery }),
    "POST /api/v1/resolve": paidResource({ price: RESOLVER_PRICE, description: RESOLVER_DESCRIPTION, tags: ["base-token-lookup", "token-resolver", "token-address", "token-symbol", "active-tokens", "usdc-pools", "x402"], extensions: resolverPostDiscovery }),
  }, resourceServer, undefined, undefined, false));

  app.get("/", (request, response) => { const origin = `${request.protocol}://${request.get("host")}`; response.json({ service: "ArgonautWorks Base Token Momentum Pulse", purpose: SERVICE_DESCRIPTION, endpoints: { momentum: { methods: ["GET", "POST"], path: "/api/v1/momentum", price: MOMENTUM_PRICE }, resolve: { methods: ["GET", "POST"], path: "/api/v1/resolve", price: RESOLVER_PRICE, scope: "validated native Base-USDC activity snapshot only; not a complete/general resolver" } }, free_sample: "/sample", agentcash: agentCashCommands(origin), settlement: { protocol: "x402", network: NETWORK, asset: "USDC" }, health: "/health", openapi: "/openapi.json", agent_card: "/.well-known/agent-card.json", a2a: "/a2a", x402_manifest: "/.well-known/x402", source: PUBLIC_SOURCE }); });
  app.get("/sample", (request, response) => { const origin = `${request.protocol}://${request.get("host")}`; response.json({ sample: true, live: false, note: "Representative response shapes only. Buy a paid endpoint for the current validated onchain snapshot.", examples: { trending_base_tokens: outputExample, token_lookup: resolverOutputExample }, agentcash: agentCashCommands(origin) }); });
  app.get("/health", (_request, response) => response.json({ ok: true, service: "base-token-momentum-pulse", version: SERVICE_VERSION, network: NETWORK, window_blocks: WINDOW_BLOCKS, sealed_blocks_behind_latest: SEALED_BLOCKS, rpc_primary: RPC_URLS[0], facilitator: new URL(FACILITATOR_URL).hostname }));

  app.get(["/.well-known/agent-card.json", "/.well-known/agent.json"], (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    const a2aUrl = `${origin}/a2a`;
    response.json({ protocolVersion: "0.3", name: "ArgonautWorks Base Token Momentum Pulse", description: SERVICE_DESCRIPTION, url: a2aUrl, preferredTransport: "JSONRPC", additionalInterfaces: [{ url: a2aUrl, transport: "JSONRPC" }], version: SERVICE_VERSION, provider: { organization: "ArgonautWorks", url: PUBLIC_SOURCE }, capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false }, documentationUrl: `${origin}/openapi.json`, defaultInputModes: ["text/plain", "application/json"], defaultOutputModes: ["text/plain", "application/json"], skills: [{ id: "base-token-momentum-pulse", name: "Find trending Base tokens", description: MOMENTUM_DESCRIPTION, tags: ["trending Base tokens", "Base token data", "DEX volume", "USDC volume", "buy sell activity", "x402"], examples: ["Find trending Base tokens by USDC volume", "Base token buy and sell activity", "current Base DEX momentum"] }, { id: "base-validated-token-resolver", name: "Look up an active Base token", description: RESOLVER_DESCRIPTION, tags: ["Base token lookup", "token resolver", "token address", "token symbol", "active Base tokens", "x402"], examples: ["Look up cbBTC on Base", "resolve a Base token symbol", "find the address for an active Base token"] }] });
  });

  app.post("/a2a", (request, response) => {
    const body = request.body;
    const requestId = body?.id ?? null;
    if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || !["message/send", "SendMessage"].includes(body.method)) return response.status(200).json({ jsonrpc: "2.0", id: requestId, error: { code: body?.method ? -32601 : -32600, message: body?.method ? "Method not found" : "Invalid Request" } });
    const origin = `${request.protocol}://${request.get("host")}`;
    const incoming = body.params?.message;
    const contextId = typeof incoming?.contextId === "string" ? incoming.contextId : randomUUID();
    const taskId = typeof incoming?.taskId === "string" ? incoming.taskId : randomUUID();
    return response.json({ jsonrpc: "2.0", id: requestId, result: { contextId, history: [], id: taskId, kind: "task", status: { state: "completed", timestamp: new Date().toISOString(), message: { kind: "message", messageId: randomUUID(), role: "agent", parts: [{ kind: "text", text: `ArgonautWorks offers paid direct-onchain Base activity APIs: GET or POST ${origin}/api/v1/momentum costs ${MOMENTUM_PRICE} USDC, and GET or POST ${origin}/api/v1/resolve costs ${RESOLVER_PRICE} USDC. Resolver results are limited to tokens with validated approved-factory native-Base-USDC swap activity in the same sealed 300-block snapshot, not a complete or general resolver. Read ${origin}/openapi.json and ${origin}/.well-known/x402 for exact inputs and payment details.` }] } } } });
  });

  app.get("/openapi.json", (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    const responses = { 200: { description: "Validated Base-USDC activity result", content: { "application/json": { schema: { type: "object" } } } }, 400: { description: "Invalid input; no charge" }, 402: { description: "x402 Base-USDC payment challenge" }, 502: { description: "Payment facilitator unavailable; no payment challenge issued" }, 503: { description: "Base RPC or validated inventory unavailable; no payment challenge issued" } };
    const operation = (operationId, summary, price) => ({ operationId, summary, "x-payment-info": paymentInfo(price), responses });
    response.json({ openapi: "3.1.0", info: { title: "ArgonautWorks Trending Base Tokens and Token Lookup API", version: SERVICE_VERSION, description: SERVICE_DESCRIPTION, license: { name: "MIT", identifier: "MIT" }, contact: { name: "ArgonautWorks", url: PUBLIC_SOURCE }, "x-guidance": "Use /api/v1/momentum to find trending Base tokens by exact native-USDC DEX volume, swaps, unique transactions, and buy/sell activity. Use /api/v1/resolve to look up an address, symbol, or name only within the same active-token snapshot. Preview both representative outputs at GET /sample and copy AgentCash commands from GET / or /llms.txt. Resolver scope is strictly the sealed 300-block snapshot of validated approved-factory pools paired with native Base USDC; it is not a complete/general token resolver or investment advice." }, servers: [{ url: origin }], paths: { "/sample": { get: { operationId: "getBaseTokenDataSamples", summary: "Preview both response shapes and copy-ready AgentCash calls for free", security: [], responses: { 200: { description: "Representative, non-live sample outputs and purchase commands" } } } }, "/api/v1/momentum": { get: { ...operation("getBaseTokenMomentum", "Find trending Base tokens by validated USDC volume and buy/sell activity", "0.004"), parameters: [{ name: "limit", in: "query", required: false, schema: momentumInputSchema.properties.limit }] }, post: { ...operation("getBaseTokenMomentumFromJson", "Find trending Base tokens by validated USDC volume and buy/sell activity", "0.004"), requestBody: { required: false, content: { "application/json": { schema: momentumInputSchema, example: { limit: 5 } } } } } }, "/api/v1/resolve": { get: { ...operation("resolveValidatedBaseToken", "Look up an address, symbol, or name in the active Base token snapshot", "0.002"), parameters: [{ name: "query", in: "query", required: true, schema: resolverGetInputSchema.properties.query }, { name: "limit", in: "query", required: false, schema: resolverGetInputSchema.properties.limit }] }, post: { ...operation("resolveValidatedBaseTokenFromJson", "Look up an address, symbol, or name in the active Base token snapshot", "0.002"), requestBody: { required: true, content: { "application/json": { schema: resolverPostInputSchema, example: { query: "cbBTC", limit: 5 } } } } } }, "/a2a": { post: { operationId: "sendBaseTokenMomentumDiscoveryA2aMessage", summary: "Return completed A2A purchase discovery guidance", security: [], responses: { 200: { description: "Free completed discovery task; no RPC fetch or payment initialization." } } } } } });
  });

  app.get("/.well-known/x402", (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    response.json({ x402Version: 2, serviceName: "ArgonautWorks Base Token Momentum Pulse", description: SERVICE_DESCRIPTION, source: PUBLIC_SOURCE, resources: ["GET", "POST"].flatMap((method) => [{ resource: `${origin}/api/v1/momentum`, method, price: MOMENTUM_PRICE, network: NETWORK, asset: "USDC", input: method === "POST" ? { body: { limit: 5 } } : { queryParams: { limit: 5 } } }, { resource: `${origin}/api/v1/resolve`, method, price: RESOLVER_PRICE, network: NETWORK, asset: "USDC", scope: "validated native Base-USDC activity snapshot only; not a complete/general resolver", input: method === "POST" ? { body: { query: "token", limit: 5 } } : { queryParams: { query: "token", limit: 5 } } }]) });
  });
  app.get("/llms.txt", (request, response) => { const origin = `${request.protocol}://${request.get("host")}`; const commands = agentCashCommands(origin); response.type("text/plain").send(["# ArgonautWorks Base Token Momentum Pulse", "", SERVICE_DESCRIPTION, "", "Paid endpoint: GET or POST /api/v1/momentum", "Input: optional limit integer 1..10 (default 5).", `Price: ${MOMENTUM_PRICE} USDC on Base via x402 v2`, "", "Paid endpoint: GET or POST /api/v1/resolve", "Input: required query string 1..80; optional limit integer 1..5 (default 5).", `Price: ${RESOLVER_PRICE} USDC on Base via x402 v2`, "Resolver scope: only tokens observed with validated approved-factory native Base-USDC swap activity in the same sealed 300-block window; not a complete or general resolver.", "Resolver matching: lowercase exact address, exact symbol/name, prefix, then substring; ties use exact USDC volume, unique transaction count, then address.", `Free representative samples: ${origin}/sample`, "Copy-ready AgentCash trending Base tokens call:", commands.trending_base_tokens, "Copy-ready AgentCash token lookup call:", commands.token_lookup, "Copy-ready AgentCash token lookup POST:", commands.token_lookup_post, `Window: ${WINDOW_BLOCKS} Base blocks ending ${SEALED_BLOCKS} sealed blocks behind latest.`, `Native Base USDC: ${BASE_USDC}`, "Output: exact USDC-side volume (atomic and decimal), swap/unique transaction/buy/sell counts, first/last swap blocks, onchain token metadata, approved pool/factory evidence, source state, and cache freshness.", "Limitations: sampled window only; approved USDC pools only; raw activity can include bots or wash trading; no safety, quality, or return judgment; not investment advice.", "OpenAPI: /openapi.json", "A2A agent card: /.well-known/agent-card.json (legacy alias: /.well-known/agent.json)", "A2A JSON-RPC endpoint: POST /a2a (purchase discovery only; no RPC fetch or payment initialization)", "x402 manifest: /.well-known/x402", `Source: ${PUBLIC_SOURCE}`, ""].join("\n")); });
  app.get(["/favicon.ico", "/favicon.svg"], (_request, response) => response.type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#101827"/><path d="M13 45 25 33l8 7 18-22M42 18h9v9" fill="none" stroke="#58d68d" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>'));
  const sendMomentumPulse = (request, response) => response.json(request.momentumPulse);
  app.get("/api/v1/momentum", sendMomentumPulse);
  app.post("/api/v1/momentum", sendMomentumPulse);
  app.all("/api/v1/momentum", (_request, response) => response.status(405).json({ error: "method_not_allowed", charged: false }));
  const sendResolution = (request, response) => response.json(request.resolution);
  app.get("/api/v1/resolve", sendResolution);
  app.post("/api/v1/resolve", sendResolution);
  app.all("/api/v1/resolve", (_request, response) => response.status(405).json({ error: "method_not_allowed", charged: false }));
  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  return app;
}

export default createApp();
