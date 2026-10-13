import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";

export function tmpDir(prefix = "gs-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A stand-in for the `buy` CLI. `mode` picks the behaviour; every invocation appends its argv to calls.log. */
export function fakeBuy(dir: string, mode: "ok" | "okNoQuote" | "fail500" | "fail4xx"): string {
  const bin = join(dir, "buy");
  const log = join(dir, "calls.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "ok" || mode === "okNoQuote") {
  if (mode === "ok") console.error(JSON.stringify({ step: "quote", amount: "0.005" }));
  console.error(JSON.stringify({ step: "settled", transaction: "0x${"ab".repeat(32)}" }));
  console.log(JSON.stringify({ data: [{ id: "1", text: "Acme shipped in Lagos, great and smooth", author: { username: "amara" }, likeCount: 40, replyCount: 5, retweetCount: 9, viewCount: 3000 }, { id: "2", text: "Acme feels slow today", author: { username: "tobi" }, likeCount: 3 }] }));
  process.exit(0);
}
if (mode === "fail500") { console.error("500 settle_uncertain: payment may have settled"); process.exit(1); }
console.error("402 quote exceeds --max-amount"); process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

export function testConfig(over: Record<string, string> = {}): Config {
  const keys = ["MOCK_BUY", "DEV_NO_PAYWALL", "BUY_BIN", "DATA_DIR", "MAX_SPEND_PER_REQUEST_USD", "DAILY_SPEND_CAP_USD", "AGENT_PRIVATE_KEY", "AGENT_ID", "FACILITATOR_URL", "USAT_EIP712_NAME", "USAT_EIP712_VERSION", "PUBLIC_URL", "BUY_PAY_TOKEN"];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: tmpDir("gs-data-"), ...over });
  return loadConfig();
}
