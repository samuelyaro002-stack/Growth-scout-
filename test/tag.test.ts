import assert from "node:assert/strict";
import { test } from "node:test";
import { codeFromRepo, fromDataSuffix } from "@celo/attribution-tags";
import { custom, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { assertValidCode, checkRepoMatchesCode, makeTaggedWalletClient, suffixFor } from "../src/tag.js";

const CODE = "celo_16de1003cce6";

test("suffix round-trips to the exact assigned code", () => {
  const s = suffixFor(CODE);
  const decoded = fromDataSuffix(("0x" + "ab".repeat(4) + s.slice(2)) as Hex);
  assert.deepEqual(decoded?.codes, [CODE]);
});

test("invalid codes are rejected before anything is sent", () => {
  assert.throws(() => assertValidCode("Celo_UPPER"));
  assert.throws(() => assertValidCode("has space"));
  assert.throws(() => assertValidCode(""));
  assert.throws(() => assertValidCode("x".repeat(33)));
  assert.doesNotThrow(() => assertValidCode(CODE));
});

test("repo check: match, mismatch and skipped", () => {
  const derived = codeFromRepo("celo-org/attribution-tags");
  assert.equal(checkRepoMatchesCode(derived, "celo-org/attribution-tags").status, "match");
  assert.equal(checkRepoMatchesCode(derived, "https://github.com/Celo-Org/Attribution-Tags").status, "match");
  const bad = checkRepoMatchesCode(CODE, "someone/else");
  assert.equal(bad.status, "mismatch");
  assert.equal(checkRepoMatchesCode(CODE, "").status, "skipped");
});

test("EVERY transaction from the tagged wallet client carries the tag (checked on the signed raw tx)", async () => {
  const sent: Hex[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return "0xa4ec"; // 42220
      if (method === "eth_sendRawTransaction") {
        sent.push((params as Hex[])[0]);
        return "0x" + "11".repeat(32);
      }
      throw new Error(`unexpected rpc call in test: ${method}`);
    },
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = makeTaggedWalletClient(account, CODE, transport);
  const common = { nonce: 0, gas: 100_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n } as const;

  // plain transfer (no data) and a raw-calldata call: both must end up tagged
  await wallet.sendTransaction({ to: account.address, value: 1n, ...common });
  await wallet.sendTransaction({ to: account.address, data: "0xdeadbeef", ...common, nonce: 1 });

  assert.equal(sent.length, 2);
  for (const raw of sent) {
    const tx = parseTransaction(raw);
    const decoded = fromDataSuffix((tx.data ?? "0x") as Hex);
    assert.deepEqual(decoded?.codes, [CODE], "signed tx must end with the attribution suffix");
  }
  // original calldata must be untouched at the front
  assert.ok(parseTransaction(sent[1]).data?.startsWith("0xdeadbeef"));
});
