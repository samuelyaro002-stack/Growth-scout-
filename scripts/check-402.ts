/**
 * Free, read-only check of the live paywall: sends an UNPAID request and prints the 402 challenge.
 * Nothing is signed or paid. Usage: npm run check-402 -- https://your-service.onrender.com [audit|pulse]
 */
export {};
const base = (process.argv[2] ?? process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
const tier = process.argv[3] === "pulse" ? "pulse" : "audit";
if (!base) {
  console.error("Pass the service URL: npm run check-402 -- https://your-service.onrender.com");
  process.exit(1);
}
const res = await fetch(`${base}/api/${tier}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ project: "GG attention", handle: "GGAttention" }),
});
console.log(`HTTP ${res.status} (expected 402)`);
const header = res.headers.get("payment-required");
const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json().catch(() => ({}));
for (const a of challenge.accepts ?? []) {
  console.log(`- pay ${Number(a.amount) / 1e6} on ${a.network}`);
  console.log(`  asset: ${a.asset}`);
  console.log(`  payTo: ${a.payTo}`);
}
console.log(`builder code declared: ${challenge.extensions?.["builder-code"]?.info?.a ?? "none"}`);
