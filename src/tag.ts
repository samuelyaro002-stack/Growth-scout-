import { codeFromRepo, toDataSuffix, withAttribution } from "@celo/attribution-tags";
import { createPublicClient, createWalletClient, http, type Account, type Hex, type Transport } from "viem";
import { celo } from "./chain.js";

const CODE_RE = /^[a-z0-9_]{1,32}$/;

export function assertValidCode(code: string): void {
  if (!CODE_RE.test(code)) {
    throw new Error(`BUILDER_CODE "${code}" is invalid: use 1-32 chars of [a-z0-9_]`);
  }
}

export function suffixFor(code: string): Hex {
  assertValidCode(code);
  return toDataSuffix(code) as Hex;
}

export type RepoCheck =
  | { status: "skipped"; reason: string }
  | { status: "match"; repo: string }
  | { status: "mismatch"; repo: string; derived: string; expected: string };

/**
 * Hackathon codes are derived from the GitHub owner/repo slug. A code that does not match the
 * repo tags transactions that credit nobody, with no error anywhere. Check it before sending.
 */
export function checkRepoMatchesCode(code: string, repo: string): RepoCheck {
  if (!repo) return { status: "skipped", reason: "GITHUB_REPO not set" };
  const derived = codeFromRepo(repo);
  return derived === code
    ? { status: "match", repo }
    : { status: "mismatch", repo, derived, expected: code };
}

/**
 * Wallet client where EVERY sendTransaction/writeContract carries the attribution suffix.
 * The tag is attached here, where the client is built, so no call site can forget it.
 */
export function makeTaggedWalletClient(account: Account, code: string, transport: Transport = http()) {
  assertValidCode(code);
  return createWalletClient({ account, chain: celo, transport }).extend(withAttribution(code));
}

export function makePublicClient(rpcUrl?: string) {
  return createPublicClient({ chain: celo, transport: http(rpcUrl) });
}
