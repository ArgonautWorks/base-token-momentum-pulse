import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.mjs";

const SAMPLE = { limit: 5, observed_at: "2026-08-05T00:00:00.000Z", window: { start_block: 1, end_block: 300 }, source: { state: "healthy" }, methodology: "direct", limitations: ["Not investment advice."], tokens: [], cache: { status: "fresh", stale: false, age_ms: 0 } };
const RESOLUTION = { query: "token", limit: 5, observed_at: "2026-08-05T00:00:00.000Z", window: { start_block: 1, end_block: 300 }, source: { state: "healthy" }, methodology: "direct", limitations: ["Not investment advice."], candidates: [], cache: { status: "fresh", stale: false, age_ms: 0 } };

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, "close"); }
}

test("publishes distinct discovery surfaces and exact paid challenges", async () => {
  await withServer(createApp({ loadMomentum: async () => SAMPLE, loadResolver: async () => RESOLUTION }), async (origin) => {
    const [root, health, openapi, manifest, card, alias, llms] = await Promise.all([
      fetch(origin).then((response) => response.json()), fetch(`${origin}/health`).then((response) => response.json()), fetch(`${origin}/openapi.json`).then((response) => response.json()), fetch(`${origin}/.well-known/x402`).then((response) => response.json()), fetch(`${origin}/.well-known/agent-card.json`).then((response) => response.json()), fetch(`${origin}/.well-known/agent.json`).then((response) => response.json()), fetch(`${origin}/llms.txt`).then((response) => response.text()),
    ]);
    assert.equal(root.endpoints.momentum.price, "$0.004");
    assert.equal(root.endpoints.resolve.price, "$0.002");
    assert.equal(health.window_blocks, 300);
    assert.equal(openapi.paths["/api/v1/momentum"].get.operationId, "getBaseTokenMomentum");
    assert.equal(openapi.paths["/api/v1/momentum"].post.operationId, "getBaseTokenMomentumFromJson");
    assert.equal(openapi.paths["/api/v1/resolve"].get.operationId, "resolveValidatedBaseToken");
    assert.equal(openapi.paths["/api/v1/resolve"].post.operationId, "resolveValidatedBaseTokenFromJson");
    assert.equal(manifest.resources.length, 4);
    assert.equal(card.url, `${origin}/a2a`);
    assert.deepEqual(alias, card);
    assert.match(llms, /raw activity can include bots or wash trading/);
    const response = await fetch(`${origin}/api/v1/momentum`);
    assert.equal(response.status, 402);
    const challenge = JSON.parse(Buffer.from(response.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts[0].amount, "4000");
    assert.equal(challenge.extensions.bazaar.info.input.method, "GET");
    assert.deepEqual(challenge.extensions.bazaar.info.input.queryParams, { limit: 5 });
    const postResponse = await fetch(`${origin}/api/v1/momentum`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 4 }) });
    assert.equal(postResponse.status, 402);
    const postChallenge = JSON.parse(Buffer.from(postResponse.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(postChallenge.accepts[0].amount, "4000");
    assert.equal(postChallenge.extensions.bazaar.info.input.method, "POST");
    assert.equal(postChallenge.extensions.bazaar.info.input.bodyType, "json");
    assert.deepEqual(postChallenge.extensions.bazaar.info.input.body, { limit: 5 });
    const resolveResponse = await fetch(`${origin}/api/v1/resolve?query=token`);
    assert.equal(resolveResponse.status, 402);
    const resolveChallenge = JSON.parse(Buffer.from(resolveResponse.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(resolveChallenge.accepts[0].amount, "2000");
    assert.equal(resolveChallenge.extensions.bazaar.info.input.method, "GET");
    assert.deepEqual(resolveChallenge.extensions.bazaar.info.input.queryParams, { query: "token", limit: 5 });
    const resolvePost = await fetch(`${origin}/api/v1/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "token", limit: 2 }) });
    assert.equal(resolvePost.status, 402);
    const resolvePostChallenge = JSON.parse(Buffer.from(resolvePost.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(resolvePostChallenge.accepts[0].amount, "2000");
    assert.equal(resolvePostChallenge.extensions.bazaar.info.input.method, "POST");
    assert.deepEqual(resolvePostChallenge.extensions.bazaar.info.input.body, { query: "token", limit: 5 });
  });
});

test("keeps invalid input and upstream failure uncharged before payment", async () => {
  let loads = 0;
  await withServer(createApp({ loadMomentum: async () => { loads += 1; return SAMPLE; }, initializeFacilitator: async () => {} }), async (origin) => {
    const response = await fetch(`${origin}/api/v1/momentum?limit=11`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(loads, 0);
  });
  await withServer(createApp({ loadMomentum: async () => { throw new Error("offline"); }, initializeFacilitator: async () => {} }), async (origin) => {
    const response = await fetch(`${origin}/api/v1/momentum`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("payment-required"), null);
    assert.deepEqual(await response.json(), { error: "base_rpc_or_validated_inventory_unavailable", charged: false });
  });
});

test("keeps invalid resolver requests and resolver RPC failure uncharged", async () => {
  let resolves = 0;
  await withServer(createApp({ loadMomentum: async () => SAMPLE, loadResolver: async () => { resolves += 1; return RESOLUTION; }, initializeFacilitator: async () => {} }), async (origin) => {
    const response = await fetch(`${origin}/api/v1/resolve?query=&limit=6`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(resolves, 0);
    const unsupported = await fetch(`${origin}/api/v1/resolve?query=token&extra=no`);
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.headers.get("payment-required"), null);
  });
  await withServer(createApp({ loadMomentum: async () => SAMPLE, loadResolver: async () => { throw new Error("offline"); }, initializeFacilitator: async () => {} }), async (origin) => {
    const response = await fetch(`${origin}/api/v1/resolve?query=token`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("payment-required"), null);
  });
});

test("rejects unsupported paid-route methods without RPC, facilitator, or payment", async () => {
  let loads = 0;
  let initializations = 0;
  await withServer(createApp({ loadMomentum: async () => { loads += 1; return SAMPLE; }, loadResolver: async () => { loads += 1; return RESOLUTION; }, initializeFacilitator: async () => { initializations += 1; } }), async (origin) => {
    const response = await fetch(`${origin}/api/v1/momentum`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 5 }) });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("payment-required"), null);
    assert.deepEqual(await response.json(), { error: "method_not_allowed", charged: false });
    assert.equal(loads, 0);
    assert.equal(initializations, 0);
    const resolver = await fetch(`${origin}/api/v1/resolve`, { method: "DELETE" });
    assert.equal(resolver.status, 405);
    assert.equal(resolver.headers.get("payment-required"), null);
    assert.equal(loads, 0);
  });
});

test("returns completed safe A2A purchase discovery without RPC, facilitator, or input reflection", async () => {
  let loads = 0;
  let initializations = 0;
  await withServer(createApp({ loadMomentum: async () => { loads += 1; return SAMPLE; }, initializeFacilitator: async () => { initializations += 1; } }), async (origin) => {
    const response = await fetch(`${origin}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "request", method: "message/send", params: { message: { contextId: "context", taskId: "task", parts: [{ kind: "text", text: "do not copy secret request" }] } } }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(body.result.status.state, "completed");
    assert.equal(body.result.contextId, "context");
    assert.equal(body.result.id, "task");
    assert.equal(body.result.history.length, 0);
    assert.doesNotMatch(JSON.stringify(body), /do not copy secret request/);
    assert.equal(loads, 0);
    assert.equal(initializations, 0);
    const legacy = await fetch(`${origin}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "SendMessage" }) }).then((item) => item.json());
    assert.equal(legacy.result.status.state, "completed");
  });
});
