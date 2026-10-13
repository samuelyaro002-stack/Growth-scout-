import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BuyClient, type PaidCall } from "../src/buy.js";
import { Ledger } from "../src/ledger.js";
import { createApp } from "../src/server.js";
import { fakeBuy, testConfig, tmpDir } from "./helpers.js";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("paid route with MOCK data: valid request returns a labelled report and evidence", async () => {
  const cfg = testConfig({ MOCK_BUY: "1", DEV_NO_PAYWALL: "1", AGENT_ID: "4242", PUBLIC_URL: "https://scout.example" });
  const base = await listen(createApp(cfg));

  const res = await post(`${base}/api/audit`, { project: "Acme", handle: "@acme", keywords: ["MiniPay"] });
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.report.project, "Acme");
  assert.equal(j.report.tier, "audit");
  assert.equal(j.report.mock, true);
  assert.equal(j.report.sources.length, 3);
  assert.equal(j.evidence.builderCode, "celo_16de1003cce6");
  assert.equal(j.evidence.supplierPurchases.length, 3);

  const pulse = (await (await post(`${base}/api/pulse`, { project: "Acme" })).json()) as any;
  assert.equal(pulse.report.sources.length, 1);
});

test("input validation: bad bodies get 400 and nothing is bought", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", BUY_BIN: fakeBuy(dir, "ok") });
  const base = await listen(createApp(cfg));
  for (const bad of [{}, { project: "" }, { project: "x" }, { project: "ok name", handle: "not a handle!" }, { project: "ok name", keywords: ["a", "b", "c", "d"] }, { project: "bad;`rm -rf`" }]) {
    const res = await post(`${base}/api/pulse`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const notJson = await fetch(`${base}/api/pulse`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.ok(notJson.status >= 400 && notJson.status < 500);
});

test("when every data purchase fails the route errors (so x402 will NOT settle) and says so", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", BUY_BIN: fakeBuy(dir, "fail4xx") });
  const ledger = new Ledger(cfg.dataDir);
  const base = await listen(createApp(cfg, { ledger }));
  const res = await post(`${base}/api/pulse`, { project: "Acme" });
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as any).note, /not charged/);
  assert.equal(ledger.summary().customers.reportsGenerated, 0);
});

test("one failing source still yields a report with a warning", async () => {
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", MOCK_BUY: "1" });
  const ledger = new Ledger(cfg.dataDir);
  const real = new BuyClient(cfg, ledger);
  const flaky = {
    search: async (source: any, q: string, spend: any): Promise<PaidCall> =>
      source === "reddit"
        ? { source, endpoint: "e", ok: false, body: null, usd: 0, uncertain: false, mock: false, error: "boom" }
        : real.search(source, q, spend),
  } as unknown as BuyClient;
  const base = await listen(createApp(cfg, { ledger, buy: flaky }));
  const j = (await (await post(`${base}/api/audit`, { project: "Acme" })).json()) as any;
  assert.equal(j.report.sources.length, 2);
  assert.ok(j.warnings.some((w: string) => w.startsWith("reddit")));
});

test("free routes: landing, health, sample (labelled), receipts, ERC-8004 file", async () => {
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", MOCK_BUY: "1", AGENT_ID: "4242", PUBLIC_URL: "https://scout.example" });
  const base = await listen(createApp(cfg));
  assert.match(await (await fetch(base)).text(), /GrowthScout/);
  assert.equal(((await (await fetch(`${base}/health`)).json()) as any).ok, true);
  const sample = (await (await fetch(`${base}/api/sample`)).json()) as any;
  assert.match(sample.notice, /SAMPLE ONLY/);
  assert.equal(sample.report.mock, true);
  const card = (await (await fetch(`${base}/.well-known/agent.json`)).json()) as any;
  assert.match(card.type, /eip-8004/);
  assert.equal(card.x402Support, true);
  assert.equal(card.registrations[0].agentId, 4242);
  assert.match(card.registrations[0].agentRegistry, /^eip155:42220:0x8004A169/);
  assert.equal(card.services[0].endpoint, "https://scout.example");
  const noId = testConfig({ DEV_NO_PAYWALL: "1", MOCK_BUY: "1" });
  const base2 = await listen(createApp(noId));
  assert.equal(((await (await fetch(`${base2}/.well-known/agent.json`)).json()) as any).registrations, undefined);
});

