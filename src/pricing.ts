import { CELO_CAIP2, USAT, USDC, USDT } from "./chain.js";
import type { Config } from "./config.js";

/** USD -> atomic units for a 6-decimal stablecoin, always as a string (x402 requires it). */
export function toAtomic(usd: number): string {
  if (!(usd > 0)) throw new Error(`price must be > 0, got ${usd}`);
  return String(Math.round(usd * 1_000_000));
}

export interface AcceptOption {
  scheme: "exact";
  network: typeof CELO_CAIP2;
  payTo: string;
  price: { amount: string; asset: string; extra: { name: string; version: string } };
}

/**
 * Payment options advertised in the 402. USDC is always offered. USA₮ is offered only once its
 * EIP-712 domain is configured (run `npm run probe:usat`): a wrong domain makes every signature
 * fail verification, so we refuse to guess it.
 */
export function buildAccepts(cfg: Config, usd: number, payTo: string): AcceptOption[] {
  const amount = toAtomic(usd);
  const opts: AcceptOption[] = [
    { scheme: "exact", network: CELO_CAIP2, payTo, price: { amount, asset: USDC, extra: { name: "USDC", version: "2" } } },
  ];
  if (cfg.usatName && cfg.usatVersion) {
    opts.push({
      scheme: "exact",
      network: CELO_CAIP2,
      payTo,
      price: { amount, asset: USAT, extra: { name: cfg.usatName, version: cfg.usatVersion } },
    });
  }
  return opts;
}

// USDT's EIP-712 domain is documented (it has no on-chain version()); exported for future use.
export const USDT_OPTION = { asset: USDT, extra: { name: "Tether USD", version: "1" } } as const;
