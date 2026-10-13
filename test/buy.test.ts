import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildBuyArgs, BuyClient, findSettlementTx, isUncertain, newSpend, parseBody, parseQuotedUsd } from "../src/buy.js";
import { Ledger, SpendCapError } from "../src/ledger.js";
import { fakeBuy, testConfig, tmpDir } from "./helpers.js";

test("argv: capped, JSON body as ONE argument (no shell), token flag only for non-USDC", () => {
  const a = buildBuyArgs("https://gateway.usebuy.ai/x", { query: "a; rm -rf / $(x)" }, 0.0075, "USDC");
  assert.deepEqual(a.slice(0, 4), ["--verbose", "curl", "--max-amount", "0.007500"]);
  assert.ok(a.includes(JSON.stringify({ query: "a; rm -rf / $(x)" })), "hostile text stays inside a single argv element");
  assert.ok(!a.includes("--token"));
  assert.equal(a.at(-1), "https://gateway.usebuy.ai/x");
  // buy's own flags precede `curl`; curl-command options (--max-amount/--token) follow it, before forwarded curl args
  const t = buildBuyArgs("u", {}, 0.01, "usat", "agent");
  assert.deepEqual(t.slice(0, 5), ["--verbose", "--account", "agent", "curl", "--max-amount"]);
  assert.ok(t.indexOf("--token") > t.indexOf("curl") && t.indexOf("--token") < t.indexOf("-X"));
  assert.deepEqual(t.slice(t.indexOf("--token"), t.indexOf("--token") + 2), ["--token", "USAT"]);
});

test("parseBody tolerates banners; findSettlementTx reads verbose stderr; isUncertain flags unsafe-to-retry", () => {
  assert.deepEqual(parseBody('200 OK\n{"a":1}'), { a: 1 });
  assert.deepEqual(parseBody("[1,2]"), [1, 2]);
  assert.equal(parseBody(""), null);
  const tx = "0x" + "cd".repeat(32);
  assert.equal(findSettlementTx(`{"step":"quote"}\n${JSON.stringify({ step: "settled", transaction: tx })}`), tx);
  assert.equal(findSettlementTx("nothing here"), undefined);
  assert.equal(isUncertain("500 settle_uncertain"), true);
  assert.equal(isUncertain("500 provision_failed"), true);
  assert.equal(isUncertain("402 quote exceeds --max-amount"), false);
});

test("successful paid call: parsed body, tx hash and spend recorded", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "ok") });
  const ledger = new Ledger(cfg.dataDir);
  const spend = newSpend();
  const call = await new BuyClient(cfg, ledger).search("x", "Acme", spend);
  assert.equal(call.ok, true);
  assert.equal(call.tx, "0x" + "ab".repeat(32));
  assert.equal(spend.usd, 0.005);
  assert.equal(ledger.summary().supplier.paidCalls, 1);
  assert.deepEqual(ledger.summary().supplier.settlementTxs, ["0x" + "ab".repeat(32)]);
  const argv = JSON.parse(readFileSync(join(dir, "calls.log"), "utf8").trim()) as string[];
  assert.ok(argv.includes("--max-amount"));
});

test("500 settle_uncertain is recorded as uncertain, counted against caps, and NEVER retried", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "fail500") });
  const ledger = new Ledger(cfg.dataDir);
  const spend = newSpend();
  const call = await new BuyClient(cfg, ledger).search("x", "Acme", spend);
  assert.equal(call.ok, false);
  assert.equal(call.uncertain, true);
  assert.equal(spend.usd, 0.005);
  assert.equal(spend.capUsd, 0.0075, "per-request cap uses the worst case");
  assert.equal(ledger.spentToday(), 0.0075, "assume the WORST CASE (max-amount) for the daily cap");
  const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  assert.equal(calls.length, 1, "exactly one attempt");
});

test("a refusal before settlement (4xx) costs nothing", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "fail4xx") });
  const ledger = new Ledger(cfg.dataDir);
  const call = await new BuyClient(cfg, ledger).search("x", "Acme", newSpend());
  assert.equal(call.ok, false);
  assert.equal(call.uncertain, false);
  assert.equal(ledger.spentToday(), 0);
});

test("missing buy binary degrades to a failed call instead of crashing", async () => {
  const cfg = testConfig({ BUY_BIN: "/definitely/not/buy" });
  const call = await new BuyClient(cfg, new Ledger(cfg.dataDir)).search("x", "Acme", newSpend());
  assert.equal(call.ok, false);
  assert.match(call.error ?? "", /ENOENT|not/i);
});

