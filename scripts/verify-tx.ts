/** Confirms a transaction carries your attribution tag:  npm run verify-tx -- 0xTXHASH */
import { verifyTx } from "@celo/attribution-tags";
import { loadConfig } from "../src/config.js";
import { makePublicClient } from "../src/tag.js";

const hash = process.argv[2] as `0x${string}` | undefined;
if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
  console.error("usage: npm run verify-tx -- 0x<64 hex chars>");
  process.exit(1);
}
const cfg = loadConfig();
const result = await verifyTx({ client: makePublicClient(), hash });
if (!result) {
  console.log("NO TAG FOUND on this transaction.");
  process.exit(1);
}
const ok = result.codes.includes(cfg.builderCode);
console.log(`codes: ${result.codes.join(", ")} (schema ${result.schemaId})`);
console.log(ok ? `OK: includes your code ${cfg.builderCode}` : `WARNING: does not include ${cfg.builderCode}`);
process.exit(ok ? 0 : 1);
