import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import express from "express";
import { loadConfig, type Config } from "../src/config.js";
import { BuyClient, buildBuyArgs, newSpend, type PurchaseRunner } from "../src/buy.js";
import { Ledger, SpendCapError } from "../src/ledger.js";
import { GrowthAgent, parseRequest } from "../src/agent.js";
import { createApp } from "../src/server.js";
import { mockResponse } from "../src/mock.js";

const tx = `0x${"ab".repeat(32)}`;
const wallet = "0x1111111111111111111111111111111111111111";
function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gs-purchases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg: Config = {
    ...loadConfig(), dataDir: dir, buyHome: join(dir, "wallet"),
    privateKey: generatePrivateKey(), reportPurchasesEnabled: true,
    mockBuy: false, devNoPaywall: false, dailySpendCapUsd: 0.1,
    ...overrides,
  };
  return { cfg, ledger: new Ledger(dir), dir };
}
const success: PurchaseRunner = async () => ({
  code: 0, stdout: JSON.stringify(mockResponse("x", "Acme")),
  stderr: JSON.stringify({ step: "quote", amount: "5000" }) + "\n" +
    JSON.stringify({ step: "settled", transaction: tx }),
});

test("all report sources share the memory-signer entrypoint and isolated secret environment", async t => {
  const { cfg, ledger, dir } = fixture(t);
  const calls: string[][] = [];
  const runner: PurchaseRunner = async (bin, args, timeout, env) => {
    assert.equal(bin, process.execPath);
    assert.equal(timeout, 120_000);
    assert.equal(args[0], cfg.buyRunner);
    assert.equal(args[1], "--report");
    assert.equal(env.AGENT_PRIVATE_KEY, cfg.privateKey);
    assert.equal(env.SESSION_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.REPORT_PURCHASES_ENABLED, "1");
    assert.ok(!args.some(s => s.includes(cfg.privateKey)));
    assert.ok(!args.includes("--account"));
    calls.push(args);
    return success(bin, args, timeout, env);
  };
  const client = new BuyClient(cfg, ledger, runner);
  const spend = newSpend();
  for (const source of ["x", "reddit", "youtube"] as const) {
    const result = await client.search(source, "Acme", spend);
    assert.equal(result.ok, true);
    assert.equal(result.tx, tx);
    assert.equal(result.mock, false);
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(a => a.at(-1)), [
    "https://gateway.usebuy.ai/v1/social/x/posts/search",
    "https://gateway.usebuy.ai/v1/social/reddit/posts/search",
    "https://gateway.usebuy.ai/v1/social/youtube/videos/search",
  ]);
  assert.ok(Math.abs(ledger.spentToday() - 0.015) < 1e-9);
  assert.equal(ledger.inFlightUsd, 0);
  assert.equal(ledger.summary().supplier.paidCalls, 3);
  assert.equal(ledger.summary().customers.confirmedPayments, 0);
  assert.ok(!readFileSync(join(dir, "ledger.jsonl"), "utf8").includes(cfg.privateKey));
});

test("caps and disabled sources reject purchases before launching a signer", async t => {
  for (const over of [
    { reportPurchasesEnabled: false },
    { dailySpendCapUsd: 0.004 },
    { maxSpendPerRequestUsd: 0.004 },
    { buyAllowedSources: ["reddit"] },
    { buyMaxCallUsd: { x: 0.004, reddit: 0.0075, youtube: 0.0075 } },
  ]) {
    const { cfg, ledger } = fixture(t, over);
    const runner: PurchaseRunner = async () => { throw new Error("Must never launch"); };
    await assert.rejects(new BuyClient(cfg, ledger, runner).search("x", "Acme", newSpend()), SpendCapError);
    assert.equal(ledger.spentToday(), 0);
  }
});

