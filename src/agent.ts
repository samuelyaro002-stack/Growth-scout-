import { analyze, type GrowthReport } from "./analyze.js";
import { BuyClient, newSpend, type PaidCall } from "./buy.js";
import { normalizeItems, type Post, type Source } from "./sources.js";

export type Tier = "pulse" | "audit";

export const TIER_SOURCES: Record<Tier, Source[]> = {
  pulse: ["x"],
  audit: ["x", "reddit", "youtube"],
};

export interface ReportRequest {
  project: string;
  handle?: string;
  keywords: string[];
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const NAME_RE = /^[\p{L}\p{N} .,_&'$-]{2,60}$/u;
const HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/;

export function parseRequest(body: unknown): ReportRequest {
  if (typeof body !== "object" || body === null) throw new ValidationError("JSON body required: { \"project\": \"Name\" }");
  const b = body as Record<string, unknown>;
  const project = typeof b.project === "string" ? b.project.trim() : "";
  if (!NAME_RE.test(project)) throw new ValidationError("project must be 2-60 characters (letters, numbers, spaces, . , _ & ' $ -)");
  let handle: string | undefined;
  if (b.handle !== undefined && b.handle !== "") {
    if (typeof b.handle !== "string" || !HANDLE_RE.test(b.handle.trim())) throw new ValidationError("handle must be a valid X handle, e.g. @synbo");
    handle = b.handle.trim().replace(/^@/, "");
  }
  let keywords: string[] = [];
  if (b.keywords !== undefined) {
    if (!Array.isArray(b.keywords) || b.keywords.length > 3) throw new ValidationError("keywords must be an array of at most 3 strings");
    keywords = b.keywords.map((k) => {
      if (typeof k !== "string" || !NAME_RE.test(k.trim())) throw new ValidationError("each keyword must be 2-60 characters");
      return k.trim();
    });
  }
  return { project, handle, keywords };
}

export interface ReportResult {
  /** true when this exact request was answered from the 10-minute cache: no new purchases were made */
  cached: boolean;
  report: GrowthReport;
  paidCalls: Pick<PaidCall, "source" | "endpoint" | "ok" | "usd" | "tx" | "uncertain" | "mock">[];
  warnings: string[];
}

export class ReportError extends Error {
  constructor(
    message: string,
    readonly paidCalls: ReportResult["paidCalls"] = [],
  ) {
    super(message);
    this.name = "ReportError";
  }
}

const CACHE_TTL_MS = 10 * 60 * 1000;

export class GrowthAgent {
  private cache = new Map<string, { at: number; result: ReportResult }>();

  constructor(
    private readonly buy: BuyClient,
    private readonly mock: boolean,
  ) {}

  async run(req: ReportRequest, tier: Tier): Promise<ReportResult> {
    const key = `${tier}:${req.project.toLowerCase()}:${(req.handle ?? "").toLowerCase()}:${req.keywords.join("|").toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      // Same report, but THIS request bought nothing, so it must not carry the earlier purchase evidence.
      return { ...hit.result, cached: true, paidCalls: [], warnings: [...hit.result.warnings, "served from a 10-minute cache: no new data was purchased for this request"] };
    }

    const spend = newSpend();
    const bySource: Partial<Record<Source, Post[]>> = {};
    const paidCalls: ReportResult["paidCalls"] = [];
    const warnings: string[] = [];

    // Sequential on purpose: each purchase is checked against the spend caps before it is signed.
    for (const source of TIER_SOURCES[tier]) {
      let call: PaidCall;
      try {
        call = await this.buy.search(source, req.project, spend);
      } catch (e) {
        warnings.push(`${source}: skipped (${(e as Error).message})`);
        if ((e as Error).name === "SpendCapError") break;
        continue;
      }
      paidCalls.push({ source, endpoint: call.endpoint, ok: call.ok, usd: call.usd, tx: call.tx, uncertain: call.uncertain, mock: call.mock });
      if (!call.ok) {
        warnings.push(`${source}: data purchase failed${call.uncertain ? " (payment status uncertain, not retried)" : ""}`);
        continue;
      }
      bySource[source] = normalizeItems(source, call.body);
    }

    if (Object.keys(bySource).length === 0) {
      // Nothing usable. Fail BEFORE the response so x402 does not settle the buyer's payment.
      throw new ReportError(`Could not buy any data for "${req.project}": ${warnings.join("; ") || "unknown error"}`, paidCalls);
    }

    const terms = [req.project, ...(req.handle ? [req.handle] : []), ...req.keywords];
    const report = analyze({ project: req.project, terms, tier, bySource, mock: this.mock });

    // Never sell a score built on nothing. Failing here means the x402 payment is not settled.
    if (report.evidence.postsMatched === 0) {
      const why =
        report.evidence.postsReturned === 0
          ? "the data we bought contained no posts we could read"
          : `none of the ${report.evidence.postsReturned} returned posts mention "${req.project}"`;
      throw new ReportError(`No usable evidence: ${why}. Try the exact project name, its X handle, or a keyword.`, paidCalls);
    }
    const result: ReportResult = { cached: false, report, paidCalls, warnings };
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }
}
