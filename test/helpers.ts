import { mkdtempSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";

export function tmpDir(prefix = "gs-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** An injected purchase runner standing in for the signer child process. Records every call. */
export function fakeRunner(mode: "ok" | "fail") {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]) => {
    calls.push(args);
    if (mode === "fail") return { code: 1, stdout: "", stderr: "402 quote exceeds --max-amount" };
    return {
      code: 0,
      stdout: JSON.stringify({ data: [{ id: "1", text: "Acme shipped in Lagos, great and smooth", author: { username: "amara" }, likeCount: 40, replyCount: 5, retweetCount: 9, viewCount: 3000 }, { id: "2", text: "Acme feels slow today", author: { username: "tobi" }, likeCount: 3 }] }),
      stderr: JSON.stringify({ step: "quote", amount: "5000" }) + "\n" + JSON.stringify({ step: "settled", transaction: "0x" + "ab".repeat(32) }),
    };
  };
  return { run, calls };
}

/** A live-mode config (real BuyClient path) with the paywall bypassed ONLY inside the test process. */
export function liveTestConfig(over: Partial<Config> = {}): Config {
  return { ...testConfig(), mockBuy: false, devNoPaywall: true, reportPurchasesEnabled: true, privateKey: generatePrivateKey(), dailySpendCapUsd: 0.1, ...over };
}

export function testConfig(over: Record<string, string> = {}): Config {
  const keys = ["MOCK_BUY", "DEV_NO_PAYWALL", "REPORT_PURCHASES_ENABLED", "BUY_ALLOWED_SOURCES", "BUY_HOME", "BUY_BIN", "DATA_DIR", "MAX_SPEND_PER_REQUEST_USD", "DAILY_SPEND_CAP_USD", "AGENT_PRIVATE_KEY", "AGENT_ID", "FACILITATOR_URL", "USAT_EIP712_NAME", "USAT_EIP712_VERSION", "PUBLIC_URL", "BUY_PAY_TOKEN"];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: tmpDir("gs-data-"), ...over });
  return loadConfig();
}