test("uncertain outcomes retain worst-case budget, do not retry, and never persist raw errors", async t => {
  const { cfg, ledger, dir } = fixture(t, { dailySpendCapUsd: 0.01 });
  let launched = 0;
  const runner: PurchaseRunner = async () => {
    launched++;
    return { code: 1, stdout: "", stderr: `500 settle_uncertain insufficient_balance ${cfg.privateKey}` };
  };
  const result = await new BuyClient(cfg, ledger, runner).search("x", "Acme", newSpend());
  assert.equal(result.uncertain, true);
  assert.equal(launched, 1);
  assert.equal(ledger.spentToday(), 0.0075);
  await assert.rejects(new BuyClient(cfg, new Ledger(dir), runner).search("reddit", "Acme", newSpend()), SpendCapError);
  assert.equal(launched, 1);
  assert.ok(!readFileSync(ledger.file, "utf8").includes(cfg.privateKey));
});

test("missing quote reserves the maximum and concurrent calls cannot overspend one request", async t => {
  const { cfg, ledger } = fixture(t, { maxSpendPerRequestUsd: 0.01 });
  let unblock!: () => void;
  const runner: PurchaseRunner = async () => {
    await new Promise<void>(resolve => { unblock = resolve; });
    return { code: 0, stdout: '{"data":[]}', stderr: JSON.stringify({ transaction: tx }) };
  };
  const client = new BuyClient(cfg, ledger, runner), spend = newSpend();
  const first = client.search("x", "Acme", spend);
  await assert.rejects(client.search("reddit", "Acme", spend), SpendCapError);
  await new Promise(resolve => setImmediate(resolve));
  unblock();
  await first;
  assert.equal(spend.capUsd, 0.0075);
  assert.equal(ledger.spentToday(), 0.0075);
});

test("durable reservations survive restarts and incomplete receipts fail closed", t => {
  const { ledger, dir } = fixture(t);
  const release = ledger.reserve(0.0075, 0.01);
  release(); // No settlement receipt: do not release an unfinished payment.
  assert.equal(new Ledger(dir).spentToday(), 0.0075);
  assert.throws(() => new Ledger(dir).reserve(0.0075, 0.01), SpendCapError);
  writeFileSync(ledger.file, '{"truncated":');
  assert.throws(() => new Ledger(dir).reserve(0.0075, 0.01));
});

test("independent signer processes share one durable daily budget", async t => {
  const { dir, ledger } = fixture(t);
  const source = new URL("../src/ledger.ts", import.meta.url).href;
  const script = `import {Ledger} from ${JSON.stringify(source)};
    try { new Ledger(process.argv[1]).reserve(.0075,.01); console.log("reserved"); }
    catch { console.log("refused"); }`;
  const workers = Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    let output = "";
    p.stdout.on("data", chunk => { output += String(chunk); });
    p.on("error", reject);
    p.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`Worker exited ${code}`)));
  }));
  const outputs = await Promise.all(workers);
  assert.equal(outputs.filter(s => s === "reserved").length, 1);
  assert.equal(ledger.spentToday(), 0.0075);
});

test("report runner accepts each configured search but refuses endpoint/argument escapes before reading a key", t => {
  const { cfg } = fixture(t);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, AGENT_PRIVATE_KEY: "",
    REPORT_PURCHASES_ENABLED: "1",
    GROWTHSCOUT_BUY_POLICY: JSON.stringify({
      sources: ["x", "reddit", "youtube"], maxCallUsd: cfg.buyMaxCallUsd, dailyCapUsd: 0.1,
    }),
  };
  const invoke = (args: string[]) => spawnSync(process.execPath, [cfg.buyRunner, "--report", ...args], { env, encoding: "utf8" });
  for (const endpoint of ["x/posts", "reddit/posts", "youtube/videos"]) {
    const result = invoke(buildBuyArgs(`https://gateway.usebuy.ai/v1/social/${endpoint}/search`, { query: "GG attention" }, .0075, "USDC"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AGENT_PRIVATE_KEY must/); // Passed policy, stopped before any network.
  }
  const valid = buildBuyArgs("https://gateway.usebuy.ai/v1/social/x/posts/search", { query: "Acme" }, .0075, "USDC");
  for (const args of [
    [...valid, "--max-amount=100"],
    [...valid, "-L"],
    [...valid.slice(0, -1), "https://example.com"],
    buildBuyArgs(valid.at(-1)!, { query: "Acme", url: "https://example.com" }, .0075, "USDC"),
    buildBuyArgs(valid.at(-1)!, { query: "Acme" }, .01, "USDC"),
    buildBuyArgs(valid.at(-1)!, { query: "Acme" }, .0075, "USDT"),
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /AGENT_PRIVATE_KEY must/);
  }
});

