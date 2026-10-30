/**
 * Normalises whatever the buy gateway returns into one Post shape.
 *
 * The gateway's response schemas for the social endpoints are not documented publicly, and some
 * routes proxy third-party scrapers whose field names differ (likeCount vs favorite_count vs score).
 * So this is deliberately defensive: find the first array of objects, then read each field through
 * a list of known aliases. `npm run probe:buy` prints a real response so the aliases can be tuned.
 */

export type Source = "x" | "reddit" | "youtube";

export interface Post {
  source: Source;
  id?: string;
  text: string;
  author?: string;
  url?: string;
  /** Provider publication time; retrieval time is not a substitute. */
  publishedAt?: string;
  likes: number;
  replies: number;
  shares: number;
  views: number;
}

const ARRAY_KEYS = [
  "data", "results", "items", "posts", "tweets", "videos", "entries", "children", "list", "response",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function extractItems(body: unknown, depth = 0): Obj[] {
  if (depth > 4) return [];
  if (Array.isArray(body)) {
    const objs = body.filter(isObj);
    if (objs.length > 0) return objs;
    return [];
  }
  if (!isObj(body)) return [];
  for (const key of ARRAY_KEYS) {
    if (key in body) {
      const found = extractItems(body[key], depth + 1);
      if (found.length > 0) return found;
    }
  }
  for (const value of Object.values(body)) {
    if (Array.isArray(value) || isObj(value)) {
      const found = extractItems(value, depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) {
    if (k in o && o[k] !== null && o[k] !== undefined) return o[k];
  }
  // one level down (e.g. { data: { text } } or { legacy: { full_text } })
  for (const v of Object.values(o)) {
    if (isObj(v)) {
      for (const k of keys) {
        if (k in v && v[k] !== null && v[k] !== undefined) return v[k];
      }
    }
  }
  return undefined;
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim().toLowerCase();
    const m = cleaned.match(/^([\d.]+)\s*([kmb])?$/);
    if (m) {
      const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
      const n = parseFloat(m[1]) * mult;
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

function toText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toAuthor(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v.replace(/^@/, "");
  if (isObj(v)) {
    const inner = pick(v, ["username", "screen_name", "handle", "name", "unique_id", "title"]);
    if (typeof inner === "string" && inner) return inner.replace(/^@/, "");
  }
  return undefined;
}

const TEXT_KEYS = ["text", "full_text", "content", "title", "body", "selftext", "description", "caption"];
const LIKE_KEYS = ["likes", "like_count", "likeCount", "favorite_count", "favorites", "score", "ups", "upvotes", "digg_count", "diggCount"];
const REPLY_KEYS = ["replies", "reply_count", "replyCount", "comments", "comment_count", "commentCount", "num_comments"];
const SHARE_KEYS = ["retweets", "retweet_count", "retweetCount", "shares", "share_count", "reposts", "quote_count"];
const VIEW_KEYS = ["views", "view_count", "viewCount", "impressions", "play_count", "playCount"];
const AUTHOR_KEYS = ["author", "username", "user", "screen_name", "channelTitle", "channel", "subreddit", "handle"];
const ID_KEYS = ["id", "id_str", "videoId", "video_id", "rest_id", "name"];
const URL_KEYS_BY_SOURCE: Record<Source, string[]> = {
  x: ["permalink", "url", "postUrl", "link"],
  // A Reddit `url` often points to an external article; the permalink identifies the post.
  reddit: ["permalink", "postUrl", "url", "link"],
  youtube: ["permalink", "url", "watch_url", "video_url", "link", "postUrl"],
};
const PUBLISHED_AT_KEYS = [
  "publishedAt", "published_at", "created_at", "createdAt", "posted_at",
  "upload_date", "published", "created", "date", "timestamp",
];

function toPublishedAt(value: unknown): string | undefined {
  let time: number;
  if (value instanceof Date) time = value.getTime();
  else if (typeof value === "number" && Number.isFinite(value)) {
    time = Math.abs(value) >= 100_000_000_000 ? value : value * 1000;
  } else if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (/^\d{10}(?:\.\d+)?$/.test(normalized)) time = Number(normalized) * 1000;
    else if (/^\d{13}$/.test(normalized)) time = Number(normalized);
    else time = Date.parse(normalized);
  } else return undefined;
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
}

/** Canonicalize only well-formed web URLs. Different platform URLs stay distinct. */
export function canonicalPostUrl(_source: Source, raw: string | undefined): string | undefined {
  if (!raw || raw.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";

  if (["twitter.com", "x.com"].includes(host)) {
    // Query strings and fragments on status links are tracking/client state, not identity.
    path = path.replace(/^\/([^/]+)\/status\/(\d+)(?:\/.*)?$/i,
      (_match, user: string, id: string) => `/${user.toLowerCase()}/status/${id}`);
    return `https://x.com${path}`;
  }
  if (["reddit.com", "old.reddit.com", "redd.it"].includes(host)) {
    let id: string | undefined;
    if (host === "redd.it") id = path.split("/").filter(Boolean)[0];
    else id = path.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i)?.[1];
    return id ? `https://reddit.com/comments/${id.toLowerCase()}` : `https://reddit.com${path}`;
  }
  if (["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const id = host === "youtu.be"
      ? path.split("/").filter(Boolean)[0]
      : path.match(/^\/(?:shorts|embed|live)\/([^/]+)/i)?.[1] ??
        (path === "/watch" ? url.searchParams.get("v") ?? undefined : undefined);
    if (id && /^[\w-]{6,20}$/.test(id)) return `https://youtube.com/watch?v=${id}`;
    return `https://youtube.com${path}`;
  }
  return undefined;
}

export function normalizeItems(source: Source, body: unknown): Post[] {
  const posts: Post[] = [];
  for (const item of extractItems(body)) {
    // title + body together for Reddit so mentions in either count
    let text = toText(pick(item, TEXT_KEYS));
    if (source === "reddit") {
      const sel = toText(item["selftext"]);
      const title = toText(item["title"]);
      text = [title, sel].filter(Boolean).join(" — ") || text;
    }
    if (!text.trim()) continue;
    const id = pick(item, ID_KEYS);
    const url = pick(item, URL_KEYS_BY_SOURCE[source]);
    const publishedAt = toPublishedAt(pick(item, PUBLISHED_AT_KEYS));
    posts.push({
      source,
      id: typeof id === "string" || typeof id === "number" ? String(id) : undefined,
      text: text.trim().slice(0, 600),
      author: toAuthor(pick(item, AUTHOR_KEYS)),
      url: typeof url === "string" ? url : undefined,
      publishedAt,
      likes: toNum(pick(item, LIKE_KEYS)),
      replies: toNum(pick(item, REPLY_KEYS)),
      shares: toNum(pick(item, SHARE_KEYS)),
      views: toNum(pick(item, VIEW_KEYS)),
    });
  }
  return posts;
}

export const engagement = (p: Post): number => p.likes + 2 * p.replies + 3 * p.shares;
