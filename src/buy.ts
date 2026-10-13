import { execFile } from "node:child_process";
import type { Config } from "./config.js";
import { SpendCapError, type Ledger } from "./ledger.js";
import { mockResponse } from "./mock.js";
import type { Source } from "./sources.js";

export const GATEWAY = "https://gateway.usebuy.ai";

/** Catalogue prices as listed on usebuy.ai on 2026-10-09. The 402 quote is authoritative; --max-amount enforces it. */
export const ENDPOINTS: Record<Source, { path: string; priceUsd: number }> = {
  x: { path: "/v1/social/x/posts/search", priceUsd: 0.005 },
  reddit: { path: "/v1/social/reddit/posts/search", priceUsd: 0.005 },
  youtube: { path: "/v1/social/youtube/videos/search", priceUsd: 0.005 },
};

/** Headroom over the catalogue price before buy refuses to sign. */
const MAX_AMOUNT_HEADROOM = 1.5;

/** Running total for ONE customer request. capUsd is worst case and is what the per-request cap uses. */
export interface Spend {
  usd: number;
  capUsd: number;
}
export const newSpend = (): Spend => ({ usd: 0, capUsd: 0 });

export interface PaidCall {
  source: Source;
  endpoint: string;
  ok: boolean;
  body: unknown;
  usd: number;
  tx?: string;
  uncertain: boolean;
  mock: boolean;
  error?: string;
}

/**
 * Order matters: buy's own flags (--verbose, --account) go BEFORE `curl`; everything after `curl`
 * that buy does not own is forwarded to curl. --max-amount and --token are `curl` options, so they
 * sit immediately after it, ahead of the forwarded curl arguments.
 */
export function buildBuyArgs(url: string, body: unknown, maxUsd: number, token: string, account = ""): string[] {
  const args = ["--verbose"];
  if (account) args.push("--account", account);
  args.push("curl", "--max-amount", maxUsd.toFixed(6));
  const t = token.toUpperCase();
  if (t !== "USDC") args.push("--token", t);
  args.push("-X", "POST", "-H", "Content-Type: application/json", "--data", JSON.stringify(body), url);
  return args;
}

/** Pull a JSON document out of stdout, tolerating a status line or banner before it. */
export function parseBody(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      /* fall through */
    }
  }
  return trimmed;
}

const TX_RE = /0x[a-fA-F0-9]{64}/;

/** --verbose writes one JSON object per line to stderr; find the settlement tx hash in there. */
export function findSettlementTx(stderr: string): string | undefined {
  let found: string | undefined;
  for (const line of stderr.split("\n")) {
    if (!line.includes("0x")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const text = JSON.stringify(obj);
      const looksLikeSettlement = /settle|transaction|txHash|tx/i.test(text);
      const m = text.match(TX_RE);
      if (m && looksLikeSettlement) found = m[0];
    } catch {
      const m = line.match(TX_RE);
      if (m && /settle|transaction|tx/i.test(line)) found = m[0];
    }
  }
  return found;
}

/**
 * buy --verbose prints the 402 quote on stderr. Pull the amount out so the ledger records what was
 * actually quoted, not a catalogue guess. Returns undefined when it can't be read confidently.
 */
export function parseQuotedUsd(stderr: string, maxUsd: number): number | undefined {
  const ceiling = maxUsd * 1.01;
  const find = (v: unknown, depth = 0): number | undefined => {
    if (depth > 4 || v === null || typeof v !== "object") return undefined;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^(amount|price|quoted|quote)$/i.test(k) && (typeof val === "string" || typeof val === "number")) {
        let n = Number(val);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (n > ceiling && Number.isInteger(n) && n >= 1000) n = n / 1e6; // atomic units of a 6-decimal token
        if (n <= ceiling) return n;
      }
      const inner = find(val, depth + 1);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  for (const line of stderr.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const n = find(JSON.parse(line));
      if (n !== undefined) return n;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** Errors after which money may or may not have moved. Retrying could pay twice. */
export function isUncertain(text: string): boolean {
  return /settle_uncertain|provision_failed|\b500\b/i.test(text);
}

function run(bin: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      let extra = "";
      if (err) {
        const c = (err as { code?: unknown }).code;
        code = typeof c === "number" ? c : 1;
        // spawn failures (ENOENT: buy not installed) and timeouts carry a string code
        if (typeof c === "string" || (err as { killed?: boolean }).killed) extra = `\n${String(c ?? "killed")}: ${err.message}`;
      }
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") + extra });
    });
  });
}

