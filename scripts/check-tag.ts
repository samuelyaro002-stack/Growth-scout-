/**
 * Verifies that your attribution tag matches your GitHub repo and that the suffix encodes correctly.
 *
 *   GITHUB_REPO=owner/repo npm run check-tag
 *   npm run check-tag -- owner/repo
 */
import { fromDataSuffix } from "@celo/attribution-tags";
import { loadConfig } from "../src/config.js";
import { checkRepoMatchesCode, suffixFor } from "../src/tag.js";

const cfg = loadConfig();
const repo = process.argv[2] ?? cfg.githubRepo;

console.log(`Tag in use:      ${cfg.builderCode}`);
const suffix = suffixFor(cfg.builderCode);
const decoded = fromDataSuffix(("0x" + "00".repeat(4) + suffix.slice(2)) as `0x${string}`);
console.log(`Suffix:          ${suffix}`);
console.log(`Round-trip:      ${decoded?.codes.join(",") === cfg.builderCode ? "OK" : "FAILED"}`);

const check = checkRepoMatchesCode(cfg.builderCode, repo);
if (check.status === "skipped") {
  console.log("\nNo repo given. Pass your enrolled repo as owner/repo to confirm the tag is credited to it.");
  process.exit(0);
}
if (check.status === "match") {
  console.log(`\nMATCH: ${check.repo} derives ${cfg.builderCode}. Transactions will be credited.`);
  process.exit(0);
}
console.error(`\nNO MATCH: ${check.repo} derives ${check.derived}, not ${check.expected}.`);
console.error("Two possible meanings:");
console.error("  1. The slug is wrong (exact owner/repo, lowercase, no .git), or the repo was renamed/forked.");
console.error("  2. Your code was issued independently of any repo, in which case it is valid as-is.");
console.error("Check the tag shown on your Loops entry page (it may change if you add a repo to the entry).");
process.exit(1);
