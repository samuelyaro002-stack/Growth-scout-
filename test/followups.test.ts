import test from "node:test";
import assert from "node:assert/strict";
import { SEARCHES, FOLLOWUPS, validateInvocation, validatePolicy } from "../src/invocation-policy.mjs";
import { buildBuyArgs, BuyClient, newSpend, type PurchaseRunner } from "../src/buy.js";
import { GrowthAgent, parseRequest } from "../src/agent.js";
import { Ledger } from "../src/ledger.js";
import { liveTestConfig, tmpDir } from "./helpers.js";

const policy = {
  sources: ["x", "reddit", "youtube"], maxCallUsd: { x: 0.0075, reddit: 0.0075, youtube: 0.0075 },
  maxFollowupUsd: 0.0075, dailyCapUsd: 0.3,
};
const inv = (url: string, body: unknown, max = 0.0075) => buildBuyArgs(url, body, max, "USDC").slice(1); // drop --verbose
const U = (k: keyof typeof FOLLOWUPS) => FOLLOWUPS[k].url;

test("policy accepts each fixed search and follow-up shape", () => {
  assert.equal(validatePolicy(policy), true);
  assert.deepEqual(validateInvocation(inv(SEARCHES.x, { query: "Acme" }), policy), { kind: "search:x", source: "x" });
  assert.equal(validateInvocation(inv(U("x_about"), { queryParams: { screen_name: "acme_hq" } }), policy).kind, "x_about");
  assert.equal(validateInvocation(inv(U("x_comments"), { queryParams: { tweet_id: "1850000000000000001" } }), policy).kind, "x_comments");
  assert.equal(validateInvocation(inv(U("reddit_comments"), { queryParams: { post_id: "t3_1abc2d" } }), policy).kind, "reddit_comments");
  assert.equal(validateInvocation(inv(U("youtube_comments"), { queryParams: { video_id: "dQw4w9WgXcQ" } }), policy).kind, "youtube_comments");
});

test("policy refuses other URLs, extra or malformed params, oversize caps and disabled sources", () => {
  const bad: [string, unknown, number?][] = [
    ["https://example.com/x", { query: "a" }],
    [U("x_about"), { queryParams: { screen_name: "way_too_long_handle_name" } }],
    [U("x_about"), { queryParams: { screen_name: "ok", extra: "1" } }],
    [U("x_about"), { screen_name: "ok" }],
    [U("x_comments"), { queryParams: { tweet_id: "12abc" } }],
    [U("reddit_comments"), { queryParams: { post_id: "abc" } }],
    [U("youtube_comments"), { queryParams: { video_id: "short" } }],
    [U("youtube_comments"), { queryParams: { video_id: "dQw4w9WgXcQ" } }, 0.01],
    [SEARCHES.x, { query: "a", url: "https://evil" }],
    [SEARCHES.x, { query: "a".repeat(257) }],
  ];
  for (const [url, body, max] of bad) assert.throws(() => validateInvocation(inv(url, body, max), policy), /./, JSON.stringify(body));
  assert.throws(() => validateInvocation(inv(U("x_about"), { queryParams: { screen_name: "ok" } }), { ...policy, sources: ["reddit"] }));
  // Follow-ups are impossible unless the policy grants a ceiling.
  const { maxFollowupUsd: _omit, ...noFollowups } = policy;
  assert.throws(() => validateInvocation(inv(U("x_about"), { queryParams: { screen_name: "ok" } }), noFollowups));
  const extra = inv(U("x_about"), { queryParams: { screen_name: "ok" } });
  assert.throws(() => validateInvocation([...extra, "-L"], policy));
});