test("REAL x402 paywall: unpaid request gets a 402 advertising USDC, our price, payTo and the builder code", async () => {
  // hermetic stand-in for api.x402.celo.org
  const fac = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/supported")) {
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }], extensions: [], signers: { "eip155:*": [] } }));
    } else res.end("{}");
  });
  servers.push(fac);
  await new Promise<void>((r) => fac.listen(0, "127.0.0.1", r));
  const facUrl = `http://127.0.0.1:${(fac.address() as AddressInfo).port}`;

  const wallet = privateKeyToAccount(generatePrivateKey());
  const cfg = testConfig({ MOCK_BUY: "1", AGENT_PRIVATE_KEY: generatePrivateKey(), FACILITATOR_URL: facUrl, PRICE_AUDIT_USD: "0.10" });
  process.env.PAY_TO = wallet.address;
  const base = await listen(createApp(cfg));
  delete process.env.PAY_TO;

  const res = await post(`${base}/api/audit`, { project: "Acme" });
  assert.equal(res.status, 402, "unpaid must be refused with 402");

  const header = res.headers.get("payment-required");
  const body = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json();
  const accepts = body.accepts ?? [];
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0].network, "eip155:42220");
  assert.equal(accepts[0].asset.toLowerCase(), "0xceba9300f2b948710d2653dd7b07f33a8b32118c");
  assert.equal(accepts[0].amount, "100000");
  assert.equal(accepts[0].payTo.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(body.extensions?.["builder-code"]?.info?.a, "celo_16de1003cce6", "declares our code for when the facilitator starts tagging");

  // and nothing was bought for an unpaid request
  assert.equal(new Ledger(cfg.dataDir).summary().customers.reportsGenerated, 0);
  // free routes stay open behind the same app
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("a project that nothing mentions is refused (502, not charged) instead of sold as a score", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", BUY_BIN: fakeBuy(dir, "ok") }); // fake data only ever mentions "Acme"
  const ledger = new Ledger(cfg.dataDir);
  const base = await listen(createApp(cfg, { ledger }));
  const res = await post(`${base}/api/pulse`, { project: "Zebra Protocol" });
  assert.equal(res.status, 502);
  const j = (await res.json()) as any;
  assert.match(j.error, /No usable evidence/);
  assert.match(j.note, /not charged/);
  assert.equal(ledger.summary().customers.reportsGenerated, 0);
});

test("few matching posts: the report says LOW CONFIDENCE and never calls unrelated posts relevant", async () => {
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", BUY_BIN: fakeBuy(tmpDir(), "ok") }); // 2 posts, both mention Acme
  const base = await listen(createApp(cfg));
  const j = (await (await post(`${base}/api/pulse`, { project: "Acme" })).json()) as any;
  assert.equal(j.report.confidence, "low");
  assert.deepEqual(j.report.evidence, { postsReturned: 2, postsMatched: 2 });
  assert.match(j.report.summary, /LOW CONFIDENCE/);
  assert.match(j.report.methodology, /does not measure where the audience actually lives/);
});

test("cache hit: the second response bought nothing and must not reuse the first one's purchase evidence", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ DEV_NO_PAYWALL: "1", BUY_BIN: fakeBuy(dir, "ok") });
  const ledger = new Ledger(cfg.dataDir);
  const base = await listen(createApp(cfg, { ledger }));
  const first = (await (await post(`${base}/api/pulse`, { project: "Acme" })).json()) as any;
  const second = (await (await post(`${base}/api/pulse`, { project: "Acme" })).json()) as any;
  assert.equal(first.evidence.cached, false);
  assert.equal(first.evidence.supplierPurchases.length, 1);
  assert.equal(second.evidence.cached, true);
  assert.deepEqual(second.evidence.supplierPurchases, []);
  assert.ok(second.warnings.some((w: string) => /cache/.test(w)));
  assert.equal(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").length, 1, "only one purchase in total");
  assert.equal(ledger.summary().supplier.paidCalls, 1);
});

test("FULL PAID FLOW: signed x402 payment -> report -> facilitator confirms -> 'settled' is recorded with the tx hash", async () => {
  const settleTx = "0x" + "ee".repeat(32);
  const seen: string[] = [];
  const fac = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/supported")) {
        res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }], extensions: [], signers: { "eip155:*": [] } }));
      } else if (req.url?.startsWith("/verify")) {
        const payer = JSON.parse(raw).paymentPayload?.payload?.authorization?.from;
        res.end(JSON.stringify({ isValid: true, payer }));
      } else if (req.url?.startsWith("/settle")) {
        const payer = JSON.parse(raw).paymentPayload?.payload?.authorization?.from;
        res.end(JSON.stringify({ success: true, transaction: settleTx, network: "eip155:42220", payer }));
      } else res.end("{}");
    });
  });
  servers.push(fac);
  await new Promise<void>((r) => fac.listen(0, "127.0.0.1", r));
  const facUrl = `http://127.0.0.1:${(fac.address() as AddressInfo).port}`;

  const seller = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const cfg = testConfig({ MOCK_BUY: "1", AGENT_PRIVATE_KEY: generatePrivateKey(), FACILITATOR_URL: facUrl, X402_API_KEY: "test-key" });
  process.env.PAY_TO = seller.address;
  const ledger = new Ledger(cfg.dataDir);
  const base = await listen(createApp(cfg, { ledger }));
  delete process.env.PAY_TO;

  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(buyer));
  const payingFetch = wrapFetchWithPayment(fetch, client);

  const res = await payingFetch(`${base}/api/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "Acme" }) });
  assert.equal(res.status, 200, await res.clone().text());
  const j = (await res.json()) as any;
  assert.equal(j.report.project, "Acme");

  assert.ok(seen.some((u) => u.startsWith("/verify")), "payment was verified");
  assert.ok(seen.some((u) => u.startsWith("/settle")), "payment was settled");
  const s = ledger.summary();
  assert.equal(s.customers.reportsGenerated, 1);
  assert.equal(s.customers.confirmedPayments, 1);
  assert.equal(s.customers.uniquePayers, 1);
  assert.deepEqual(s.customers.settlementTxs, [settleTx]);
  const settled = ledger.all().find((e) => e.kind === "settled")!;
  assert.equal(settled.usd, 0.1);
  assert.equal(settled.payer?.toLowerCase(), buyer.address.toLowerCase());
  assert.equal(settled.asset?.toLowerCase(), "0xceba9300f2b948710d2653dd7b07f33a8b32118c");
});
