export const SEARCHES: Record<"x" | "reddit" | "youtube", string>;
export const FOLLOWUPS: Record<"x_about" | "x_comments" | "reddit_comments" | "youtube_comments", { source: string; url: string; param: string; re: RegExp }>;
export function validatePolicy(policy: unknown): boolean;
export function validateInvocation(invocation: string[], policy: unknown): { kind: string; source: string };
