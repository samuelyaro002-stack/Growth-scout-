/**
 * Calibrates the response parser against the real gateway.
 *
 *   npm run probe:buy               # free: asks for a quote only (stops at the 402)
 *   npm run probe:buy -- --pay      # pays ONE ~$0.005 call and prints what came back
 *
 * Usage tip: run with --pay once after funding the wallet, then check that "normalized posts"
 * is > 0. If it is 0, paste the printed raw response to Claude and the field aliases get tuned.
 */
import { execFileSync } from "node:child_process";
import { buildBuyArgs, ENDPOINTS, GATEWAY, parseBody } from "../src/buy.js";
import { loadConfig } from "../src/config.js";
import { normalizeItems } from "../src/sources.js";

const cfg = loadConfig();
const pay = process.argv.includes("--pay");
const url = GATEWAY + ENDPOINTS.x.path;
const body = { query: "Celo" };

try {
  if (!pay) {
    const out = execFileSync(cfg.buyBin, ["quote", "-X", "POST", "-H", "Content-Type: application/json", "--data", JSON.stringify(body), url], { encoding: "utf8" });
    console.log(out);
    console.log("Quote only. Nothing was paid. Re-run with --pay to buy one call.");
  } else {
    const args = buildBuyArgs(url, body, 0.0075, cfg.buyPayToken);
    const out = execFileSync(cfg.buyBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const parsed = parseBody(out);
    console.log("RAW (first 1500 chars):\n" + JSON.stringify(parsed, null, 2).slice(0, 1500));
    const posts = normalizeItems("x", parsed);
    console.log(`\nnormalized posts: ${posts.length}`);
    console.log(JSON.stringify(posts.slice(0, 2), null, 2));
  }
} catch (e) {
  console.error("buy failed:", (e as Error).message);
  console.error("Is buy installed (`npm i -g @celo/buy@0.8.2`), a wallet set up (`buy setup`) and funded?");
  process.exit(1);
}
