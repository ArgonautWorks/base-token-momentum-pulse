import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const statePath = process.env.PAYANAGENT_STATE_FILE ?? "/home/oak/.local/state/venture-lab/payanagent.json";
const endpoint = process.env.BASE_TOKEN_MOMENTUM_ENDPOINT ?? "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum";
const expectedWallet = "0x5e2023b1D1366d6366E768fe432AD627bfAa5d57";
const expectedAsset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const expectedNetwork = "eip155:8453";
const expectedAmount = "4000";

const stateStat = await stat(statePath);
if ((stateStat.mode & 0o077) !== 0) throw new Error("PayanAgent state must not be group- or world-readable");
const state = JSON.parse(await readFile(statePath, "utf8"));
if (!state.apiKey) throw new Error("PayanAgent state is missing apiKey");

async function persistState() {
  const temporary = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

const metadata = {
  title: "Base Token Momentum Pulse — validated USDC-pool swap activity",
  description: "A direct Base-mainnet JSON-RPC snapshot of exact USDC-side swap activity across an explicit approved-factory, native-Base-USDC pool allowlist. Returns a sealed 300-block window, BigInt-safe USDC volume, swap and unique transaction counts, buy/sell counts, onchain token metadata, and Base Blockscout evidence. It does not make safety, quality, return, or investment judgments.",
  category: "Data",
  tags: ["base", "usdc", "onchain", "swaps", "momentum", "multicall", "blockscout"],
  offerType: "api",
  httpMethod: "GET",
  inputSchema: JSON.stringify({ type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, additionalProperties: false }),
  outputSchema: "{limit, observed_at, window, source, methodology, limitations, tokens, cache}",
};

const existingOfferId = state.offers?.baseTokenMomentum?.offerId;
let offerId = existingOfferId;
if (offerId) {
  const response = await fetch(`https://payanagent.com/api/v1/offers/${offerId}`, { method: "PATCH", headers: { authorization: `Bearer ${state.apiKey}`, "content-type": "application/json", "user-agent": "ArgonautWorks/base-token-momentum-pulse" }, body: JSON.stringify(metadata), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PayanAgent offer update failed with HTTP ${response.status}`);
} else {
  const response = await fetch("https://payanagent.com/api/v1/offers", { method: "POST", headers: { authorization: `Bearer ${state.apiKey}`, "content-type": "application/json", "user-agent": "ArgonautWorks/base-token-momentum-pulse" }, body: JSON.stringify({ ...metadata, externalUrl: endpoint }), signal: AbortSignal.timeout(30_000) });
  const registration = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PayanAgent relay registration failed with HTTP ${response.status}`);
  offerId = registration.offerId;
  if (!offerId || registration.mode !== "relay") throw new Error("PayanAgent did not create a relay offer");
}

const detailResponse = await fetch(`https://payanagent.com/api/v1/offers/${offerId}`, { headers: { "user-agent": "ArgonautWorks/base-token-momentum-pulse" }, signal: AbortSignal.timeout(30_000) });
if (!detailResponse.ok) throw new Error(`PayanAgent offer lookup failed with HTTP ${detailResponse.status}`);
const detail = await detailResponse.json();
const offer = detail.offer ?? detail;
if (offer.isActive !== true || offer.priceUsd !== 0.004 || (offer.externalUrl && offer.externalUrl !== endpoint)) throw new Error("PayanAgent relay offer has unexpected active, price, or endpoint state");

const buyUrl = `https://payanagent.com/x402/${offerId}`;
const probe = await fetch(buyUrl, { headers: { "user-agent": "ArgonautWorks/base-token-momentum-pulse" }, signal: AbortSignal.timeout(30_000) });
if (probe.status !== 402) throw new Error(`PayanAgent relay probe returned HTTP ${probe.status}, expected 402`);
const encoded = probe.headers.get("payment-required");
if (!encoded) throw new Error("PayanAgent relay probe omitted PAYMENT-REQUIRED");
const accepted = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).accepts?.[0];
if (accepted?.network !== expectedNetwork || String(accepted?.asset ?? "").toLowerCase() !== expectedAsset.toLowerCase() || String(accepted?.payTo ?? "").toLowerCase() !== expectedWallet.toLowerCase() || String(accepted?.amount) !== expectedAmount) throw new Error("PayanAgent relay payment challenge drifted from the direct resource");

state.offers ??= {};
state.offers.baseTokenMomentum = { offerId, buyUrl, mode: "relay", externalUrl: endpoint, amountRaw: expectedAmount, network: expectedNetwork };
await persistState();
console.log(JSON.stringify({ synced: true, offer_id: offerId, buy_url: buyUrl, mode: "relay", amount_raw: expectedAmount, network: expectedNetwork }));
