import { analyze, isRelevant, matchRegion, REGION_NAMES, type Anchors, type GrowthReport, type Voice } from "./analyze.js";
import { BuyClient, newSpend, type FollowupKind, type PaidCall, type Spend } from "./buy.js";
import { engagement, keyPaths, normalizeComments, normalizeItems, parseProfile, type Post, type Profile, type Source } from "./sources.js";

export type Tier = "pulse" | "audit";

export const TIER_SOURCES: Record<Tier, Source[]> = {
  pulse: ["x"],
  audit: ["x", "reddit", "youtube"],
};

export interface ReportRequest {
  project: string;
  handle?: string;
  keywords: string[];
  /** Optional region to highlight (Africa, Europe, North America, Latin America, Asia, Middle East, Oceania). */
  focusRegion?: string;
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
  let focusRegion: string | undefined;
  if (b.focusRegion !== undefined && b.focusRegion !== "") {
    focusRegion = typeof b.focusRegion === "string" ? matchRegion(b.focusRegion) : undefined;
    if (!focusRegion) throw new ValidationError(`focusRegion must be one of: ${REGION_NAMES.join(", ")}`);
  }
  return { project, handle, keywords, ...(focusRegion ? { focusRegion } : {}) };
}

export interface ReportResult {
  /** true when this exact request was answered from the 10-minute cache: no new purchases were made */
  cached: boolean;
  report: GrowthReport;
  paidCalls: Pick<PaidCall, "kind" | "source" | "endpoint" | "ok" | "usd" | "tx" | "uncertain" | "mock">[];
  warnings: string[];
  /** Response key paths (never values) of each follow-up purchase, so parsers can be tuned from real shapes. */
  diagnostics?: { kind: string; readable: boolean; keyPaths: string[] }[];
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
    const key = `${tier}:${req.project.toLowerCase()}:${(req.handle ?? "").toLowerCase()}:${req.keywords.join("|").toLowerCase()}:${req.focusRegion ?? ""}`;
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
        // Search with the most specific thing the customer gave us (same price, better precision).
        const query = source === "x" && req.handle ? req.handle
          : source !== "x" && req.keywords[0] ? `${req.project} ${req.keywords[0]}`
          : req.project;
        call = await this.buy.search(source, query, spend);
      } catch (e) {
        warnings.push(`${source}: skipped (${(e as Error).message})`);
        if ((e as Error).name === "SpendCapError") break;
        continue;
      }
      paidCalls.push({ kind: call.kind, source, endpoint: call.endpoint, ok: call.ok, usd: call.usd, tx: call.tx, uncertain: call.uncertain, mock: call.mock });
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
    const anchors = req.handle || req.keywords.length ? { project: req.project, handle: req.handle, keywords: req.keywords } : undefined;
    const deeper = tier === "audit" ? await this.goDeeper(req, terms, anchors, bySource, spend, paidCalls, warnings) : undefined;
    const report = analyze({
      project: req.project, terms, tier, bySource, mock: this.mock, anchors, focusRegion: req.focusRegion,
      profile: deeper?.profile, voices: deeper?.voices, audience: deeper?.audience,
    });

    // Never sell a score built on nothing. Failing here means the x402 payment is not settled.
    if (report.evidence.postsMatched === 0) {
      const why =
        report.evidence.postsReturned === 0
          ? "the data we bought contained no posts we could read"
          : `none of the ${report.evidence.postsReturned} returned posts mention "${req.project}"`;
      throw new ReportError(`No usable evidence: ${why}. Try the exact project name, its X handle, or a keyword.`, paidCalls);
    }
    const result: ReportResult = { cached: false, report, paidCalls, warnings, ...(deeper?.diagnostics.length ? { diagnostics: deeper.diagnostics } : {}) };
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }

  /**
   * Audit follow-ups: buy the project's own X profile, the profiles of its loudest voices, and the replies
   * on the busiest matching post per platform. Each purchase is optional: a failure or spend cap yields a
   * warning and a thinner report, never a failed one, and nothing is retried.
   */
  private async goDeeper(
    req: ReportRequest, terms: string[], anchors: Anchors | undefined,
    bySource: Partial<Record<Source, Post[]>>, spend: Spend,
    paidCalls: ReportResult["paidCalls"], warnings: string[],
  ) {
    const diagnostics: NonNullable<ReportResult["diagnostics"]> = [];
    const relevant = (source: Source) => (bySource[source] ?? []).filter((p) => isRelevant(p, terms, anchors));
    const busiest = (posts: Post[], ok: (p: Post) => boolean) =>
      posts.filter(ok).sort((a, b) => engagement(b) - engagement(a))[0];
    let capped = false;

    const buy = async (kind: FollowupKind, value: string): Promise<unknown | undefined> => {
      if (capped) return undefined;
      let call: PaidCall;
      try {
        call = await this.buy.followup(kind, value, spend);
      } catch (e) {
        warnings.push(`${kind}: skipped (${(e as Error).message})`);
        if ((e as Error).name === "SpendCapError") capped = true;
        return undefined;
      }
      paidCalls.push({ kind: call.kind, source: call.source, endpoint: call.endpoint, ok: call.ok, usd: call.usd, tx: call.tx, uncertain: call.uncertain, mock: call.mock });
      if (!call.ok) {
        warnings.push(`${kind}: purchase failed${call.uncertain ? " (payment status uncertain, not retried)" : ""}`);
        return undefined;
      }
      return call.body;
    };
    const note = (kind: string, body: unknown, readable: boolean) =>
      diagnostics.push({ kind, readable, keyPaths: keyPaths(body) });

    let profile: Profile | undefined;
    if (req.handle) {
      const body = await buy("x_about", req.handle);
      if (body !== undefined) {
        profile = parseProfile(body);
        note("x_about", body, !!profile);
      }
    }

    // Loudest other voices on X among matching posts.
    const xPosts = relevant("x");
    const seen = new Set((req.handle ? [req.handle] : []).map((h) => h.toLowerCase()));
    const voices: Voice[] = [];
    for (const p of [...xPosts].sort((a, b) => engagement(b) - engagement(a))) {
      if (voices.length >= 2) break;
      const handle = p.author?.replace(/^@/, "");
      if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || seen.has(handle.toLowerCase())) continue;
      seen.add(handle.toLowerCase());
      const body = await buy("x_about", handle);
      if (body === undefined) continue;
      const about = parseProfile(body);
      note("x_about", body, !!about);
      voices.push({ handle, followers: about?.followers, location: about?.location });
    }

    const audience: (Post & { place?: string })[] = [];
    const comments = async (kind: FollowupKind, source: Source, id: string | undefined) => {
      if (!id) return;
      const body = await buy(kind, id);
      if (body === undefined) return;
      const items = normalizeComments(source, body);
      note(kind, body, items.length > 0);
      audience.push(...items.slice(0, 50));
    };
    const topX = busiest(xPosts, (p) => !!p.id && /^\d{1,25}$/.test(p.id) && p.replies > 0);
    await comments("x_comments", "x", topX?.id);
    const topReddit = busiest(relevant("reddit"), (p) => !!p.id && /^(t3_)?[a-z0-9]{1,17}$/i.test(p.id));
    await comments("reddit_comments", "reddit", topReddit?.id ? "t3_" + topReddit.id.replace(/^t3_/i, "").toLowerCase() : undefined);
    const videoId = (p: Post) => [p.id, p.url?.match(/[?&]v=([\w-]{11})(?:&|$)/)?.[1]].find((v) => v && /^[A-Za-z0-9_-]{11}$/.test(v));
    const topVideo = busiest(relevant("youtube"), (p) => !!videoId(p));
    await comments("youtube_comments", "youtube", topVideo ? videoId(topVideo) : undefined);

    return { profile, voices, audience, diagnostics };
  }
}
