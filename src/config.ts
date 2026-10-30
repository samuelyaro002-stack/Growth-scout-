import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const str = (name: string, fallback = "") => process.env[name]?.trim() || fallback;
const flag = (name: string) => ["1", "true", "yes"].includes(str(name).toLowerCase());
function num(name: string, fallback: number) {
  const n = Number(str(name, String(fallback)));
  if (!Number.isFinite(n) || n < 0 || n > 1_000 || Math.round(n * 1e6) / 1e6 !== n) {
    throw new Error(`${name} must be a non-negative six-decimal amount (maximum 1000).`);
  }
  return n;
}

/** Accept a key with or without the 0x prefix (MetaMask exports it without). Returns "" when unset. */
export function normalizePrivateKey(raw: string): string {
  const k = raw.trim();
  if (!k) return "";
  const hex = k.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("AGENT_PRIVATE_KEY must be 64 hex characters (with or without 0x).");
  return `0x${hex}`;
}

/** No environment or configuration object should be logged: it contains the signing secret. */
export function loadConfig() {
  const mockBuy = flag("MOCK_BUY");
  const port = Number(str("PORT", "3000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const devNoPaywall = flag("DEV_NO_PAYWALL");
  if (devNoPaywall && (!mockBuy || process.env.NODE_ENV === "production")) {
    throw new Error("Paywall bypass is allowed only for non-production fixture tests.");
  }
  const sources = str("BUY_ALLOWED_SOURCES", "x,reddit,youtube").split(",").map((s) => s.trim());
  if (!sources.length || sources.some((s) => !["x", "reddit", "youtube"].includes(s))) {
    throw new Error("BUY_ALLOWED_SOURCES must list x, reddit and/or youtube.");
  }
  return {
    port,
    publicUrl: str("PUBLIC_URL").replace(/\/+$/, ""),
    builderCode: str("BUILDER_CODE", "celo_16de1003cce6"),
    githubRepo: str("GITHUB_REPO"),
    requireRepoMatch: flag("REQUIRE_REPO_MATCH"),
    privateKey: normalizePrivateKey(str("AGENT_PRIVATE_KEY")),
    agentId: str("AGENT_ID"),
    facilitatorUrl: str("FACILITATOR_URL", "https://api.x402.celo.org"),
    x402ApiKey: str("X402_API_KEY"),
    pricePulseUsd: num("PRICE_PULSE_USD", 0.02),
    priceAuditUsd: num("PRICE_AUDIT_USD", 0.1),
    usatName: str("USAT_EIP712_NAME"),
    usatVersion: str("USAT_EIP712_VERSION"),
    // Paid purchases always run through our own signer runner, never an arbitrary binary or shell command.
    buyBin: process.execPath,
    buyRunner: fileURLToPath(new URL("./runner.mjs", import.meta.url)),
    buyHome: resolve(str("BUY_HOME", join(homedir(), ".growthscout-buy"))),
    buyAccount: str("BUY_ACCOUNT", "agent"),
    buyPayToken: "USDC",
    buyAllowedSources: sources,
    buyMaxCallUsd: {
      x: num("BUY_MAX_X_USD", 0.0075),
      reddit: num("BUY_MAX_REDDIT_USD", 0.0075),
      youtube: num("BUY_MAX_YOUTUBE_USD", 0.0075),
    },
    // Live buying is OFF until you set REPORT_PURCHASES_ENABLED=1.
    reportPurchasesEnabled: flag("REPORT_PURCHASES_ENABLED"),
    maxSpendPerRequestUsd: num("MAX_SPEND_PER_REQUEST_USD", 0.0225),
    dailySpendCapUsd: num("DAILY_SPEND_CAP_USD", 0.05),
    mockBuy,
    devNoPaywall,
    dataDir: resolve(str("DATA_DIR", "data")),
  };
}
export type Config = ReturnType<typeof loadConfig>;
