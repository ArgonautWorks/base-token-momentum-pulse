import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const statePath = process.env.PAYANAGENT_STATE_FILE ?? "/home/oak/.local/state/venture-lab/payanagent.json";
const momentumEndpoint = "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum";
const resolverRelayEndpoint = "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/resolve?query=token";
const expectedWallet = "0x5e2023b1D1366d6366E768fe432AD627bfAa5d57";
const expectedAsset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const expectedNetwork = "eip155:8453";
const userAgent = "ArgonautWorks/base-token-momentum-pulse";

const stateStat = await stat(statePath);
if ((stateStat.mode & 0o077) !== 0) throw new Error("PayanAgent state must not be group- or world-readable");
const state = JSON.parse(await readFile(statePath, "utf8"));
if (!state.apiKey) throw new Error("PayanAgent state is missing apiKey");

async function persistState() {
  const temporary = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function headers() {
  return { authorization: `Bearer ${state.apiKey}`, "content-type": "application/json", "user-agent": userAgent };
}

async function syncRelayOffer({ stateKey, externalUrl, amountRaw, priceUsd, metadata, registrationHttpMethod = metadata.httpMethod }) {
  const storedOffer = state.offers?.[stateKey];
  const existingOfferId = storedOffer?.offerId;
  let offerId = existingOfferId;
  if (offerId) {
    if (storedOffer.externalUrl !== externalUrl) throw new Error(`PayanAgent ${stateKey} stored external URL does not match the pinned relay endpoint`);
    const response = await fetch(`https://payanagent.com/api/v1/offers/${encodeURIComponent(offerId)}`, { method: "PATCH", headers: headers(), body: JSON.stringify(metadata), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`PayanAgent ${stateKey} offer update failed with HTTP ${response.status}`);
  } else {
    const response = await fetch("https://payanagent.com/api/v1/offers", { method: "POST", headers: headers(), body: JSON.stringify({ ...metadata, httpMethod: registrationHttpMethod, externalUrl }), signal: AbortSignal.timeout(30_000) });
    const registration = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`PayanAgent ${stateKey} relay registration failed with HTTP ${response.status}`);
    offerId = registration.offerId;
    if (!offerId || registration.mode !== "relay") throw new Error(`PayanAgent did not create a ${stateKey} relay offer`);
    // Registration probes the external resource with this temporary method. The
    // resolver uses GET for the bodyless probe, then advertises POST because the
    // universal relay forwards buyer JSON with the buyer's request method.
    if (registrationHttpMethod !== metadata.httpMethod) {
      const update = await fetch(`https://payanagent.com/api/v1/offers/${encodeURIComponent(offerId)}`, { method: "PATCH", headers: headers(), body: JSON.stringify(metadata), signal: AbortSignal.timeout(30_000) });
      if (!update.ok) throw new Error(`PayanAgent ${stateKey} post-registration metadata update failed with HTTP ${update.status}`);
    }
  }

  const detailResponse = await fetch(`https://payanagent.com/api/v1/offers/${encodeURIComponent(offerId)}`, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(30_000) });
  if (!detailResponse.ok) throw new Error(`PayanAgent ${stateKey} offer lookup failed with HTTP ${detailResponse.status}`);
  const detail = await detailResponse.json();
  const offer = detail.offer ?? detail;
  // PayanAgent intentionally redacts relay targets from public offer reads. The
  // exact URL is pinned in owner-only state above and proven operational by the
  // live relay challenge below; public fields verify the advertised contract.
  if (offer.isActive !== true || Number(offer.priceUsd) !== priceUsd || offer.httpMethod !== metadata.httpMethod) throw new Error(`PayanAgent ${stateKey} relay offer has unexpected active, price, or method state`);

  const buyUrl = `https://payanagent.com/x402/${offerId}`;
  const probe = await fetch(buyUrl, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(30_000) });
  if (probe.status !== 402) throw new Error(`PayanAgent ${stateKey} relay probe returned HTTP ${probe.status}, expected 402`);
  const encoded = probe.headers.get("payment-required");
  if (!encoded) throw new Error(`PayanAgent ${stateKey} relay probe omitted PAYMENT-REQUIRED`);
  const accepted = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).accepts?.[0];
  if (accepted?.network !== expectedNetwork || String(accepted?.asset ?? "").toLowerCase() !== expectedAsset.toLowerCase() || String(accepted?.payTo ?? "").toLowerCase() !== expectedWallet.toLowerCase() || String(accepted?.amount) !== amountRaw) throw new Error(`PayanAgent ${stateKey} relay payment challenge drifted from the direct resource`);

  state.offers ??= {};
  state.offers[stateKey] = { offerId, buyUrl, mode: "relay", externalUrl, amountRaw, network: expectedNetwork };
  // Persist each verified offer so a later failure retries by update rather than creating a duplicate.
  await persistState();
  return { offerId, buyUrl, amountRaw };
}

const momentum = await syncRelayOffer({
  stateKey: "baseTokenMomentum",
  externalUrl: momentumEndpoint,
  amountRaw: "4000",
  priceUsd: 0.004,
  metadata: {
    title: "Base Token Momentum Pulse — validated USDC-pool swap activity",
    description: "GET relay for a direct Base-mainnet JSON-RPC snapshot of exact USDC-side swap activity across an explicit approved-factory native-Base-USDC pool allowlist. Returns a sealed 300-block window, BigInt-safe USDC volume, swap and unique transaction counts, buy/sell counts, onchain token metadata, and Base Blockscout evidence. It does not make safety, quality, return, or investment judgments.",
    category: "Data",
    tags: ["base", "usdc", "onchain", "swaps", "momentum", "multicall", "blockscout"],
    offerType: "api",
    httpMethod: "GET",
    inputSchema: JSON.stringify({ type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, additionalProperties: false }),
    outputSchema: "{limit, observed_at, window, source, methodology, limitations, tokens, cache}",
  },
});

const resolver = await syncRelayOffer({
  stateKey: "baseTokenResolver",
  externalUrl: resolverRelayEndpoint,
  amountRaw: "2000",
  priceUsd: 0.002,
  registrationHttpMethod: "GET",
  metadata: {
    title: "Base Validated Token Resolver — bounded active-pool inventory",
    description: "Buyers must POST JSON to /x402/{offerId}: {query: string 1..80 characters, limit?: integer 1..5}. The relay forwards that POST body to the resolver; the body query overrides the fixed registration query=query=token. The paid resolver searches only the current validated approved-factory native-Base-USDC inventory and is not a general token directory.",
    category: "Data",
    tags: ["base", "usdc", "onchain", "token", "resolver", "multicall", "blockscout"],
    offerType: "api",
    httpMethod: "POST",
    inputSchema: JSON.stringify({ type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 5, default: 5 } }, additionalProperties: false }),
    outputSchema: "{query, limit, observed_at, window, source, methodology, limitations, candidates, cache}",
  },
});

console.log(JSON.stringify({ synced: true, offers: { momentum: { offer_id: momentum.offerId, buy_url: momentum.buyUrl, amount_raw: momentum.amountRaw }, resolver: { offer_id: resolver.offerId, buy_url: resolver.buyUrl, amount_raw: resolver.amountRaw } }, mode: "relay", network: expectedNetwork }));
