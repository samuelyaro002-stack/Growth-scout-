/**
 * Registers the agent's ERC-8004 identity on Celo mainnet from AGENT_PRIVATE_KEY.
 *
 *   npm run register            # dry run: checks everything, sends nothing
 *   npm run register -- --send  # broadcasts the registration (costs a few cents of gas)
 *
 * Prereqs: the server is deployed at PUBLIC_URL (it serves /.well-known/agent.json), and the
 * wallet holds a little CELO or USDC for gas. The address that sends this tx OWNS the identity,
 * so it must be the same wallet you added to your hackathon entry.
 */
import { verifyTx } from "@celo/attribution-tags";
import { parseEventLogs, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_BALANCE_ABI, FEE_ADAPTER_USDC, IDENTITY_REGISTRY, USDC } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { checkRepoMatchesCode, makePublicClient, makeTaggedWalletClient } from "../src/tag.js";

const REGISTRY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string" }, { name: "owner", type: "address", indexed: true }] },
] as const;

const send = process.argv.includes("--send");
const cfg = loadConfig();
const fail = (m: string): never => {
  console.error(`\nSTOP: ${m}`);
  process.exit(1);
};

if (!cfg.privateKey) fail("AGENT_PRIVATE_KEY is not set (add it in Replit Secrets).");
if (/localhost|127\.0\.0\.1/.test(cfg.publicUrl)) fail("PUBLIC_URL still points at localhost. Deploy first, then set PUBLIC_URL.");

const repo = checkRepoMatchesCode(cfg.builderCode, cfg.githubRepo);
if (repo.status === "mismatch") {
  const msg = `GITHUB_REPO derives ${repo.derived} but BUILDER_CODE is ${repo.expected}.`;
  if (cfg.requireRepoMatch) fail(`${msg} (REQUIRE_REPO_MATCH=1)`);
  console.warn(`[warn] ${msg} Fine only if your code was issued independently of the repo. Confirm on your Loops entry page before using --send.`);
}
if (repo.status === "skipped") console.warn("[warn] GITHUB_REPO not set, so the tag/repo match was not verified.");

const account = privateKeyToAccount(cfg.privateKey as `0x${string}`);
const agentURI = `${cfg.publicUrl}/.well-known/agent.json`;
console.log(`Wallet (will own the identity): ${account.address}`);
console.log(`Agent URI:                      ${agentURI}`);
console.log(`Attribution tag:                ${cfg.builderCode}`);

// 1. the registration file must be reachable before we put its URL on-chain
const res = await fetch(agentURI).catch((e) => fail(`could not reach ${agentURI}: ${(e as Error).message}`));
if (!res.ok) fail(`${agentURI} returned HTTP ${res.status}. Is the server running at PUBLIC_URL?`);
const card = (await res.json()) as { type?: string; name?: string };
if (!card.type?.includes("eip-8004")) fail("registration file does not look like an ERC-8004 file");
console.log(`Registration file OK:           "${card.name}"`);

// 2. gas: CELO if we have it, otherwise pay in USDC through the fee adapter
const pub = makePublicClient();
const [celoBal, usdcBal] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address] }),
]);
console.log(`Balances:                       ${formatUnits(celoBal, 18)} CELO, ${formatUnits(usdcBal, 6)} USDC`);
const feeCurrency = celoBal >= 10n ** 16n ? undefined : usdcBal >= 50_000n ? FEE_ADAPTER_USDC : undefined;
if (celoBal < 10n ** 16n && !feeCurrency) fail("need ≥0.01 CELO or ≥0.05 USDC in the wallet for gas.");
console.log(`Gas paid in:                    ${feeCurrency ? "USDC (fee adapter)" : "CELO"}`);

// 3. simulate (catches reverts without spending anything)
const { request } = await pub.simulateContract({ account, address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "register", args: [agentURI] });
console.log("Simulation:                     OK");

if (!send) {
  console.log("\nDry run complete. Re-run with `npm run register -- --send` to broadcast.");
  process.exit(0);
}

// 4. broadcast through the tagged client, so this transaction carries the attribution tag
const wallet = makeTaggedWalletClient(account, cfg.builderCode);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hash = await (wallet as any).writeContract({ ...request, ...(feeCurrency ? { feeCurrency } : {}) });
console.log(`\nSent: ${hash}\nWaiting for confirmation...`);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`transaction reverted: https://celoscan.io/tx/${hash}`);

const [registered] = parseEventLogs({ abi: REGISTRY_ABI, eventName: "Registered", logs: receipt.logs });
const agentId = registered?.args.agentId;
console.log(`\nREGISTERED. Agent ID: ${agentId}`);
console.log(`Celoscan:  https://celoscan.io/tx/${hash}`);
console.log(`8004scan:  https://8004scan.io/`);

const tagged = await verifyTx({ client: pub, hash });
console.log(`Tag on-chain: ${tagged ? tagged.codes.join(",") : "NOT FOUND"} ${tagged?.codes.includes(cfg.builderCode) ? "(matches your code)" : "(CHECK THIS)"}`);

console.log(`\nNext: set AGENT_ID=${agentId} in Replit Secrets and restart the server.`);
console.log("The registration file then includes the `registrations` block automatically.");
