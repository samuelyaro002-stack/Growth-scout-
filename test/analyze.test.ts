import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, band } from "../src/analyze.js";
import { mockResponse } from "../src/mock.js";
import { normalizeItems, type Post } from "../src/sources.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const mk = (over: Partial<Post>): Post => ({ source: "x", text: "Acme news", likes: 0, replies: 0, shares: 0, views: 0, publishedAt: "2026-10-25T08:00:00Z", ...over });
const an = (input: Parameters<typeof analyze>[0]) => analyze({ now: NOW, ...input });
const fixtures = (name: string) => ({
  x: normalizeItems("x", mockResponse("x", name)),
  reddit: normalizeItems("reddit", mockResponse("reddit", name)),
  youtube: normalizeItems("youtube", mockResponse("youtube", name)),
});

test("fixture audit produces a bounded, fully populated report", () => {
  const r = an({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: fixtures("Acme"), mock: true });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.mock, true);
  assert.equal(r.sources.length, 3);
  assert.ok(r.metrics.relevantPosts > 0);
  assert.ok(r.recommendations.length >= 1 && r.recommendations.length <= 6);
  assert.ok(r.methodology.length > 20);
  const sum = Object.values(r.scoreBreakdown).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - r.score) <= 1.5, `breakdown ${sum} should match score ${r.score}`);
});

test("analysis is deterministic for the same input", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  const a = an({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: fixtures("Acme"), mock: true, now });
  const b = an({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: fixtures("Acme"), mock: true, now });
  assert.deepEqual(a, b);
});

test("no data at all yields a high-priority visibility recommendation, not a crash", () => {
  const r = an({ project: "Ghost", terms: ["Ghost"], tier: "pulse", bySource: { x: [] }, mock: false });
  assert.equal(r.metrics.relevantPosts, 0);
  assert.equal(r.confidence, "low");
  assert.equal(r.recommendations[0].evidenceStatus, "limited", "no data must never produce an actionable growth plan");
});

test("Africa detection matches real markets and ignores look-alike substrings", () => {
  const posts = [
    mk({ text: "Acme is huge in Lagos right now", author: "a" }),
    mk({ text: "Acme paid out in naira instantly", author: "b" }),
    mk({ text: "Acme makes snakes and ladders fun", author: "c" }),
    mk({ text: "Acme explained for devs", author: "d" }),
  ];
  const r = an({ project: "Acme", terms: ["Acme"], tier: "pulse", bySource: { x: posts }, mock: false });
  assert.equal(r.africa.posts, 2);
  assert.equal(r.africa.share, 0.5);
});

test("scam talk lowers sentiment and triggers the trust recommendation", () => {
  const text = "Acme is a scam, total rug, my funds are stuck";
  const x = Array.from({ length: 4 }, (_, i) => mk({ text, author: `u${i}` }));
  const reddit = Array.from({ length: 3 }, (_, i) => mk({ source: "reddit", text, author: `r${i}` }));
  const r = an({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: { x, reddit, youtube: [] }, mock: false });
  assert.ok(r.sentiment.net < 0);
  assert.ok(r.sentiment.riskFlags >= 5);
  assert.ok(r.recommendations.some((x) => x.title.includes("Trust signals")));
});

test("one dominant author triggers the voice-concentration recommendation", () => {
  const x = [...Array.from({ length: 8 }, () => mk({ author: "loud" })), mk({ author: "quiet" })];
  const reddit = [mk({ source: "reddit", author: "other" })];
  const r = an({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: { x, reddit, youtube: [] }, mock: false });
  assert.ok(r.metrics.topAuthorShare > 0.4);
  assert.ok(r.recommendations.some((x) => x.title.includes("handful of voices")));
});

test("missing Reddit/YouTube footprint is called out only for sources actually queried", () => {
  const three = [mk({ author: "a" }), mk({ author: "b" }), mk({ author: "c" })];
  const pulse = an({ project: "Acme", terms: ["Acme"], tier: "pulse", bySource: { x: three }, mock: false });
  assert.ok(!pulse.recommendations.some((x) => x.title.includes("Reddit")));
  const audit = an({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: { x: three, reddit: [], youtube: [] }, mock: false });
  assert.ok(audit.recommendations.some((x) => x.title.includes("Reddit")));
  assert.ok(audit.recommendations.some((x) => x.title.includes("video")));
});

test("score bands", () => {
  assert.equal(band(80), "Strong momentum");
  assert.equal(band(10), "Low visibility");
});

test("ambiguous brand: with a handle supplied, unrelated uses of the bare name are not counted as evidence", () => {
  const posts = [
    mk({ text: "A full walkthrough of @GGAttention, the beta creator platform", author: "a" }),
    mk({ text: "GG Attention is building in the right direction for the creator economy", author: "b" }),
    mk({ text: "he was faking it to get his gg attention, filming drama", author: "c", likes: 1600 }),
    mk({ text: "GG ATTENTION来店取材 抽選は店舗LINEから", author: "d" }),
    mk({ text: "GGattention初開催 ジャグラー81台 ガイアネクスト", author: "e" }),
  ];
  const strict = an({ project: "GG attention", terms: ["GG attention", "GGAttention"], tier: "pulse", bySource: { x: posts }, mock: false, anchors: { project: "GG attention", handle: "GGAttention", keywords: [] } });
  assert.equal(strict.evidence.postsMatched, 2, "handle mention and web3-context mention only");
  assert.ok(strict.metrics.totalEngagement < 1000, "the viral unrelated post must not inflate reach");
  const loose = an({ project: "GG attention", terms: ["GG attention", "GGAttention"], tier: "pulse", bySource: { x: posts }, mock: false });
  assert.equal(loose.evidence.postsMatched, 5, "without a handle the old behaviour is unchanged");
});
