import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyze.js";
import { canonicalPostUrl, normalizeItems, type Post, type Source } from "../src/sources.js";

function post(source: Source, values: Partial<Post> = {}): Post {
  return { source, text: "GG attention has great momentum in Lagos",
    likes: 10, replies: 2, shares: 1, views: 100, publishedAt: "2026-10-25T08:00:00Z", ...values };
}

test("provider IDs deduplicate within their source without collapsing cross-platform ID collisions", () => {
  const report = analyze({
    project: "GG attention", terms: ["GG attention"], tier: "audit", mock: false,
    now: new Date("2026-10-27T12:00:00Z"),
    bySource: {
      x: [
        post("x", { id: "9001", author: "builder", url: "https://x.com/builder/status/9001?s=20" }),
        post("x", { id: "9001", author: "builder", url: "https://twitter.com/builder/status/9001?ref=share", likes: 99 }),
      ],
      reddit: [
        post("reddit", { id: "9001", author: "builder", url: "https://reddit.com/r/celo/comments/9001/discussion", likes: 7 }),
      ],
    },
  });
  assert.equal(report.evidence.postsReturned, 3);
  assert.equal(report.evidence.postsUnique, 2);
  assert.equal(report.evidence.postsMatched, 2);
  assert.equal(report.evidence.duplicatesExcluded, 1);
  assert.equal(report.evidence.duplicateSameSource, 1);
  assert.equal(report.evidence.duplicateCrossSource, 0);
  assert.equal(report.sources.find(s => s.source === "x")?.relevant, 1);
  assert.equal(report.sources.find(s => s.source === "reddit")?.relevant, 1);
  assert.equal(report.metrics.totalEngagement, 31);
  assert.match(report.summary, /Excluded 1 duplicate provider result/);
});

test("identical canonical source permalink across suppliers is deduplicated, distinct platform posts remain", () => {
  const url = "https://twitter.com/GG/status/12345?s=20";
  const report = analyze({
    project: "GG attention", terms: ["GG attention"], tier: "audit", mock: false,
    now: new Date("2026-10-27T12:00:00Z"),
    bySource: {
      x: [
        post("x", { id: "12345", url, author: "x-author" }),
        post("x", { id: "12345", url: "https://x.com/GG/status/12345?ref=timeline", likes: 200 }),
        post("x", { id: "different-123", url: "https://x.com/other/status/56789", likes: 8 }),
        post("x", { id: "different-alias", url: "https://www.twitter.com/GG/status/12345#photo", likes: 500 }),
      ],
      reddit: [
        // This is the exact same source post returned by another supplier.
        post("reddit", { id: "12345", url: "https://x.com/GG/status/12345#media", likes: 300 }),
        // Same text and colliding provider ID, but a real separate Reddit conversation.
        post("reddit", { id: "12345", url: "https://reddit.com/r/celo/comments/12345/our_take", likes: 9 }),
      ],
    },
  });
  assert.equal(report.evidence.postsReturned, 6);
  assert.equal(report.evidence.postsUnique, 3);
  assert.equal(report.evidence.postsMatched, 3);
  assert.equal(report.evidence.duplicatesExcluded, 3);
  assert.equal(report.evidence.duplicateSameSource, 2);
  assert.equal(report.evidence.duplicateCrossSource, 1);
  assert.equal(report.sources.find(s => s.source === "reddit")?.relevant, 1);
  assert.equal(report.sources.find(s => s.source === "reddit")?.duplicates, 1);
  assert.equal(report.confidence, "ok");
  assert.match(report.methodology, /cross-platform ID collisions remain separate/);
});

test("canonical URLs normalize provider aliases and discard tracking but reject external links", () => {
  assert.equal(canonicalPostUrl("x", "https://www.twitter.com/Alice/status/123?utm_source=share#top"),
    "https://x.com/alice/status/123");
  assert.equal(canonicalPostUrl("reddit", "https://old.reddit.com/r/celo/comments/abc123/title/?utm_medium=x"),
    "https://reddit.com/comments/abc123");
  assert.equal(canonicalPostUrl("youtube", "https://youtu.be/AbCd_12345?si=share"),
    "https://youtube.com/watch?v=AbCd_12345");
  assert.equal(canonicalPostUrl("reddit", "https://example.com/story"), undefined);
  assert.equal(canonicalPostUrl("x", "javascript:alert(1)"), undefined);
});

test("Reddit post permalink outranks outbound article URL during normalization", () => {
  const [reddit] = normalizeItems("reddit", { data: [{
    id: "abc123", title: "GG attention", selftext: "great project",
    url: "https://example.com/news", permalink: "https://www.reddit.com/r/celo/comments/abc123/gg_attention",
  }] });
  assert.equal(reddit?.url, "https://www.reddit.com/r/celo/comments/abc123/gg_attention");
  assert.equal(canonicalPostUrl("reddit", reddit?.url), "https://reddit.com/comments/abc123");
});
