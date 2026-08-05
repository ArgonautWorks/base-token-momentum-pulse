import assert from "node:assert/strict";
import test from "node:test";
import {
  MOMENTUM_PRICE_ATOMIC,
  classifyMomentumTransfer,
  qualifyingPayanRelayReceipt,
  revenueLedgerRow,
} from "../lib/revenue-monitor.mjs";

const WALLET = "0x5e2023b1D1366d6366E768fe432AD627bfAa5d57";
const PAYER = "0x1111111111111111111111111111111111111111";
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OFFER = "offer-momentum";
const AGENT = "agent-momentum";

function paidLog(amount = MOMENTUM_PRICE_ATOMIC) {
  return {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${PAYER.slice(2).padStart(64, "0")}`, `0x${WALLET.slice(2).padStart(64, "0")}`],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    transactionHash: TX,
    blockNumber: "0x2a",
  };
}

const paidTransaction = { to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", input: "0xe3ee160e00000000" };

test("counts only an exact successful four-millitoken direct payment to the receiving wallet", () => {
  const receipt = classifyMomentumTransfer(paidLog(), paidTransaction, WALLET);
  assert.deepEqual(receipt, { channel: "direct", revenue_usd: 0.004, transaction: TX, payer: PAYER, amount_usdc_atomic: "4000", block_number: 42 });
  assert.equal(classifyMomentumTransfer(paidLog(4_001n), paidTransaction, WALLET), null);
  assert.equal(classifyMomentumTransfer(paidLog(), { ...paidTransaction, input: "0xa9059cbb" }, WALLET), null);
  assert.equal(classifyMomentumTransfer({ ...paidLog(), topics: [paidLog().topics[0], paidLog().topics[1], `0x${PAYER.slice(2).padStart(64, "0")}`] }, paidTransaction, WALLET), null);
});

test("requires an exact confirmed delivered Payan relay receipt before labeling a matching transfer as relay revenue", () => {
  const relayReceipt = { offerId: OFFER, sellerId: AGENT, buyerId: "buyer", status: "confirmed", delivered: true, settlementType: "direct", network: "eip155:8453", amountMicroUsd: 4_000, txHash: TX, externalUrl: "https://argonaut-base-token-momentum-pulse.vercel.app/api/v1/momentum" };
  assert.equal(qualifyingPayanRelayReceipt(relayReceipt, { offerId: OFFER, sellerId: AGENT }), true);
  assert.equal(qualifyingPayanRelayReceipt({ ...relayReceipt, offerId: "other" }, { offerId: OFFER, sellerId: AGENT }), false);
  assert.equal(qualifyingPayanRelayReceipt({ ...relayReceipt, delivered: false }, { offerId: OFFER, sellerId: AGENT }), false);
  assert.equal(classifyMomentumTransfer(paidLog(), paidTransaction, WALLET, { verifiedPayanTransactions: new Set([TX]) }).channel, "payanagent");
});

test("formats only realized exact revenue without rounding", () => {
  const row = revenueLedgerRow(classifyMomentumTransfer(paidLog(), paidTransaction, WALLET), new Date("2026-08-04T22:30:00.000Z"));
  assert.equal(row, `2026-08-05,E055,api_revenue,0.00,0.004,0.004,Settled external x402 Base Token Momentum Pulse via direct; Base transaction ${TX}; payer ${PAYER}`);
});