async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("x402 pulse and audit use the shared buyer, while unpaid/invalid/failed reports never settle", async t => {
  const facilitator = express();
  facilitator.use(express.json());
  let settlements = 0, failSupplier = false, purchases = 0;
  facilitator.get("/supported", (_req, res) => res.json({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }],
    extensions: [], signers: { "eip155:42220": [wallet] },
  }));
  facilitator.post("/verify", (_req, res) => res.json({ isValid: true, payer: wallet }));
  facilitator.post("/settle", (_req, res) => {
    settlements++;
    res.json({ success: true, transaction: tx, network: "eip155:42220", payer: wallet });
  });
  const fakeFacilitator = await listen(facilitator);
  t.after(() => fakeFacilitator.server.close());
  const { cfg, ledger } = fixture(t, { facilitatorUrl: fakeFacilitator.url });
  const runner: PurchaseRunner = async (...args) => {
    purchases++;
    if (failSupplier) return { code: 1, stdout: "", stderr: "settle_uncertain" };
    return success(...args);
  };
  const service = await listen(createApp(cfg, { ledger, buy: new BuyClient(cfg, ledger, runner) }));
  t.after(() => service.server.close());
  const post = (path: string, body: unknown, signature?: string) => fetch(service.url + path, {
    method: "POST", headers: { "content-type": "application/json", ...(signature ? { "payment-signature": signature } : {}) },
    body: JSON.stringify(body),
  });
  for (const path of ["/api/pulse", "/api/audit"]) {
    const beforeChallenge = purchases;
    const challenge = await post(path, { project: "Acme" });
    assert.equal(challenge.status, 402);
    assert.equal(purchases, beforeChallenge);
    const required = JSON.parse(Buffer.from(challenge.headers.get("payment-required")!, "base64").toString());
    const signature = Buffer.from(JSON.stringify({
      x402Version: 2, resource: required.resource, accepted: required.accepts[0],
      payload: { signature: "0x00", authorization: { from: wallet } },
    })).toString("base64");
    const response = await post(path, { project: "Acme" }, signature);
    assert.equal(response.status, 200, await response.clone().text());
    const report: any = await response.json();
    assert.equal(report.evidence.supplierPurchases.length, path === "/api/pulse" ? 1 : 3);
    assert.equal(report.evidence.supplierPurchases[0].tx, tx);
    const before = settlements;
    const invalid = await post(path, { project: "" }, signature);
    assert.equal(invalid.status, 400);
    assert.equal(settlements, before);
    failSupplier = true;
    const failed = await post(path, { project: "DifferentProject" }, signature);
    assert.equal(failed.status, 502);
    assert.equal(settlements, before);
    failSupplier = false;
  }
  assert.equal(settlements, 2);
  assert.equal(ledger.summary().customers.confirmedPayments, 2);
});

test("a repeated report uses cache without repeating supplier payment evidence", async t => {
  const { cfg, ledger } = fixture(t);
  let calls = 0;
  const runner: PurchaseRunner = async (...args) => { calls++; return success(...args); };
  const agent = new GrowthAgent(new BuyClient(cfg, ledger, runner), false);
  const request = parseRequest({ project: "Acme" });
  await agent.run(request, "pulse");
  const cached = await agent.run(request, "pulse");
  assert.equal(calls, 1);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.paidCalls, []);
});
