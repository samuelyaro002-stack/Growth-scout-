/**
 * Pay for ONE report from YOUR OWN wallet, signed locally (the key never leaves your computer).
 *   dry run (no payment):  node scripts/pay.mjs
 *   pay once:              PAY=1 node scripts/pay.mjs      (PowerShell: $env:PAY="1"; node scripts/pay.mjs)
 * Key comes from BUYER_KEY (64 hex, with or without 0x). Use a wallet that is NOT the agent wallet.
 */
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const raw = (process.env.BUYER_KEY ?? "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error("Set BUYER_KEY to a 64-hex private key first.");
const buyer = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
console.log("buyer wallet:", buyer.address);

const base = (process.env.TARGET ?? "https://growth-scout.onrender.com").replace(/\/+$/, "");
const url = `${base}/api/audit`;
const body = JSON.stringify({ project: process.env.PROJECT ?? "GG attention", handle: process.env.HANDLE ?? "GGAttention" });
const headers = { "Content-Type": "application/json" };

// 1) Unpaid probe: read the challenge before signing anything.
const probe = await fetch(url, { method: "POST", headers, body });
console.log("probe status:", probe.status, "(expected 402)");
const header = probe.headers.get("payment-required");
if (header) {
  const c = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  for (const a of c.accepts ?? []) console.log(`- pay ${Number(a.amount) / 1e6} on ${a.network} to ${a.payTo}`);
}
if (process.env.PAY !== "1") {
  console.log("\nDry run only: nothing was signed or paid. Re-run with PAY=1 to pay.");
  process.exit(0);
}

// 2) Real payment: ONE attempt, never retried.
const client = new x402Client().register("eip155:*", new ExactEvmScheme(buyer));
const res = await wrapFetchWithPayment(fetch, client)(url, { method: "POST", headers, body });
console.log("status:", res.status);
const settled = res.headers.get("payment-response");
if (settled) console.log("settlement:", Buffer.from(settled, "base64").toString("utf8"));
console.log(await res.text());
