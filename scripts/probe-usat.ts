/**
 * Reads USA₮'s EIP-712 domain from the token contract so x402 signatures verify.
 * Run once, then set USAT_EIP712_NAME / USAT_EIP712_VERSION. Until then the server only offers USDC.
 */
import { USAT } from "../src/chain.js";
import { makePublicClient } from "../src/tag.js";

const pub = makePublicClient();
const abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function", name: "eip712Domain", stateMutability: "view", inputs: [],
    outputs: [{ name: "fields", type: "bytes1" }, { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" }, { name: "extensions", type: "uint256[]" }],
  },
] as const;

const tryRead = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
  try { return await fn(); } catch { return undefined; }
};

const name = await tryRead(() => pub.readContract({ address: USAT, abi, functionName: "name" }));
const version = await tryRead(() => pub.readContract({ address: USAT, abi, functionName: "version" }));
const domain = await tryRead(() => pub.readContract({ address: USAT, abi, functionName: "eip712Domain" }));

console.log(`USA₮ contract: ${USAT}`);
console.log(`name():          ${name ?? "(not readable)"}`);
console.log(`version():       ${version ?? "(not readable, like USDT it may have none)"}`);
if (domain) console.log(`eip712Domain():  name="${domain[1]}" version="${domain[2]}"`);

const n = domain?.[1] ?? name;
const v = domain?.[2] ?? version;
if (n && v) {
  console.log(`\nSet these:\n  USAT_EIP712_NAME=${n}\n  USAT_EIP712_VERSION=${v}`);
} else {
  console.log("\nCould not determine the domain on-chain. Do NOT guess: check https://celoscan.io/token/" + USAT + " or ask in the hackathon Telegram.");
}
