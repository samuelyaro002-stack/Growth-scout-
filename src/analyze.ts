import { canonicalPostUrl, engagement, type Post, type Source } from "./sources.js";

/** Deterministic analysis: no LLM, so the same paid data always yields the same report. */

const AFRICA_TERMS = [
  "africa", "african", "africans", "naija", "nigeria", "nigerian", "nigerians", "lagos", "abuja", "kaduna", "kano", "ibadan",
  "kenya", "kenyan", "nairobi", "ghana", "ghanaian", "accra", "south africa", "johannesburg", "cape town", "egypt", "cairo",
  "ethiopia", "uganda", "kampala", "tanzania", "rwanda", "kigali", "senegal", "morocco", "naira", "cngn", "ngn", "cedi",
  "m-pesa", "mpesa", "ussd",
];
const AFRICA_RE = new RegExp(`(?<![a-z0-9])(?:${AFRICA_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9])`, "i");

const POSITIVE = ["great", "love", "amazing", "bullish", "awesome", "good", "excellent", "best", "fast", "smooth", "gem", "promising", "solid", "impressive", "growth", "happy", "easy", "useful", "improved", "recommend"];
const NEGATIVE = ["scam", "rug", "rugged", "fraud", "fake", "bad", "terrible", "worst", "slow", "broken", "bug", "bugs", "hack", "hacked", "exploit", "dead", "bearish", "shill", "spam", "stuck", "delay", "delayed", "fud", "suspicious", "lost"];
const RISK = new Set(["scam", "rug", "rugged", "fraud", "fake", "hack", "hacked", "exploit"]);

const STOP = new Set(
  "this that with have from your about they there their what when will would could should just like been were more than into over also very much some only your https http with the and for are but not you all can its our out get got how why who new one two now".split(" "),
);

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];

export interface Recommendation {
  priority: "high" | "medium" | "low";
  title: string;
  why: string;
  action: string;
  evidenceStatus: "limited" | "recent_sample" | "well_supported";
}
type RecommendationDraft = Omit<Recommendation, "evidenceStatus"> & { requiresStrongEvidence?: boolean };

export interface SourceStats {
  source: Source;
  fetched: boolean;
  posts: number;
  relevant: number;
  engagement: number;
  views: number;
  recentRelevant: number;
  /** Provider results excluded because they repeated the same underlying post. */
  duplicates: number;
}

export interface GrowthReport {
  project: string;
  tier: "pulse" | "audit";
  generatedAt: string;
  mock: boolean;
  score: number;
  band: string;
  /** "low" when fewer than 3 relevant posts have verifiable dates within the last 30 days */
  confidence: "ok" | "low";
  evidence: {
    postsReturned: number;
    postsUnique: number;
    postsMatched: number;
    duplicatesExcluded: number;
    duplicateSameSource: number;
    duplicateCrossSource: number;
    recentPosts: number;
    staleMatchedPosts: number;
    undatedMatchedPosts: number;
    futureDatedMatchedPosts: number;
    recencyWindowDays: number;
  };
  summary: string;
  sources: SourceStats[];
  metrics: {
    relevantPosts: number;
    totalEngagement: number;
    avgEngagementPerPost: number;
    uniqueAuthors: number;
    topAuthorShare: number;
  };
  sentiment: { positive: number; negative: number; net: number; riskFlags: number };
  africa: { posts: number; share: number; topAuthors: string[] };
  topTerms: string[];
  topPosts: { source: Source; text: string; author?: string; url?: string; engagement: number }[];
  recommendations: Recommendation[];
  scoreBreakdown: Record<string, number>;
  methodology: string;
}

export interface AnalyzeInput {
  project: string;
  /** names/handles used to decide whether a post is actually about the project */
  terms: string[];
  tier: "pulse" | "audit";
  /** sources we tried to fetch, with whatever came back (empty array = fetched but nothing found) */
  bySource: Partial<Record<Source, Post[]>>;
  mock: boolean;
  now?: Date;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, d = 2) => Number(n.toFixed(d));

function isRelevant(p: Post, terms: string[]): boolean {
  const t = p.text.toLowerCase();
  return terms.some((term) => term && t.includes(term.toLowerCase()));
}

export function band(score: number): string {
  if (score >= 75) return "Strong momentum";
  if (score >= 55) return "Healthy, with clear gaps";
  if (score >= 35) return "Early traction, under-leveraged";
  return "Low visibility";
}

