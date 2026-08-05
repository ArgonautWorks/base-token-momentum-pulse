export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";
export const MOMENTUM_PRICE_ATOMIC = 4_000n;
export const RESOLVER_PRICE_ATOMIC = 2_000n;
export const MOMENTUM_ENDPOINT = "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum";
export const RESOLVER_ENDPOINT = "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/resolve";

function topicAddress(topic) {
  const value = String(topic ?? "").toLowerCase();
  return value.length === 66 ? `0x${value.slice(-40)}` : null;
}

export function qualifyingPayanRelayReceipt(receipt, { offerId, sellerId, endpoint = MOMENTUM_ENDPOINT, amountAtomic = MOMENTUM_PRICE_ATOMIC } = {}) {
  if (!offerId || !sellerId || receipt?.offerId !== offerId || receipt?.sellerId !== sellerId) return false;
  if (typeof receipt?.buyerId !== "string" || !receipt.buyerId || receipt.buyerId === sellerId || receipt?.status !== "confirmed" || receipt?.delivered !== true) return false;
  if (receipt?.settlementType !== "direct" || receipt?.network !== "eip155:8453") return false;
  const microUsd = Number(receipt?.amountMicroUsd ?? Number(receipt?.amountCents) * 10_000);
  if (microUsd !== Number(amountAtomic) || !/^0x[a-fA-F0-9]{64}$/.test(String(receipt?.txHash ?? ""))) return false;
  return receipt?.externalUrl === endpoint;
}

export function classifyApiTransfer(log, transaction, receivingWallet, { amountAtomic, product, eventCode, endpoint, verifiedPayanTransactions = new Set() } = {}) {
  const wallet = String(receivingWallet).toLowerCase();
  if (String(log?.address).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (String(log?.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const payer = topicAddress(log?.topics?.[1]);
  const recipient = topicAddress(log?.topics?.[2]);
  if (!payer || !recipient || payer === wallet || recipient !== wallet) return null;
  let amount;
  try { amount = BigInt(log.data); } catch { return null; }
  if (amount !== amountAtomic) return null;
  if (String(transaction?.to).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (!String(transaction?.input ?? "").toLowerCase().startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)) return null;
  const transactionHash = String(log.transactionHash);
  const channel = verifiedPayanTransactions.has(transactionHash.toLowerCase()) ? "payanagent" : "direct";
  return {
    channel,
    product,
    event_code: eventCode,
    endpoint,
    revenue_usd: Number(amount) / 1_000_000,
    transaction: transactionHash,
    payer,
    amount_usdc_atomic: amount.toString(),
    block_number: Number.parseInt(log.blockNumber, 16),
  };
}

export function classifyMomentumTransfer(log, transaction, receivingWallet, options = {}) {
  return classifyApiTransfer(log, transaction, receivingWallet, { ...options, amountAtomic: MOMENTUM_PRICE_ATOMIC, product: "momentum", eventCode: "E055", endpoint: MOMENTUM_ENDPOINT });
}

export function classifyResolverTransfer(log, transaction, receivingWallet, options = {}) {
  return classifyApiTransfer(log, transaction, receivingWallet, { ...options, amountAtomic: RESOLVER_PRICE_ATOMIC, product: "resolver", eventCode: "E056", endpoint: RESOLVER_ENDPOINT });
}

export function ledgerDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function revenueLedgerRow(receipt, date = new Date()) {
  const label = receipt.product === "resolver" ? "Base Validated Token Resolver" : "Base Token Momentum Pulse";
  const amount = String(receipt.revenue_usd);
  const note = `Settled external x402 ${label} via ${receipt.channel}; Base transaction ${receipt.transaction}; payer ${receipt.payer}`;
  return [ledgerDate(date), receipt.event_code ?? "E055", "api_revenue", "0.00", amount, amount, note].map(csvCell).join(",");
}
