export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";
export const MOMENTUM_PRICE_ATOMIC = 4_000n;
export const MOMENTUM_ENDPOINT = "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum";

function topicAddress(topic) {
  const value = String(topic ?? "").toLowerCase();
  return value.length === 66 ? `0x${value.slice(-40)}` : null;
}

export function qualifyingPayanRelayReceipt(receipt, { offerId, sellerId, endpoint = MOMENTUM_ENDPOINT } = {}) {
  if (!offerId || !sellerId || receipt?.offerId !== offerId || receipt?.sellerId !== sellerId) return false;
  if (receipt?.buyerId === sellerId || receipt?.status !== "confirmed" || receipt?.delivered !== true) return false;
  if (receipt?.settlementType !== "direct" || receipt?.network !== "eip155:8453") return false;
  const microUsd = Number(receipt?.amountMicroUsd ?? Number(receipt?.amountCents) * 10_000);
  if (microUsd !== Number(MOMENTUM_PRICE_ATOMIC) || !/^0x[a-fA-F0-9]{64}$/.test(String(receipt?.txHash ?? ""))) return false;
  return !receipt?.externalUrl || receipt.externalUrl === endpoint;
}

export function classifyMomentumTransfer(log, transaction, receivingWallet, { verifiedPayanTransactions = new Set() } = {}) {
  const wallet = String(receivingWallet).toLowerCase();
  if (String(log?.address).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (String(log?.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const payer = topicAddress(log?.topics?.[1]);
  const recipient = topicAddress(log?.topics?.[2]);
  if (!payer || !recipient || payer === wallet || recipient !== wallet) return null;
  let amount;
  try { amount = BigInt(log.data); } catch { return null; }
  if (amount !== MOMENTUM_PRICE_ATOMIC) return null;
  if (String(transaction?.to).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (!String(transaction?.input ?? "").toLowerCase().startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)) return null;
  const transactionHash = String(log.transactionHash);
  const channel = verifiedPayanTransactions.has(transactionHash.toLowerCase()) ? "payanagent" : "direct";
  return {
    channel,
    revenue_usd: 0.004,
    transaction: transactionHash,
    payer,
    amount_usdc_atomic: amount.toString(),
    block_number: Number.parseInt(log.blockNumber, 16),
  };
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
  const note = `Settled external x402 Base Token Momentum Pulse via ${receipt.channel}; Base transaction ${receipt.transaction}; payer ${receipt.payer}`;
  return [ledgerDate(date), "E055", "api_revenue", "0.00", "0.004", "0.004", note].map(csvCell).join(",");
}
