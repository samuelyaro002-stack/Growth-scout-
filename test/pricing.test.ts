import assert from "node:assert/strict";
import { test } from "node:test";
import { USAT, USDC } from "../src/chain.js";
import { buildAccepts, toAtomic } from "../src/pricing.js";
import { testConfig } from "./helpers.js";

test("USD to 6-decimal atomic string", () => {
  assert.equal(toAtomic(0.1), "100000");
  assert.equal(toAtomic(0.02), "20000");
  assert.equal(toAtomic(1), "1000000");
  assert.throws(() => toAtomic(0));
  assert.throws(() => toAtomic(-1));
});

test("USDC always offered; USA₮ only once its EIP-712 domain is configured", () => {
  const payTo = "0x000000000000000000000000000000000000dEaD";
  const base = buildAccepts(testConfig(), 0.1, payTo);
  assert.equal(base.length, 1);
  assert.equal(base[0].price.asset, USDC);
  assert.equal(base[0].price.amount, "100000");
  assert.equal(base[0].network, "eip155:42220");

  const both = buildAccepts(testConfig({ USAT_EIP712_NAME: "USA₮", USAT_EIP712_VERSION: "1" }), 0.1, payTo);
  assert.equal(both.length, 2);
  assert.equal(both[1].price.asset, USAT);
  assert.deepEqual(both[1].price.extra, { name: "USA₮", version: "1" });
});

test("a half-configured USA₮ domain is NOT offered (a wrong domain would fail every signature)", () => {
  const payTo = "0x000000000000000000000000000000000000dEaD";
  assert.equal(buildAccepts(testConfig({ USAT_EIP712_NAME: "x" }), 0.1, payTo).length, 1);
});
