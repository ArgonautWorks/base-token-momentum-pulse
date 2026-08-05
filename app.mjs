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
const SERVICE_VERSION = "0.2.0";
const SERVICE_DESCRIPTION = "Transparent Base mainnet activity snapshots and a tightly scoped token resolver derived from a sealed 300-block window of direct onchain native-USDC swap logs.";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());
const momentumInputSchema = { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, additionalProperties: false };
const resolverGetInputSchema = { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 5, default: 5 } }, additionalProperties: false };
const resolverPostInputSchema = { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 5, default: 5 } }, additionalProperties: false };
const outputExample = { limit: 5, window: { start_block: 40_000_000, end_block: 40_000_299 }, tokens: [{ rank: 1, token: { address: "0xexample", symbol: "TOKEN" }, usdc_volume_atomic: "1234567", usdc_volume: "1.234567" }] };
const resolverOutputExample = { query: "token", limit: 5, candidates: [{ token: { address: "0xexample", symbol: "TOKEN", name: "Example Token" }, match_method: "prefix", usdc_volume_atomic: "1234567", unique_transaction_count: 9, participating_pools: [] }] };
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
    "GET /api/v1/momentum": paidResource({ price: MOMENTUM_PRICE, description: "A transparent Base mainnet USDC-pool momentum snapshot derived from a sealed 300-block window of direct onchain swap logs.", tags: ["base", "usdc", "onchain", "swaps", "momentum", "x402"], extensions: momentumGetDiscovery }),
    "POST /api/v1/momentum": paidResource({ price: MOMENTUM_PRICE, description: "A transparent Base mainnet USDC-pool momentum snapshot derived from a sealed 300-block window of direct onchain swap logs.", tags: ["base", "usdc", "onchain", "swaps", "momentum", "x402"], extensions: momentumPostDiscovery }),
    "GET /api/v1/resolve": paidResource({ price: RESOLVER_PRICE, description: "A bounded resolver over only tokens observed with validated approved-factory native Base-USDC swap activity in the same sealed 300-block window; not a complete or general token resolver.", tags: ["base", "usdc", "onchain", "resolver", "swaps", "x402"], extensions: resolverGetDiscovery }),
    "POST /api/v1/resolve": paidResource({ price: RESOLVER_PRICE, description: "A bounded resolver over only tokens observed with validated approved-factory native Base-USDC swap activity in the same sealed 300-block window; not a complete or general token resolver.", tags: ["base", "usdc", "onchain", "resolver", "swaps", "x402"], extensions: resolverPostDiscovery }),
  }, resourceServer, undefined, undefined, false));

  app.get("/", (_request, response) => response.json({ service: "ArgonautWorks Base Token Momentum Pulse", purpose: SERVICE_DESCRIPTION, endpoints: { momentum: { methods: ["GET", "POST"], path: "/api/v1/momentum", price: MOMENTUM_PRICE }, resolve: { methods: ["GET", "POST"], path: "/api/v1/resolve", price: RESOLVER_PRICE, scope: "validated native Base-USDC activity snapshot only; not a complete/general resolver" } }, settlement: { protocol: "x402", network: NETWORK, asset: "USDC" }, health: "/health", openapi: "/openapi.json", agent_card: "/.well-known/agent-card.json", a2a: "/a2a", x402_manifest: "/.well-known/x402", source: PUBLIC_SOURCE }));
  app.get("/health", (_request, response) => response.json({ ok: true, service: "base-token-momentum-pulse", version: SERVICE_VERSION, network: NETWORK, window_blocks: WINDOW_BLOCKS, sealed_blocks_behind_latest: SEALED_BLOCKS, rpc_primary: RPC_URLS[0], facilitator: new URL(FACILITATOR_URL).hostname }));

  app.get(["/.well-known/agent-card.json", "/.well-known/agent.json"], (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    const a2aUrl = `${origin}/a2a`;
    response.json({ protocolVersion: "0.3", name: "ArgonautWorks Base Token Momentum Pulse", description: SERVICE_DESCRIPTION, url: a2aUrl, preferredTransport: "JSONRPC", additionalInterfaces: [{ url: a2aUrl, transport: "JSONRPC" }], version: SERVICE_VERSION, provider: { organization: "ArgonautWorks", url: PUBLIC_SOURCE }, capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false }, documentationUrl: `${origin}/openapi.json`, defaultInputModes: ["text/plain", "application/json"], defaultOutputModes: ["text/plain", "application/json"], skills: [{ id: "base-token-momentum-pulse", name: "Buy Base token momentum pulse", description: "Discover how to buy a direct-onchain Base USDC-pool activity snapshot through x402.", tags: ["base", "usdc", "onchain", "momentum", "x402"], examples: ["How can I buy a current Base USDC-pool momentum snapshot?"] }, { id: "base-validated-token-resolver", name: "Buy bounded Base token resolver", description: "Discover a paid resolver limited to tokens with validated approved-factory native-Base-USDC activity in one sealed window; it is not a complete or general resolver.", tags: ["base", "usdc", "onchain", "resolver", "x402"], examples: ["How can I resolve a token within the current validated Base-USDC activity snapshot?"] }] });
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
    response.json({ openapi: "3.1.0", info: { title: "ArgonautWorks Base Token Momentum Pulse API", version: SERVICE_VERSION, description: SERVICE_DESCRIPTION, license: { name: "MIT", identifier: "MIT" }, contact: { name: "ArgonautWorks", url: PUBLIC_SOURCE }, "x-guidance": "Resolver scope is strictly the same sealed 300-block snapshot of validated approved-factory pools paired with native Base USDC; it is not a complete/general token resolver. It is not investment advice." }, servers: [{ url: origin }], paths: { "/api/v1/momentum": { get: { ...operation("getBaseTokenMomentum", "Get a direct-onchain Base USDC-pool momentum snapshot", "0.004"), parameters: [{ name: "limit", in: "query", required: false, schema: momentumInputSchema.properties.limit }] }, post: { ...operation("getBaseTokenMomentumFromJson", "Get a direct-onchain Base USDC-pool momentum snapshot", "0.004"), requestBody: { required: false, content: { "application/json": { schema: momentumInputSchema, example: { limit: 5 } } } } } }, "/api/v1/resolve": { get: { ...operation("resolveValidatedBaseToken", "Resolve only tokens in the current validated Base-USDC activity snapshot", "0.002"), parameters: [{ name: "query", in: "query", required: true, schema: resolverGetInputSchema.properties.query }, { name: "limit", in: "query", required: false, schema: resolverGetInputSchema.properties.limit }] }, post: { ...operation("resolveValidatedBaseTokenFromJson", "Resolve only tokens in the current validated Base-USDC activity snapshot", "0.002"), requestBody: { required: true, content: { "application/json": { schema: resolverPostInputSchema, example: { query: "token", limit: 5 } } } } } }, "/a2a": { post: { operationId: "sendBaseTokenMomentumDiscoveryA2aMessage", summary: "Return completed A2A purchase discovery guidance", responses: { 200: { description: "Free completed discovery task; no RPC fetch or payment initialization." } } } } } });
  });

  app.get("/.well-known/x402", (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    response.json({ x402Version: 2, serviceName: "ArgonautWorks Base Token Momentum Pulse", description: SERVICE_DESCRIPTION, source: PUBLIC_SOURCE, resources: ["GET", "POST"].flatMap((method) => [{ resource: `${origin}/api/v1/momentum`, method, price: MOMENTUM_PRICE, network: NETWORK, asset: "USDC", input: method === "POST" ? { body: { limit: 5 } } : { queryParams: { limit: 5 } } }, { resource: `${origin}/api/v1/resolve`, method, price: RESOLVER_PRICE, network: NETWORK, asset: "USDC", scope: "validated native Base-USDC activity snapshot only; not a complete/general resolver", input: method === "POST" ? { body: { query: "token", limit: 5 } } : { queryParams: { query: "token", limit: 5 } } }]) });
  });
  app.get("/llms.txt", (_request, response) => response.type("text/plain").send(["# ArgonautWorks Base Token Momentum Pulse", "", SERVICE_DESCRIPTION, "", "Paid endpoint: GET or POST /api/v1/momentum", "Input: optional limit integer 1..10 (default 5).", `Price: ${MOMENTUM_PRICE} USDC on Base via x402 v2`, "", "Paid endpoint: GET or POST /api/v1/resolve", "Input: required query string 1..80; optional limit integer 1..5 (default 5).", `Price: ${RESOLVER_PRICE} USDC on Base via x402 v2`, "Resolver scope: only tokens observed with validated approved-factory native Base-USDC swap activity in the same sealed 300-block window; not a complete or general resolver.", "Resolver matching: lowercase exact address, exact symbol/name, prefix, then substring; ties use exact USDC volume, unique transaction count, then address.", `Window: ${WINDOW_BLOCKS} Base blocks ending ${SEALED_BLOCKS} sealed blocks behind latest.`, `Native Base USDC: ${BASE_USDC}`, "Output: exact USDC-side volume (atomic and decimal), swap/unique transaction/buy/sell counts, first/last swap blocks, onchain token metadata, approved pool/factory evidence, source state, and cache freshness.", "Limitations: sampled window only; approved USDC pools only; raw activity can include bots or wash trading; no safety, quality, or return judgment; not investment advice.", "OpenAPI: /openapi.json", "A2A agent card: /.well-known/agent-card.json (legacy alias: /.well-known/agent.json)", "A2A JSON-RPC endpoint: POST /a2a (purchase discovery only; no RPC fetch or payment initialization)", "x402 manifest: /.well-known/x402", `Source: ${PUBLIC_SOURCE}`, ""].join("\n")));
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