export class BuyClient {
  constructor(
    private readonly cfg: Config,
    private readonly ledger: Ledger,
  ) {}

  /**
   * One paid search. Checks both spend caps BEFORE signing anything, never retries, and records
   * the outcome. A failure never aborts the whole report: the caller decides what to do without it.
   */
  async search(source: Source, query: string, spend: Spend): Promise<PaidCall> {
    const ep = ENDPOINTS[source];
    const url = GATEWAY + ep.path;
    const body = { query };

    if (this.cfg.mockBuy) {
      return { source, endpoint: url, ok: true, body: mockResponse(source, query), usd: 0, uncertain: false, mock: true };
    }

    // Worst case for this call: headroom over the catalogue price, limited by what this request may still spend.
    const remaining = this.cfg.maxSpendPerRequestUsd - spend.capUsd;
    if (remaining < ep.priceUsd - 1e-9) {
      throw new SpendCapError(
        `per-request spend cap $${this.cfg.maxSpendPerRequestUsd.toFixed(3)} would be exceeded (worst case so far $${spend.capUsd.toFixed(3)}, next call at least $${ep.priceUsd.toFixed(3)})`,
      );
    }
    const maxUsd = Math.min(ep.priceUsd * MAX_AMOUNT_HEADROOM, remaining);
    // Hold the worst-case amount from today's budget BEFORE signing, so concurrent requests share one budget.
    const release = this.ledger.reserve(maxUsd, this.cfg.dailySpendCapUsd);

    try {
      const { code, stdout, stderr } = await run(
        this.cfg.buyBin,
        buildBuyArgs(url, body, maxUsd, this.cfg.buyPayToken, this.cfg.buyAccount),
        120_000,
      );

      const tx = findSettlementTx(stderr);
      const parsed = parseBody(stdout);

      if (code === 0 && parsed !== null) {
        const quoted = parseQuotedUsd(stderr, maxUsd);
        const usd = quoted ?? ep.priceUsd;
        const capUsd = quoted !== undefined ? quoted : maxUsd; // unreadable quote: assume the worst for the caps
        spend.usd += usd;
        spend.capUsd += capUsd;
        this.ledger.append({
          kind: "spend", endpoint: url, usd, capUsd, estimated: quoted === undefined, tx, ok: true,
          note: quoted === undefined ? "amount = catalogue price (quote not readable)" : "amount = buy's quote",
        });
        return { source, endpoint: url, ok: true, body: parsed, usd, tx, uncertain: false, mock: false };
      }

      const detail = `${stderr}\n${stdout}`.trim().slice(0, 500);
      const uncertain = isUncertain(detail) || (code === 0 && parsed === null);
      if (uncertain) {
        spend.usd += ep.priceUsd;
        spend.capUsd += maxUsd; // may have settled: count the worst case
      }
      this.ledger.append({
        kind: "spend", endpoint: url, usd: uncertain ? ep.priceUsd : 0, capUsd: uncertain ? maxUsd : 0,
        estimated: uncertain, tx, ok: false, uncertain, note: detail.slice(0, 200),
      });
      return { source, endpoint: url, ok: false, body: null, usd: 0, tx, uncertain, mock: false, error: detail || `buy exited ${code}` };
    } finally {
      release();
    }
  }
}
