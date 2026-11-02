/**
 * Pure validation of the one buy invocation shape the signer runner will execute.
 * Kept free of signer/SDK imports so it can be unit-tested directly.
 */
const G = 'https://gateway.usebuy.ai';

/** Fixed endpoint table: the runner will sign for these URLs and nothing else. */
export const SEARCHES = {
  x: `${G}/v1/social/x/posts/search`,
  reddit: `${G}/v1/social/reddit/posts/search`,
  youtube: `${G}/v1/social/youtube/videos/search`,
};

/** Follow-up purchases: url -> { source, param name, value pattern }. */
export const FOLLOWUPS = {
  x_about: { source: 'x', url: `${G}/v1/social/x/tools/tikhub-api-v1-twitter-web-fetch-user-about`, param: 'screen_name', re: /^[A-Za-z0-9_]{1,15}$/ },
  x_comments: { source: 'x', url: `${G}/v1/social/x/tools/tikhub-api-v1-twitter-web-fetch-post-comments`, param: 'tweet_id', re: /^\d{1,25}$/ },
  reddit_comments: { source: 'reddit', url: `${G}/v1/social/reddit/tools/tikhub-api-v1-reddit-app-fetch-post-comments`, param: 'post_id', re: /^t3_[a-z0-9]{1,17}$/ },
  youtube_comments: { source: 'youtube', url: `${G}/v1/social/youtube/tools/tikhub-api-v1-youtube-web-v2-get-video-comments`, param: 'video_id', re: /^[A-Za-z0-9_-]{11}$/ },
};

export function validatePolicy(policy) {
  const sources = ['x', 'reddit', 'youtube'];
  return !!policy && Array.isArray(policy.sources) && policy.sources.length > 0 &&
    policy.sources.every((s) => sources.includes(s)) &&
    Number.isFinite(policy.dailyCapUsd) && policy.dailyCapUsd > 0 && policy.dailyCapUsd <= 1000 &&
    !!policy.maxCallUsd && sources.every((s) =>
      Number.isFinite(policy.maxCallUsd[s]) && policy.maxCallUsd[s] >= 0 && policy.maxCallUsd[s] <= 1000) &&
    (policy.maxFollowupUsd === undefined ||
      (Number.isFinite(policy.maxFollowupUsd) && policy.maxFollowupUsd >= 0 && policy.maxFollowupUsd <= 1000));
}

/**
 * invocation = argv after any leading --verbose, starting at `curl`.
 * Returns { kind, source } or throws Error with a safe message.
 */
export function validateInvocation(invocation, policy) {
  const deny = (m) => { throw new Error(m); };
  if (invocation.length !== 10) deny('Only the capped report purchase invocation is permitted.');
  const amount = Number(invocation[2]);
  const url = invocation[9];
  let kind, source, limit;
  const search = Object.keys(SEARCHES).find((s) => SEARCHES[s] === url);
  const followup = Object.keys(FOLLOWUPS).find((k) => FOLLOWUPS[k].url === url);
  if (search) { kind = 'search:' + search; source = search; limit = policy.maxCallUsd[search]; }
  else if (followup) {
    kind = followup; source = FOLLOWUPS[followup].source;
    limit = policy.maxFollowupUsd ?? 0;
  } else deny('Endpoint is not on the purchase allowlist.');
  if (invocation[0] !== 'curl' || invocation[1] !== '--max-amount' ||
      !Number.isFinite(amount) || amount <= 0 || amount > limit ||
      invocation[3] !== '-X' || invocation[4] !== 'POST' ||
      invocation[5] !== '-H' || invocation[6] !== 'Content-Type: application/json' ||
      invocation[7] !== '--data' || !policy.sources.includes(source)) {
    deny('Only the capped report purchase invocation is permitted.');
  }
  let body;
  try { body = JSON.parse(invocation[8]); } catch { deny('Purchase body must be JSON.'); }
  const plain = body && typeof body === 'object' && !Array.isArray(body);
  if (!plain || Object.keys(body).length !== 1) deny('Purchase body is not permitted.');
  if (search) {
    if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 256 ||
        /[\u0000-\u001f]/.test(body.query)) deny('Purchase body is not permitted.');
  } else {
    const f = FOLLOWUPS[followup];
    const q = body.queryParams;
    if (!q || typeof q !== 'object' || Array.isArray(q) || Object.keys(q).length !== 1 ||
        typeof q[f.param] !== 'string' || !f.re.test(q[f.param])) deny('Purchase body is not permitted.');
  }
  return { kind, source };
}