test("per-request cap blocks the purchase BEFORE the binary is ever run", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "ok"), MAX_SPEND_PER_REQUEST_USD: "0.004" });
  await assert.rejects(new BuyClient(cfg, new Ledger(cfg.dataDir)).search("x", "Acme", newSpend()), SpendCapError);
  assert.equal(existsSync(join(dir, "calls.log")), false, "buy must not have been invoked");
});

test("daily cap blocks purchases once reached", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "ok"), DAILY_SPEND_CAP_USD: "0.012" });
  const client = new BuyClient(cfg, new Ledger(cfg.dataDir));
  assert.equal((await client.search("x", "Acme", newSpend())).ok, true); // 0.005 spent
  await assert.rejects(client.search("reddit", "Acme", newSpend()), SpendCapError); // 0.005 recorded + 0.0075 worst case > 0.012
});

test("MOCK_BUY never spawns buy and never writes spend", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "ok"), MOCK_BUY: "1" });
  const ledger = new Ledger(cfg.dataDir);
  const call = await new BuyClient(cfg, ledger).search("x", "Acme", newSpend());
  assert.equal(call.mock, true);
  assert.equal(existsSync(join(dir, "calls.log")), false);
  assert.equal(ledger.summary().supplier.paidCalls, 0);
});

test("buy's quote is read from --verbose stderr: atomic units, nested keys and junk are handled", () => {
  assert.equal(parseQuotedUsd('{"step":"quote","amount":"0.005"}', 0.0075), 0.005);
  assert.equal(parseQuotedUsd('{"quote":{"price":0.0062}}', 0.0075), 0.0062);
  assert.equal(parseQuotedUsd('{"amount":"5000"}', 0.0075), 0.005, "6-decimal atomic units");
  assert.equal(parseQuotedUsd('{"amount":"9"}', 0.0075), undefined, "above the cap: not trusted");
  assert.equal(parseQuotedUsd("not json\n{broken", 0.0075), undefined);
  assert.equal(parseQuotedUsd("", 0.0075), undefined);
});

test("quote readable: ledger records buy's real amount, not the catalogue guess", async () => {
  const cfg = testConfig({ BUY_BIN: fakeBuy(tmpDir(), "ok") });
  const ledger = new Ledger(cfg.dataDir);
  await new BuyClient(cfg, ledger).search("x", "Acme", newSpend());
  const e = ledger.all().find((x) => x.kind === "spend")!;
  assert.equal(e.usd, 0.005);
  assert.equal(e.estimated, false);
  assert.equal(ledger.summary().supplier.amountsEstimatedFromCatalogue, 0);
});

test("quote NOT readable: amount is flagged as an estimate and the caps assume the worst case", async () => {
  const cfg = testConfig({ BUY_BIN: fakeBuy(tmpDir(), "okNoQuote") });
  const ledger = new Ledger(cfg.dataDir);
  const spend = newSpend();
  await new BuyClient(cfg, ledger).search("x", "Acme", spend);
  const e = ledger.all().find((x) => x.kind === "spend")!;
  assert.equal(e.estimated, true);
  assert.equal(e.usd, 0.005);
  assert.equal(e.capUsd, 0.0075);
  assert.equal(spend.capUsd, 0.0075);
  assert.equal(ledger.spentToday(), 0.0075);
  assert.equal(ledger.summary().supplier.amountsEstimatedFromCatalogue, 1);
});

test("CONCURRENT requests share one daily budget: only one of two simultaneous purchases is allowed", async () => {
  const dir = tmpDir();
  const cfg = testConfig({ BUY_BIN: fakeBuy(dir, "ok"), DAILY_SPEND_CAP_USD: "0.012" });
  const client = new BuyClient(cfg, new Ledger(cfg.dataDir));
  const results = await Promise.allSettled([client.search("x", "Acme", newSpend()), client.search("reddit", "Acme", newSpend())]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof SpendCapError);
  assert.equal(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").length, 1, "buy ran exactly once");
});

test("the reservation is released when a purchase ends, even if it fails", async () => {
  const cfg = testConfig({ BUY_BIN: fakeBuy(tmpDir(), "fail4xx"), DAILY_SPEND_CAP_USD: "0.009" });
  const ledger = new Ledger(cfg.dataDir);
  const client = new BuyClient(cfg, ledger);
  await client.search("x", "Acme", newSpend());
  assert.equal(ledger.inFlightUsd, 0);
  await client.search("x", "Acme", newSpend()); // would throw if the first call had leaked its hold
});
