/**
 * Deterministic fixture data in roughly the shape the gateway's social routes return.
 * Used by MOCK_BUY=1, the free /api/sample route and the tests. It is NEVER presented as real data:
 * every report built from it is stamped `mock: true`.
 */
import type { Source } from "./sources.js";

function seeded(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEMPLATES = [
  "{p} just shipped a new release, the onboarding is smooth and the fees are great",
  "Lagos builders are testing {p} this week, early feedback is promising",
  "Is {p} a scam? the support has been slow and my transfer is stuck",
  "{p} community call recap: roadmap, grants and the new partner program",
  "Honestly {p} is solid for mobile payments, easy to use and fast",
  "Nairobi devs asking how to integrate {p} with M-Pesa off-ramps",
  "{p} airdrop speculation is all over my timeline, mostly shill threads",
  "Tutorial: how to build your first dapp with {p} in 20 minutes",
  "Anyone else seeing bugs on {p} after the update? feels broken",
  "{p} partnership announced, bullish on adoption across Africa",
  "{p} vs the competition: a fair comparison of fees and finality",
  "Kaduna meetup was great, 80 people showed up to learn about {p}",
];

const AUTHORS = ["cryptonaija", "defi_lena", "builder_kofi", "web3_amara", "chainwatch", "nairadev", "0xtemi", "solidity_sam", "marketing_mo", "trader_tobi"];

export function mockResponse(source: Source, query: string): unknown {
  const rand = seeded(`${source}:${query.toLowerCase()}`);
  const n = 8 + Math.floor(rand() * 8);
  // Day-granular "recent" timestamps: deterministic within a UTC day, always inside the 30-day recency window.
  const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const rows = Array.from({ length: n }, (_, i) => {
    const created = new Date(dayStart - (i % 20) * 36 * 3600 * 1000).toISOString();
    const text = TEMPLATES[Math.floor(rand() * TEMPLATES.length)].replace("{p}", query);
    const author = AUTHORS[Math.floor(rand() * AUTHORS.length)];
    const pop = Math.floor(rand() * rand() * 400);
    if (source === "x") {
      return {
        id: `x${i}`,
        text,
        author: { username: author },
        likeCount: pop,
        replyCount: Math.floor(pop / 8),
        retweetCount: Math.floor(pop / 5),
        viewCount: pop * 40,
        created_at: created,
        url: `https://x.com/${author}/status/${1000 + i}`,
      };
    }
    if (source === "reddit") {
      return {
        id: `r${i}`,
        title: text.slice(0, 70),
        selftext: text,
        subreddit: ["CryptoCurrency", "ethfinance", "defi", "CeloOrg"][Math.floor(rand() * 4)],
        score: pop,
        num_comments: Math.floor(pop / 6),
        permalink: `/r/defi/comments/${i}`,
        created_at: created,
      };
    }
    return {
      videoId: `y${i}`,
      title: text,
      channelTitle: author,
      viewCount: pop * 90,
      likeCount: Math.floor(pop / 2),
      commentCount: Math.floor(pop / 12),
      publishedAt: created,
    };
  });
  return { data: rows };
}