export function analyze(input: AnalyzeInput): GrowthReport {
  const queried = (Object.keys(input.bySource) as Source[]).filter((s) => input.bySource[s] !== undefined);
  const all = queried.flatMap((s) => input.bySource[s] ?? []);
  const identities = new Map<string, Post>();
  const unique: Post[] = [];
  const duplicateCounts: Record<Source, number> = { x: 0, reddit: 0, youtube: 0 };
  let duplicateSameSource = 0;
  let duplicateCrossSource = 0;
  for (const post of all) {
    // Provider IDs are only comparable within their own namespace. IDs alone must
    // never collapse two legitimate posts from different platforms.
    const canonicalUrl = canonicalPostUrl(post.source, post.url);
    const keys = [
      ...(post.id?.trim() ? [`id:${post.source}:${post.id.trim()}`] : []),
      ...(canonicalUrl ? [`url:${canonicalUrl}`] : []),
    ];
    const existing = keys.map(key => identities.get(key)).find(Boolean);
    if (existing) {
      duplicateCounts[post.source]++;
      if (existing.source === post.source) {
        duplicateSameSource++;
        // Same-source aliases can add another provider ID for this canonical post.
        for (const key of keys) if (key.startsWith("id:")) identities.set(key, existing);
      }
      else duplicateCrossSource++;
      continue;
    }
    unique.push(post);
    for (const key of keys) identities.set(key, post);
  }
  // Only distinct posts that mention the project are evidence. No fallback to unrelated results.
  const pool = unique.filter((p) => isRelevant(p, input.terms));
  const now = input.now ?? new Date();
  const recencyWindowDays = 30;
  const cutoff = now.getTime() - recencyWindowDays * 24 * 60 * 60 * 1000;
  const isRecent = (p: Post) => {
    if (!p.publishedAt) return false;
    const time = Date.parse(p.publishedAt);
    return Number.isFinite(time) && time >= cutoff && time <= now.getTime();
  };
  const recentPool = pool.filter(isRecent);
  const staleMatchedPosts = pool.filter(p => p.publishedAt && Date.parse(p.publishedAt) < cutoff).length;
  const futureDatedMatchedPosts = pool.filter(p => p.publishedAt && Date.parse(p.publishedAt) > now.getTime()).length;
  const undatedMatchedPosts = pool.length - recentPool.length - staleMatchedPosts - futureDatedMatchedPosts;
  const confidence: "ok" | "low" = recentPool.length >= 3 ? "ok" : "low";
  const sources: SourceStats[] = queried.map((source) => {
    const posts = input.bySource[source] ?? [];
    const rel = unique.filter((p) => p.source === source && isRelevant(p, input.terms));
    return {
      source,
      fetched: true,
      posts: posts.length,
      relevant: rel.length,
      recentRelevant: rel.filter(isRecent).length,
      engagement: rel.reduce((s, p) => s + engagement(p), 0),
      views: rel.reduce((s, p) => s + p.views, 0),
      duplicates: duplicateCounts[source],
    };
  });

  const totalEngagement = pool.reduce((s, p) => s + engagement(p), 0);
  const totalViews = pool.reduce((s, p) => s + p.views, 0);
  const avgEng = pool.length ? totalEngagement / pool.length : 0;

  const authorCounts = new Map<string, number>();
  for (const p of pool) if (p.author) authorCounts.set(p.author.toLowerCase(), (authorCounts.get(p.author.toLowerCase()) ?? 0) + 1);
  const withAuthor = [...authorCounts.values()].reduce((a, b) => a + b, 0);
  const topAuthorShare = withAuthor ? Math.max(...authorCounts.values()) / withAuthor : 0;

  // sentiment
  let pos = 0;
  let neg = 0;
  let risk = 0;
  for (const p of pool) {
    for (const w of tokenize(p.text)) {
      if (POSITIVE.includes(w)) pos++;
      if (NEGATIVE.includes(w)) neg++;
      if (RISK.has(w)) risk++;
    }
  }
  const net = pos + neg === 0 ? 0 : (pos - neg) / (pos + neg);

  // africa
  const africaPosts = pool.filter((p) => AFRICA_RE.test(p.text));
  const africaShare = pool.length ? africaPosts.length / pool.length : 0;
  const africaAuthorCounts = new Map<string, number>();
  for (const p of africaPosts) if (p.author) africaAuthorCounts.set(p.author, (africaAuthorCounts.get(p.author) ?? 0) + 1);
  const africaAuthors = [...africaAuthorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);

  // terms
  const projectTokens = new Set(input.terms.flatMap(tokenize));
  const termCounts = new Map<string, number>();
  for (const p of pool) for (const w of new Set(tokenize(p.text))) {
    if (w.length < 4 || STOP.has(w) || projectTokens.has(w)) continue;
    termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
  }
  const topTerms = [...termCounts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

  const topPosts = [...pool]
    .sort((a, b) => engagement(b) - engagement(a))
    .slice(0, 5)
    .map((p) => ({ source: p.source, text: p.text.slice(0, 200), author: p.author, url: p.url, engagement: engagement(p) }));

  // score (0-100): reach 25, breadth 25, sentiment 25, africa 15, voice diversity 10
  const reach = clamp(Math.log10(1 + totalViews / 20 + totalEngagement * 4) * 6, 0, 25);
  const activeSources = sources.filter((s) => s.relevant >= 3).length;
  const breadth = queried.length ? 25 * (activeSources / queried.length) : 0;
  const sentimentScore = 12.5 + 12.5 * net;
  const africaScore = clamp(africaShare * 60, 0, 15);
  const diversity = pool.length >= 3 ? 10 * (1 - topAuthorShare) : 0;
  const score = Math.round(clamp(reach + breadth + sentimentScore + africaScore + diversity, 0, 100));

  // Recommendations use only matching posts with verified publication dates.
  // The score still describes the complete fetched snapshot, with freshness disclosed below.
  let recentPos = 0, recentNeg = 0, recentRisk = 0;
  for (const p of recentPool) for (const w of tokenize(p.text)) {
    if (POSITIVE.includes(w)) recentPos++;
    if (NEGATIVE.includes(w)) recentNeg++;
    if (RISK.has(w)) recentRisk++;
  }
  const recentNet = recentPos + recentNeg === 0 ? 0 : (recentPos - recentNeg) / (recentPos + recentNeg);
  const recentAfricaPosts = recentPool.filter(p => AFRICA_RE.test(p.text));
  const recentAfricaShare = recentPool.length ? recentAfricaPosts.length / recentPool.length : 0;
  const recentAfricaAuthors = new Map<string, number>();
  for (const p of recentAfricaPosts) if (p.author) {
    recentAfricaAuthors.set(p.author, (recentAfricaAuthors.get(p.author) ?? 0) + 1);
  }
  const recentTopAuthors = [...recentAfricaAuthors.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 5).map(([author]) => author);
  const recentAuthorCounts = new Map<string, number>();
  for (const p of recentPool) if (p.author) {
    const author = p.author.toLowerCase();
    recentAuthorCounts.set(author, (recentAuthorCounts.get(author) ?? 0) + 1);
  }
  const recentWithAuthor = [...recentAuthorCounts.values()].reduce((a, b) => a + b, 0);
  const recentTopAuthorShare = recentWithAuthor
    ? Math.max(...recentAuthorCounts.values()) / recentWithAuthor : 0;
  const recentAvgEng = recentPool.length
    ? recentPool.reduce((sum, p) => sum + engagement(p), 0) / recentPool.length : 0;
  const recentTopPosts = [...recentPool]
    .sort((a, b) => engagement(b) - engagement(a))
    .slice(0, 5)
    .map(p => ({ source: p.source, text: p.text, engagement: engagement(p) }));
  const recentSourcesCount = new Set(recentPool.map(p => p.source)).size;
  const strongRecentEvidence = recentPool.length >= 6 && recentSourcesCount >= 2;

  const recs: RecommendationDraft[] = [];
  if (recentPool.length === 0) {
    recs.push({
      priority: "high",
      title: "Current conversation could not be verified",
      why: "No matching post had a verifiable publication date within the last 30 days.",
      action: "Gather a timestamped sample before making a growth decision.",
    });
  }
  if (recentPool.length > 0 && recentAfricaShare < 0.1) {
    recs.push({
      priority: "high",
      title: "Africa is barely part of the conversation",
      why: `Only ${Math.round(recentAfricaShare * 100)}% of recent matching posts reference an African market, city or local-currency rail.`,
      action: "Run a Nigeria-first activation: three city meetups (Lagos, Abuja, Kaduna), a local-language X Space, and one incentive campaign priced in naira or a local-currency stablecoin. Recruit 10 micro-creators from active African Web3 communities before spending on ads.",
      requiresStrongEvidence: true,
    });
  } else if (recentPool.length > 0 && recentAfricaShare < 0.3) {
    recs.push({
      priority: "medium",
      title: "African pockets exist, so convert them into a community",
      why: `${Math.round(recentAfricaShare * 100)}% of recent matching posts reference Africa.${recentTopAuthors.length ? ` Most active voices: ${recentTopAuthors.slice(0, 3).map((a) => "@" + a).join(", ")}.` : ""}`,
      action: "DM the active African voices with an ambassador or bounty offer, then give them a shared channel and weekly tasks. Retention beats new reach at this stage.",
      requiresStrongEvidence: true,
    });
  }
  if (recentPool.length >= 3 && recentTopAuthorShare > 0.4) {
    recs.push({
      priority: "high",
      title: "The narrative depends on a handful of voices",
      why: `One author accounts for ${Math.round(recentTopAuthorShare * 100)}% of the recent posts we could attribute.`,
      action: "Seed a creator program: 10 to 15 micro-creators, one clear content brief each, paid per verified post. Diversify before the loudest voice goes quiet.",
      requiresStrongEvidence: true,
    });
  }
  for (const s of sources) {
    if (s.source === "reddit" && s.recentRelevant === 0) {
      recs.push({ priority: "medium", title: "No recent Reddit footprint", why: "No matching Reddit posts with publication dates in the 30-day window were found.", action: "Consider a low-cost technical explainer or founder AMA after checking current community fit." });
    }
    if (s.source === "youtube" && s.recentRelevant === 0) {
      recs.push({ priority: "medium", title: "No recent video footprint", why: "No matching YouTube posts with publication dates in the 30-day window were found.", action: "Consider one low-cost walkthrough only after checking current demand." });
    }
  }
  if (recentNet < -0.15 || recentRisk > 0) {
    recs.push({
      priority: "high",
      title: "Trust signals need attention",
      why: `${recentRisk} recent risk-language signal(s) (scam, rug, hack and similar) and net sentiment of ${round(recentNet)}.`,
      action: "Answer the top complaint publicly within 48 hours, publish audit and contract links in one pinned post, and give support a visible response-time target.",
      requiresStrongEvidence: true,
    });
  }
  if (recentPool.length >= 3 && recentAvgEng < 5) {
    recs.push({
      priority: "medium",
      title: "Posts are not earning replies",
      why: `Average engagement is ${round(recentAvgEng, 1)} per recent post.`,
      action: "Swap announcements for questions, polls and small bounties. Ask one specific thing per post and reward the best replies.",
    });
  }
  if (recentTopPosts.length && recentTopPosts[0]!.engagement > recentAvgEng * 3 && recentTopPosts[0]!.engagement > 20) {
    recs.push({
      priority: "low",
      title: "Replicate what already works",
      why: `The top ${recentTopPosts[0]!.source} post earned ${recentTopPosts[0]!.engagement} engagement, over three times the recent average.`,
      action: "Try one low-cost version of its format and track whether the lift repeats.",
    });
  }
  recs.push({
    priority: "low",
    title: "Track this weekly",
    why: "A single timestamped sample cannot establish a trend.",
    action: "Repeat the same measured search weekly and compare verified recent posts before making a larger commitment.",
  });
  const order = { high: 0, medium: 1, low: 2 } as const;
  recs.sort((a, b) => order[a.priority] - order[b.priority]);

  const recentBasis = `Last ${recencyWindowDays} days: ${recentPool.length} matching, timestamp-verified post(s) across ${recentSourcesCount} source(s).`;
  let finalRecommendations: Recommendation[];
  if (recentPool.length < 3) {
    finalRecommendations = [{
      priority: "medium",
      title: "Gather recent evidence before choosing a growth action",
      why: `${recentBasis} ${staleMatchedPosts} matching post(s) are older than the window; ${undatedMatchedPosts} have no usable publication date${futureDatedMatchedPosts ? ` and ${futureDatedMatchedPosts} have future dates` : ""}. The score includes undated and older matches, so it may not reflect current traction.`,
      action: "Repeat a small timestamped sample across the available platforms. Avoid paid creators, ads, bounties, and broad campaigns until there is stronger recent evidence.",
      evidenceStatus: "limited",
    }];
    // A single risk-word hit is a prompt to verify the source, not proof of wrongdoing.
    if (recentRisk > 0) finalRecommendations.push({
      priority: "medium",
      title: "Verify a possible trust concern",
      why: `${recentRisk} recent post(s) contain risk-related language, but this small sample and keyword check do not verify the allegation.`,
      action: "Review the original post and context first. Do not repeat or publicly treat the claim as established without verification.",
      evidenceStatus: "limited",
    });
  } else {
    const blockedHighImpact = recs.some(r => r.requiresStrongEvidence) && !strongRecentEvidence;
    const supported = recs.filter(r => !r.requiresStrongEvidence || strongRecentEvidence);
    finalRecommendations = supported.map(({ requiresStrongEvidence, ...r }) => ({
      ...r,
      title: strongRecentEvidence ? r.title : `Early signal: ${r.title}`,
      why: `${r.why} ${recentBasis} Treat this as directional evidence, not proof.`,
      action: requiresStrongEvidence
        ? `${r.action} Treat this as a limited pilot and measure results before increasing spend.`
        : `${r.action} Prefer a low-cost, reversible test before expanding.`,
      evidenceStatus: strongRecentEvidence ? "well_supported" as const : "recent_sample" as const,
    }));
    if (blockedHighImpact) finalRecommendations.push({
      priority: "low",
      title: "Wait before committing to paid or broad growth activity",
      why: `${recentBasis} High-impact recommendations require at least 6 matching recent posts across 2 sources.`,
      action: "Use a small, reversible test and gather more recent evidence before committing budget or scaling a campaign.",
      evidenceStatus: "recent_sample",
    });
  }
  finalRecommendations.sort((a, b) => order[a.priority] - order[b.priority]);

  const duplicatesExcluded = duplicateSameSource + duplicateCrossSource;
  const lowNote = confidence === "low"
    ? ` LOW CONFIDENCE: ${recentPool.length} of ${pool.length} distinct matching post(s) have verifiable publication dates within the last ${recencyWindowDays} days. The score includes older and undated posts; growth advice is limited accordingly.`
    : ` Confidence is based on ${recentPool.length} timestamp-verified matching post(s) from the last ${recencyWindowDays} days.`;
  const duplicateNote = duplicatesExcluded
    ? ` Excluded ${duplicatesExcluded} duplicate provider result(s) (${duplicateSameSource} same-source, ${duplicateCrossSource} cross-source).`
    : "";
  const summary = `${input.project} scores ${score}/100 (${band(score)}). Across ${queried.length} source(s), ${pool.length} distinct post(s) mention the project from ${all.length} returned result(s), with ${totalEngagement} total engagement; ${Math.round(africaShare * 100)}% of them mention Africa-related places or currencies and net sentiment is ${round(net)}. ${recentBasis}${duplicateNote}${lowNote}`;

  return {
    project: input.project,
    tier: input.tier,
    generatedAt: now.toISOString(),
    mock: input.mock,
    score,
    band: band(score),
    confidence,
    evidence: {
      postsReturned: all.length, postsMatched: pool.length,
      postsUnique: unique.length,
      duplicatesExcluded, duplicateSameSource, duplicateCrossSource,
      recentPosts: recentPool.length,
      staleMatchedPosts,
      undatedMatchedPosts,
      futureDatedMatchedPosts,
      recencyWindowDays,
    },
    summary,
    sources,
    metrics: {
      relevantPosts: pool.length,
      totalEngagement,
      avgEngagementPerPost: round(avgEng, 1),
      uniqueAuthors: authorCounts.size,
      topAuthorShare: round(topAuthorShare),
    },
    sentiment: { positive: pos, negative: neg, net: round(net), riskFlags: risk },
    africa: { posts: africaPosts.length, share: round(africaShare), topAuthors: africaAuthors },
    topTerms,
    topPosts,
    recommendations: finalRecommendations.slice(0, 6),
    scoreBreakdown: {
      reach: round(reach, 1),
      breadth: round(breadth, 1),
      sentiment: round(sentimentScore, 1),
      africa: round(africaScore, 1),
      voiceDiversity: round(diversity, 1),
    },
    methodology:
      "Posts are bought live per request from X, Reddit and YouTube through the buy gateway. Repeated provider IDs are matched only within their source; canonical post URLs can deduplicate matching source permalinks across sources, while distinct platform URLs and cross-platform ID collisions remain separate. Duplicate counts are reported in evidence. Confidence and recommendations use distinct matching posts with verifiable publication dates within the last 30 days; missing or historical dates do not count as recent. The score and descriptive metrics still include all distinct matching results, so read them as a historical snapshot when confidence is low. High-impact or paid-growth recommendations are shown only with at least six recent matching posts across at least two sources, and remain pilots rather than causal proof. Africa share = the share of those posts that mention African countries, cities or local-currency terms; it does not measure where the audience actually lives. Engagement = likes + 2×replies + 3×shares. Sentiment is a keyword lexicon, so treat it as a directional signal, not a verdict. Score = reach 25 + source breadth 25 + sentiment 25 + Africa share 15 + voice diversity 10.",
  };
}
