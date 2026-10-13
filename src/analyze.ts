import { engagement, type Post, type Source } from "./sources.js";

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
}

export interface SourceStats {
  source: Source;
  fetched: boolean;
  posts: number;
  relevant: number;
  engagement: number;
  views: number;
}

export interface GrowthReport {
  project: string;
  tier: "pulse" | "audit";
  generatedAt: string;
  mock: boolean;
  score: number;
  band: string;
  /** "low" when fewer than 3 posts matched the project: treat the score as indicative only */
  confidence: "ok" | "low";
  evidence: { postsReturned: number; postsMatched: number };
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

  const sources: SourceStats[] = queried.map((source) => {
    const posts = input.bySource[source] ?? [];
    const rel = posts.filter((p) => isRelevant(p, input.terms));
    return {
      source,
      fetched: true,
      posts: posts.length,
      relevant: rel.length,
      engagement: rel.reduce((s, p) => s + engagement(p), 0),
      views: rel.reduce((s, p) => s + p.views, 0),
    };
  });

  const all = queried.flatMap((s) => input.bySource[s] ?? []);
  // Only posts that actually mention the project are evidence. No fallback to unrelated results.
  const pool = all.filter((p) => isRelevant(p, input.terms));
  const confidence: "ok" | "low" = pool.length >= 3 ? "ok" : "low";

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

  const recs: Recommendation[] = [];
  if (pool.length === 0) {
    recs.push({
      priority: "high",
      title: "Almost no public conversation was found",
      why: "The paid searches returned nothing that mentions the project.",
      action: "Check the project name/handle spelling and re-run, or start with a 14-day visibility push: daily build-in-public posts, one explainer thread, and three partner cross-posts.",
    });
  }
  if (pool.length > 0 && africaShare < 0.1) {
    recs.push({
      priority: "high",
      title: "Africa is barely part of the conversation",
      why: `Only ${Math.round(africaShare * 100)}% of relevant posts reference an African market, city or local-currency rail.`,
      action: "Run a Nigeria-first activation: three city meetups (Lagos, Abuja, Kaduna), a local-language X Space, and one incentive campaign priced in naira or a local-currency stablecoin. Recruit 10 micro-creators from active African Web3 communities before spending on ads.",
    });
  } else if (pool.length > 0 && africaShare < 0.3) {
    recs.push({
      priority: "medium",
      title: "African pockets exist, so convert them into a community",
      why: `${Math.round(africaShare * 100)}% of relevant posts reference Africa.${africaAuthors.length ? ` Most active voices: ${africaAuthors.slice(0, 3).map((a) => "@" + a).join(", ")}.` : ""}`,
      action: "DM the active African voices with an ambassador or bounty offer, then give them a shared channel and weekly tasks. Retention beats new reach at this stage.",
    });
  }
  if (pool.length >= 3 && topAuthorShare > 0.4) {
    recs.push({
      priority: "high",
      title: "The narrative depends on a handful of voices",
      why: `One author accounts for ${Math.round(topAuthorShare * 100)}% of the posts we could attribute.`,
      action: "Seed a creator program: 10 to 15 micro-creators, one clear content brief each, paid per verified post. Diversify before the loudest voice goes quiet.",
    });
  }
  for (const s of sources) {
    if (s.source === "reddit" && s.relevant === 0) {
      recs.push({ priority: "medium", title: "No Reddit footprint", why: "No relevant Reddit posts were found.", action: "Publish a technical explainer and host a founder AMA in one relevant subreddit. Reddit threads rank in search and feed AI answers long after launch." });
    }
    if (s.source === "youtube" && s.relevant === 0) {
      recs.push({ priority: "medium", title: "No video footprint", why: "No relevant YouTube results were found.", action: "Commission three short walkthrough videos from African creators: first transaction, a use case, and a comparison. Video is how many first-time users in the region learn." });
    }
  }
  if (net < -0.15 || risk > 0) {
    recs.push({
      priority: "high",
      title: "Trust signals need attention",
      why: `${risk} risk-flag mention(s) (scam, rug, hack and similar) and net sentiment of ${round(net)}.`,
      action: "Answer the top complaint publicly within 48 hours, publish audit and contract links in one pinned post, and give support a visible response-time target.",
    });
  }
  if (pool.length >= 3 && avgEng < 5) {
    recs.push({
      priority: "medium",
      title: "Posts are not earning replies",
      why: `Average engagement is ${round(avgEng, 1)} per post.`,
      action: "Swap announcements for questions, polls and small bounties. Ask one specific thing per post and reward the best replies.",
    });
  }
  if (topPosts.length && topPosts[0].engagement > avgEng * 3 && topPosts[0].engagement > 20) {
    recs.push({
      priority: "low",
      title: "Replicate what already works",
      why: `The top ${topPosts[0].source} post earned ${topPosts[0].engagement} engagement, over three times the average.`,
      action: "Re-publish its format and angle across the other channels this week and track whether the lift repeats.",
    });
  }
  recs.push({
    priority: "low",
    title: "Track this weekly",
    why: "A single snapshot hides direction.",
    action: "Re-run the pulse every week and watch score, Africa share and sentiment move against your campaigns.",
  });
  const order = { high: 0, medium: 1, low: 2 } as const;
  recs.sort((a, b) => order[a.priority] - order[b.priority]);

  const lowNote = confidence === "low" ? ` LOW CONFIDENCE: only ${pool.length} of ${all.length} returned post(s) mention the project, so treat this score as indicative only.` : "";
  const summary = `${input.project} scores ${score}/100 (${band(score)}). Across ${queried.length} source(s), ${pool.length} of ${all.length} returned post(s) mention the project, with ${totalEngagement} total engagement; ${Math.round(africaShare * 100)}% of them mention Africa-related places or currencies and net sentiment is ${round(net)}.${lowNote}`;

  return {
    project: input.project,
    tier: input.tier,
    generatedAt: (input.now ?? new Date()).toISOString(),
    mock: input.mock,
    score,
    band: band(score),
    confidence,
    evidence: { postsReturned: all.length, postsMatched: pool.length },
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
    recommendations: recs.slice(0, 6),
    scoreBreakdown: {
      reach: round(reach, 1),
      breadth: round(breadth, 1),
      sentiment: round(sentimentScore, 1),
      africa: round(africaScore, 1),
      voiceDiversity: round(diversity, 1),
    },
    methodology:
      "Posts are bought live per request from X, Reddit and YouTube through the buy gateway. Only posts that mention the project name, handle or a given keyword count as evidence. Africa share = the share of those posts that mention African countries, cities or local-currency terms; it does not measure where the audience actually lives. Engagement = likes + 2×replies + 3×shares. Sentiment is a keyword lexicon, so treat it as a directional signal, not a verdict. Score = reach 25 + source breadth 25 + sentiment 25 + Africa share 15 + voice diversity 10.",
  };
}
