import fs from "node:fs";
import path from "node:path";
import {
  BASE_USDC,
  MOMENTUM_ENDPOINT,
  TRANSFER_TOPIC,
  classifyMomentumTransfer,
  qualifyingPayanRelayReceipt,
  revenueLedgerRow,
} from "../lib/revenue-monitor.mjs";

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const PAYAN_STATE_FILE = process.env.PAYANAGENT_STATE_FILE ?? "/home/oak/.local/state/venture-lab/payanagent.json";
const STATE_FILE = process.env.BASE_TOKEN_MOMENTUM_REVENUE_STATE ?? "/home/oak/.local/state/venture-lab/base-token-momentum-revenue.json";
const LEDGER_FILE = process.env.BASE_TOKEN_MOMENTUM_LEDGER ?? path.resolve("revenue-ledger.csv");
const RECEIVING_WALLET = "0x5e2023b1D1366d6366E768fe432AD627bfAa5d57";
const CONFIRMATIONS = 20;
const INITIAL_LOOKBACK_BLOCKS = 2_000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function writeState(value) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
  fs.chmodSync(STATE_FILE, 0o600);
}

async function rpc(method, params) {
  const response = await fetch(BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Base RPC returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Base RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

function hexBlock(value) {
  return `0x${value.toString(16)}`;
}

function relayConfig() {
  const payan = readJson(PAYAN_STATE_FILE);
  const offerId = payan?.offers?.baseTokenMomentum?.offerId;
  const sellerId = payan?.agentId ?? payan?.agent?.id ?? process.env.PAYAN_AGENT_ID;
  return offerId && sellerId ? { offerId, sellerId } : null;
}

async function verifiedPayanRelayTransactions(config) {
  if (!config) return new Set();
  const response = await fetch(`https://payanagent.com/api/v1/agents/${encodeURIComponent(config.sellerId)}/receipts?side=seller&limit=100`, { headers: { Accept: "application/json", "user-agent": "ArgonautWorks/base-token-momentum-pulse-revenue" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PayanAgent returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.receipts)) throw new Error("PayanAgent returned an invalid receipt feed");
  return new Set(body.receipts.filter((receipt) => qualifyingPayanRelayReceipt(receipt, { ...config, endpoint: MOMENTUM_ENDPOINT })).map((receipt) => receipt.txHash.toLowerCase()));
}

async function main() {
  const prior = readJson(STATE_FILE) ?? { receipts: [] };
  const currentBlock = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  const confirmedBlock = currentBlock - CONFIRMATIONS;
  const fromBlock = Number.isInteger(prior.last_scanned_block) ? prior.last_scanned_block + 1 : Math.max(0, confirmedBlock - INITIAL_LOOKBACK_BLOCKS);
  if (fromBlock > confirmedBlock) return console.log("No newly confirmed Base blocks");
  const paddedWallet = `0x${RECEIVING_WALLET.slice(2).toLowerCase().padStart(64, "0")}`;
  const [logs, verifiedPayanTransactions] = await Promise.all([
    rpc("eth_getLogs", [{ address: BASE_USDC, fromBlock: hexBlock(fromBlock), toBlock: hexBlock(confirmedBlock), topics: [TRANSFER_TOPIC, null, paddedWallet] }]),
    verifiedPayanRelayTransactions(relayConfig()),
  ]);
  const priorTransactions = new Set((prior.receipts ?? []).map((receipt) => receipt.transaction));
  const existingLedger = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
  const receipts = [];
  for (const log of logs) {
    if (priorTransactions.has(log.transactionHash) || existingLedger.includes(log.transactionHash)) continue;
    const transaction = await rpc("eth_getTransactionByHash", [log.transactionHash]);
    const receipt = classifyMomentumTransfer(log, transaction, RECEIVING_WALLET, { verifiedPayanTransactions });
    if (!receipt) continue;
    fs.appendFileSync(LEDGER_FILE, `${revenueLedgerRow(receipt)}\n`, "utf8");
    receipts.push({ ...receipt, recorded_at: new Date().toISOString() });
  }
  const allReceipts = [...(prior.receipts ?? []), ...receipts];
  writeState({ schema_version: 1, updated_at: new Date().toISOString(), last_scanned_block: confirmedBlock, confirmations: CONFIRMATIONS, receipts: allReceipts, realized_revenue_usd: allReceipts.reduce((total, receipt) => total + Number(receipt.revenue_usd ?? 0), 0) });
  console.log(`Scanned ${logs.length} incoming USDC transfer(s) with ${verifiedPayanTransactions.size} verified PayanAgent relay receipt(s); recorded ${receipts.length} paid API call(s)`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