/** Runner that answers by URL, shaped like plausible provider responses. */
function scripted(log: string[]): PurchaseRunner {
  const stderr = JSON.stringify({ step: "quote", amount: "5000" }) + "\n" + JSON.stringify({ step: "settled", transaction: "0x" + "cd".repeat(32) });
  const now = new Date().toISOString();
  return async (_b, args) => {
    const url = args.at(-1)!;
    log.push(url.replace("https://gateway.usebuy.ai/v1/social/", ""));
    let body: unknown;
    if (url.includes("/x/posts/search")) body = { data: [
      { id: "1850000000000000001", text: "Acme is great on mobile, Lagos loves it @acme", author: { username: "amara" }, likeCount: 50, replyCount: 6, retweetCount: 4, created_at: now },
      { id: "1850000000000000002", text: "Acme crypto wallet update", author: { username: "tobi" }, likeCount: 5, created_at: now },
    ] };
    else if (url.includes("/reddit/posts/search")) body = { data: [{ id: "1abc2d", title: "Acme web3 wallet review", selftext: "", subreddit: "defi", score: 30, num_comments: 4, created_at: now }] };
    else if (url.includes("/youtube/videos/search")) body = { data: [{ videoId: "dQw4w9WgXcQ", title: "Acme web3 wallet tour", channelTitle: "x", viewCount: 900, publishedAt: now }] };
    else if (url.includes("user-about")) body = { data: { user: { followers_count: 4200, location: "Nairobi, Kenya" } } };
    else body = { data: { comments: [{ text: "love it, smooth", user: { username: "a" }, location: "London, UK", created_at: now }, { text: "great", user: { username: "b" }, created_at: now }] } };
    return { code: 0, stdout: JSON.stringify(body), stderr };
  };
}

test("audit buys searches, then profiles and replies for what it found, and reports them", async () => {
  const cfg = liveTestConfig({ maxSpendPerRequestUsd: 0.09 });
  const log: string[] = [];
  const agent = new GrowthAgent(new BuyClient(cfg, new Ledger(tmpDir()), scripted(log)), false);
  const out = await agent.run(parseRequest({ project: "Acme", handle: "acme", keywords: ["wallet"], focusRegion: "Africa" }), "audit");
  assert.deepEqual(log.map((l) => l.split("/tools/")[1] ?? l.split("/").slice(0, 2).join("/")), [
    "x/posts", "reddit/posts", "youtube/videos",
    "tikhub-api-v1-twitter-web-fetch-user-about", "tikhub-api-v1-twitter-web-fetch-user-about", "tikhub-api-v1-twitter-web-fetch-user-about",
    "tikhub-api-v1-twitter-web-fetch-post-comments", "tikhub-api-v1-reddit-app-fetch-post-comments", "tikhub-api-v1-youtube-web-v2-get-video-comments",
  ].map((x, i) => (i < 3 ? x : x)));
  assert.equal(out.report.profile?.followers, 4200);
  assert.equal(out.report.voices?.length, 2);
  assert.equal(out.report.audience?.comments, 6);
  assert.ok(out.report.audience!.regions.some((r) => r.region === "Europe"));
  assert.equal(out.report.focus?.region, "Africa");
  assert.ok(out.paidCalls.every((c) => c.ok));
  assert.ok(out.diagnostics?.some((d) => d.kind === "x_comments" && d.readable));
});

test("a spend cap during follow-ups yields a thinner report with a warning, never a failed one", async () => {
  const cfg = liveTestConfig({ maxSpendPerRequestUsd: 0.02 }); // room for the 3 searches (0.015 at quoted prices) + 1 call
  const log: string[] = [];
  const agent = new GrowthAgent(new BuyClient(cfg, new Ledger(tmpDir()), scripted(log)), false);
  const out = await agent.run(parseRequest({ project: "Acme", handle: "acme", keywords: ["wallet"] }), "audit");
  assert.ok(log.length >= 3 && log.length <= 4, `bought ${log.length}`);
  assert.ok(out.warnings.some((w) => /skipped/.test(w)));
  assert.ok(out.report.evidence.postsMatched > 0);
});

test("pulse never buys follow-ups; bad focusRegion is rejected", async () => {
  const log: string[] = [];
  const agent = new GrowthAgent(new BuyClient(liveTestConfig(), new Ledger(tmpDir()), scripted(log)), false);
  await agent.run(parseRequest({ project: "Acme", handle: "acme" }), "pulse");
  assert.equal(log.length, 1);
  assert.throws(() => parseRequest({ project: "Acme", focusRegion: "Atlantis" }), /focusRegion/);
  assert.equal(parseRequest({ project: "Acme", focusRegion: "latam" }).focusRegion, "Latin America");
  void newSpend;
});
