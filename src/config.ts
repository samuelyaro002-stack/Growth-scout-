import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Prefer the project-local buy install (survives Replit redeploys); fall back to PATH. */
function defaultBuyBin(): string {
  const local = resolve("node_modules/.bin/buy");
  return existsSync(local) ? local : "buy";
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}
function num(name: string, fallback: number): number {
  const raw = str(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}
function flag(name: string): boolean {
  return ["1", "true", "yes"].includes(str(name).toLowerCase());
}

/** Read lazily so tests can set process.env before calling. */
export function loadConfig() {
  return {
    port: num("PORT", 3000),
    publicUrl: str("PUBLIC_URL", "http://localhost:3000").replace(/\/+$/, ""),
    builderCode: str("BUILDER_CODE", "celo_16de1003cce6"),
    githubRepo: str("GITHUB_REPO"),
    requireRepoMatch: flag("REQUIRE_REPO_MATCH"),
    privateKey: str("AGENT_PRIVATE_KEY"),
    agentId: str("AGENT_ID"),
    facilitatorUrl: str("FACILITATOR_URL", "https://api.x402.celo.org"),
    x402ApiKey: str("X402_API_KEY"),
    pricePulseUsd: num("PRICE_PULSE_USD", 0.02),
    priceAuditUsd: num("PRICE_AUDIT_USD", 0.1),
    usatName: str("USAT_EIP712_NAME"),
    usatVersion: str("USAT_EIP712_VERSION"),
    buyBin: str("BUY_BIN", defaultBuyBin()),
    buyAccount: str("BUY_ACCOUNT"),
    buyPayToken: str("BUY_PAY_TOKEN", "USDC"),
    maxSpendPerRequestUsd: num("MAX_SPEND_PER_REQUEST_USD", 0.08),
    dailySpendCapUsd: num("DAILY_SPEND_CAP_USD", 2),
    mockBuy: flag("MOCK_BUY"),
    devNoPaywall: flag("DEV_NO_PAYWALL"),
    dataDir: str("DATA_DIR", "data"),
  };
}
export type Config = ReturnType<typeof loadConfig>;
