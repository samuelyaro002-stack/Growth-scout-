import assert from "node:assert/strict";
import { test } from "node:test";
import { engagement, extractItems, normalizeItems } from "../src/sources.js";

test("finds the item array whatever the envelope", () => {
  const item = { text: "hello" };
  assert.equal(extractItems([item]).length, 1);
  assert.equal(extractItems({ data: [item] }).length, 1);
  assert.equal(extractItems({ result: { tweets: [item, item] } }).length, 2);
  assert.equal(extractItems({ a: { b: { c: [item] } } }).length, 1);
  assert.equal(extractItems({ nothing: 1 }).length, 0);
  assert.equal(extractItems("text").length, 0);
});

test("X-style items with nested author and alias metrics", () => {
  const [p] = normalizeItems("x", { data: [{ id_str: "9", full_text: "gm", user: { screen_name: "@amara" }, favorite_count: "1.2k", reply_count: 3, retweet_count: 4, views: "2M" }] });
  assert.equal(p.author, "amara");
  assert.equal(p.likes, 1200);
  assert.equal(p.replies, 3);
  assert.equal(p.shares, 4);
  assert.equal(p.views, 2_000_000);
  assert.equal(engagement(p), 1200 + 6 + 12);
});

test("Reddit title and body are both searchable", () => {
  const [p] = normalizeItems("reddit", [{ title: "Acme review", selftext: "used it in Lagos", score: 10, num_comments: 2, subreddit: "defi" }]);
  assert.match(p.text, /Acme review/);
  assert.match(p.text, /Lagos/);
  assert.equal(p.author, "defi");
});

test("YouTube items", () => {
  const [p] = normalizeItems("youtube", { items: [{ videoId: "v1", title: "Acme tutorial", channelTitle: "DevKofi", viewCount: 5000, likeCount: 100, commentCount: 7 }] });
  assert.equal(p.views, 5000);
  assert.equal(p.likes, 100);
  assert.equal(p.replies, 7);
});

test("items with no text are dropped, negative or junk numbers become 0", () => {
  const posts = normalizeItems("x", [{ id: 1 }, { text: "ok", likes: -5, replies: "abc" }]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].likes, 0);
  assert.equal(posts[0].replies, 0);
});
