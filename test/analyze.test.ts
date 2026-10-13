import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, band } from "../src/analyze.js";
import { mockResponse } from "../src/mock.js";
import { normalizeItems, type Post } from "../src/sources.js";

const mk = (over: Partial<Post>): Post => ({ source: "x", text: "Acme news", likes: 0, replies: 0, shares: 0, views: 0, ...over });
const fixtures = (name: string) => ({
  x: normalizeItems("x", mockResponse("x", name)),
  reddit: normalizeItems("reddit", mockResponse("reddit", name)),
  youtube: normalizeItems("youtube", mockResponse("youtube", name)),
});

test("fixture audit produces a bounded, fully populated report", () => {
  const r = analyze({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: fixtures("Acme"), mock: true });
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
  const a = analyze({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: fixtures("Acme"), mock: true, now });
  const b = analyze({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: fixtures("Acme"), mock: true, now });
  assert.deepEqual(a, b);
});

test("no data at all yields a high-priority visibility recommendation, not a crash", () => {
  const r = analyze({ project: "Ghost", terms: ["Ghost"], tier: "pulse", bySource: { x: [] }, mock: false });
  assert.equal(r.metrics.relevantPosts, 0);
  assert.equal(r.recommendations[0].priority, "high");
});

test("Africa detection matches real markets and ignores look-alike substrings", () => {
  const posts = [
    mk({ text: "Acme is huge in Lagos right now", author: "a" }),
    mk({ text: "Acme paid out in naira instantly", author: "b" }),
    mk({ text: "Acme makes snakes and ladders fun", author: "c" }),
    mk({ text: "Acme explained for devs", author: "d" }),
  ];
  const r = analyze({ project: "Acme", terms: ["Acme"], tier: "pulse", bySource: { x: posts }, mock: false });
  assert.equal(r.africa.posts, 2);
  assert.equal(r.africa.share, 0.5);
});

test("scam talk lowers sentiment and triggers the trust recommendation", () => {
  const posts = Array.from({ length: 5 }, (_, i) => mk({ text: "Acme is a scam, total rug, my funds are stuck", author: `u${i}` }));
  const r = analyze({ project: "Acme", terms: ["Acme"], tier: "pulse", bySource: { x: posts }, mock: false });
  assert.ok(r.sentiment.net < 0);
  assert.ok(r.sentiment.riskFlags >= 5);
  assert.ok(r.recommendations.some((x) => x.title.startsWith("Trust signals")));
});

test("one dominant author triggers the voice-concentration recommendation", () => {
  const posts = [...Array.from({ length: 8 }, () => mk({ author: "loud" })), mk({ author: "quiet" }), mk({ author: "other" })];
  const r = analyze({ project: "Acme", terms: ["Acme"], tier: "pulse", bySource: { x: posts }, mock: false });
  assert.ok(r.metrics.topAuthorShare > 0.4);
  assert.ok(r.recommendations.some((x) => x.title.includes("handful of voices")));
});

test("missing Reddit/YouTube footprint is called out only for sources actually queried", () => {
  const pulse = analyze({ project: "Acme", terms: ["Acme"], tier: "pulse", bySource: { x: [mk({})] }, mock: false });
  assert.ok(!pulse.recommendations.some((x) => x.title.includes("Reddit")));
  const audit = analyze({ project: "Acme", terms: ["Acme"], tier: "audit", bySource: { x: [mk({})], reddit: [], youtube: [] }, mock: false });
  assert.ok(audit.recommendations.some((x) => x.title.includes("Reddit")));
  assert.ok(audit.recommendations.some((x) => x.title.includes("video")));
});

test("score bands", () => {
  assert.equal(band(80), "Strong momentum");
  assert.equal(band(10), "Low visibility");
});
