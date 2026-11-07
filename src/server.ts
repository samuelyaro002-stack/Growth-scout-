import express, { type Express, type Request, type Response } from "express";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { BUILDER_CODE, builderCodeResourceServerExtension, declareBuilderCodeExtension } from "@x402/extensions/builder-code";
import { privateKeyToAccount } from "viem/accounts";
import { buildRegistrationFile } from "./agentCard.js";
import { GrowthAgent, parseRequest, ReportError, ValidationError, type Tier } from "./agent.js";
import { BuyClient } from "./buy.js";
import { loadConfig, type Config } from "./config.js";
import { Ledger, SpendCapError } from "./ledger.js";
import { mockResponse } from "./mock.js";
import { analyze } from "./analyze.js";
import { normalizeItems } from "./sources.js";
import { buildAccepts } from "./pricing.js";
import { assertValidCode, checkRepoMatchesCode } from "./tag.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BudgetLedger } from "./ledger.js";

export function resolvePayTo(cfg: Config): string {
  if (process.env.PAY_TO) return process.env.PAY_TO.trim();
  if (cfg.privateKey) return privateKeyToAccount(cfg.privateKey as `0x${string}`).address;
  throw new Error("Set AGENT_PRIVATE_KEY (or PAY_TO) so we know where to receive payments");
}

export function buildRoutes(cfg: Config, payTo: string): RoutesConfig {
  const ext = { [BUILDER_CODE]: declareBuilderCodeExtension(cfg.builderCode) };
  return {
    "POST /api/pulse": {
      accepts: buildAccepts(cfg, cfg.pricePulseUsd, payTo),
      description: "GrowthScout pulse: live X snapshot, regional mentions, sentiment and a 0-100 growth score for a Web3 project",
      mimeType: "application/json",
      extensions: ext,
    },
    "POST /api/audit": {
      accepts: buildAccepts(cfg, cfg.priceAuditUsd, payTo),
      description: "GrowthScout audit: X + Reddit + YouTube data, the project's profile and audience replies, regional gap analysis and a prioritised growth plan",
      mimeType: "application/json",
      extensions: ext,
    },
  } as RoutesConfig;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function landing(cfg: Config): string {
  const base = esc(cfg.publicUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GrowthScout</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="theme-color" content="#07070a"><link rel="stylesheet" href="/style.css"></head><body>
<header class="wrap nav"><a class="logo" href="/">growth<i>scout</i></a>
<nav class="navlinks"><a class="hide" href="/api/sample">Sample</a><a class="hide" href="/api/receipts">Ledger</a><a class="hide" href="/.well-known/agent.json">Identity</a><a class="btn" href="/pay">Get your audit &rarr;</a></nav></header>
<section class="hero"><canvas id="orb" aria-hidden="true"></canvas><div class="wrap">
<div class="eyebrow">Growth &middot; Intelligence &middot; Worldwide</div>
<h1><span>Is your project</span><span>visible where</span><span>it matters?</span></h1>
<p class="lead">A Web3 growth audit built from live data our agent buys, one payment at a time.</p>
<div class="ctas"><a class="btn" href="/pay">Get your audit &rarr;</a><a class="btn alt" href="/api/sample">See a sample report &darr;</a></div>
</div></section>
<section class="violet"><div class="wrap"><div class="eyebrow" style="color:#d9d0f5">How it works</div><h2>Four steps. One report.</h2>
<div class="grid">
<div class="step"><b class="n">01</b><h3>You pay</h3><p>$${cfg.priceAuditUsd.toFixed(2)} in USDC or USD&#8366; on Celo, one wallet signature, no account.</p></div>
<div class="step"><b class="n">02</b><h3>The agent buys data</h3><p>Live X, Reddit and YouTube searches, profiles and replies, each paid through buy.</p></div>
<div class="step"><b class="n">03</b><h3>We analyse</h3><p>Deduplicated, dated, scored 0&ndash;100 with regional mentions worldwide.</p></div>
<div class="step"><b class="n">04</b><h3>You act</h3><p>An evidence-graded growth plan, with every purchase linked on-chain.</p></div>
</div></div></section>
<section class="sec wrap"><div class="eyebrow">Pricing</div><h2>Two reports.</h2>
<div class="grid">
<div class="card"><b>Pulse</b> <span class="price">$${cfg.pricePulseUsd.toFixed(2)}</span><br>Live X snapshot, regional mentions, sentiment and a 0-100 growth score.<pre>POST ${base}/api/pulse
{"project":"Celo","handle":"@Celo_Org"}</pre></div>
<div class="card"><b>Audit</b> <span class="price">$${cfg.priceAuditUsd.toFixed(2)}</span><br>X + Reddit + YouTube, profile and reply data, regional gap analysis and a prioritised growth plan. Takes about 2 minutes.<pre>POST ${base}/api/audit
{"project":"Celo","keywords":["MiniPay"]}</pre></div></div>
<div class="card">Prefer the command line? Pay with any x402 client, for example <a href="https://usebuy.ai">buy</a>:<pre>buy curl --max-amount 0.12 -X POST \\
  -H 'Content-Type: application/json' \\
  --data '{"project":"YourProject"}' \\
  ${base}/api/audit</pre></div>
<p class="footer">Every paid report is built from data we buy live through <a href="https://usebuy.ai">buy</a>. <a href="/api/receipts">Public ledger</a> &middot; <a href="/.well-known/agent.json">ERC-8004 identity</a></p>
</section>
<script>(function(){var c=document.getElementById("orb");if(!c||matchMedia("(prefers-reduced-motion: reduce)").matches)return;var x=c.getContext("2d"),S=0,P=[],i;
function size(){S=c.width=c.height=Math.min(640,innerWidth*.62)*devicePixelRatio}size();addEventListener("resize",size);
for(i=0;i<420;i++){var u=Math.random()*2-1,t=Math.random()*6.283,r=Math.sqrt(1-u*u);P.push([r*Math.cos(t),u,r*Math.sin(t),Math.random()<.04])}
var a=0;function f(){a+=.003;x.clearRect(0,0,S,S);var g=x.createRadialGradient(S/2,S/2,S*.05,S/2,S/2,S/2);g.addColorStop(0,"rgba(106,63,196,.55)");g.addColorStop(.8,"rgba(42,21,96,.25)");g.addColorStop(1,"rgba(42,21,96,0)");x.fillStyle=g;x.beginPath();x.arc(S/2,S/2,S/2*.96,0,7);x.fill();
for(i=0;i<P.length;i++){var p=P[i],X=p[0]*Math.cos(a)-p[2]*Math.sin(a),Z=p[0]*Math.sin(a)+p[2]*Math.cos(a),k=(Z+1.6)/2.6;x.fillStyle=p[3]?"#c6f24a":"rgba(244,243,238,"+(.2+.6*k)+")";x.beginPath();x.arc(S/2+X*S*.46,S/2+p[1]*S*.46,(p[3]?3:1.4)*k*devicePixelRatio,0,7);x.fill()}requestAnimationFrame(f)}f()})();</script>
</body></html>`;
}

export interface AppDeps {
  onUnexpectedError?: () => void;
  parseReportRequest?: (body: unknown) => ReturnType<typeof parseRequest>;
  validateReportResponse?: (body: unknown) => unknown;
  ledger?: BudgetLedger;
  buy?: BuyClient;
}

export function createApp(cfg: Config, deps: AppDeps = {}): Express {
  if (cfg.devNoPaywall && (!cfg.mockBuy || process.env.NODE_ENV === "production")) {
    throw new Error("Paywall bypass requires local fixture mode.");
  }
  assertValidCode(cfg.builderCode);
  const ledger: BudgetLedger = deps.ledger ?? new Ledger(cfg.dataDir);
  const buy = deps.buy ?? new BuyClient(cfg, ledger);
  const agent = new GrowthAgent(buy, cfg.mockBuy);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  const reportContext = new AsyncLocalStorage<{ reportId: string }>();
  app.use((_req, _res, next) => reportContext.run({ reportId: randomUUID() }, next));

  // ---- free routes (registered before the paywall) ----
  app.get("/", (_req, res) => res.type("html").send(landing(cfg)));
  // Browser payment page for independent customers. pay.js is a committed bundle (npm run build:pay).
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  app.get("/pay", (_req, res) => res.sendFile(publicDir + "pay.html"));
  app.get("/favicon.svg", (_req, res) => res.type("image/svg+xml").sendFile(publicDir + "favicon.svg"));
  app.get("/style.css", (_req, res) => res.type("css").sendFile(publicDir + "style.css"));
  app.get("/pay.js", (_req, res) => res.type("js").sendFile(publicDir + "pay.js"));
  app.get("/health", async (_req, res) => {
    const budgetReady = await ledger.ready(cfg.dailySpendCapUsd);
    res.json({ ok: true, mock: cfg.mockBuy, paywall: !cfg.devNoPaywall, purchasesEnabled: cfg.reportPurchasesEnabled && budgetReady, agentId: cfg.agentId || null, caps: { perRequestUsd: cfg.maxSpendPerRequestUsd, dailyUsd: cfg.dailySpendCapUsd } });
  });
  app.get("/.well-known/agent.json", (_req, res) => res.json(buildRegistrationFile(cfg)));
  app.get("/api/growthscout/health", async (_req, res) => {
    const budgetReady = await ledger.ready(cfg.dailySpendCapUsd);
    res.json({ ok: true, mock: cfg.mockBuy, paywall: !cfg.devNoPaywall,
      purchasesEnabled: cfg.reportPurchasesEnabled && budgetReady,
      budgetReady, agentId: cfg.agentId || null, caps: { perRequestUsd: cfg.maxSpendPerRequestUsd, dailyUsd: cfg.dailySpendCapUsd } });
  });
  app.get("/api/growthscout/agent", (_req, res) => res.json(buildRegistrationFile(cfg)));
  app.get("/api/receipts", async (_req, res) => {
    try { res.json({
      builderCode: cfg.builderCode,
      agentId: cfg.agentId || null,
      ...await ledger.summary(),
      spentTodayWorstCaseUsd: Number((await ledger.spentToday()).toFixed(6)),
      notes: [
        "supplier = what the agent bought through buy; customers.confirmedPayments counts only payments the x402 facilitator confirmed.",
        "reportsGenerated can exceed confirmedPayments: a report that was generated but whose payment did not settle is not a sale.",
      ],
    }); } catch { res.status(503).json({ error: "Shared receipt authority unavailable; no empty or reset totals returned." }); }
  });
  app.get("/api/sample", (_req, res) => {
    const name = "SampleProject";
    const bySource = {
      x: normalizeItems("x", mockResponse("x", name)),
      reddit: normalizeItems("reddit", mockResponse("reddit", name)),
      youtube: normalizeItems("youtube", mockResponse("youtube", name)),
    };
    res.json({
      notice: "SAMPLE ONLY. Built from fixture data, not real posts. Paid reports use live data.",
      report: analyze({ project: name, terms: [name], tier: "audit", bySource, mock: true }),
    });
  });

  // ---- x402 paywall ----
  if (!cfg.devNoPaywall) {
    const payTo = resolvePayTo(cfg);
    const facilitator = new HTTPFacilitatorClient({
      url: cfg.facilitatorUrl,
      createAuthHeaders: async () => {
        const h: Record<string, string> = cfg.x402ApiKey ? { "X-API-Key": cfg.x402ApiKey } : {};
        return { verify: h, settle: h, supported: h };
      },
    });
    const server = new x402ResourceServer(facilitator);
    server.register("eip155:*", new ExactEvmScheme());
    server.registerExtension(builderCodeResourceServerExtension);
    // Durable intent precedes the external settlement side effect. If its later
    // receipt write fails, this remains visibly unresolved instead of counting a sale.
    server.onBeforeSettle(async ctx => {
      try {
        await ledger.append({
          kind: "customer_pending", endpoint: "x402",
          usd: Number(ctx.requirements.amount) / 1e6, asset: ctx.requirements.asset,
          ok: false, reportId: reportContext.getStore()?.reportId,
        });
      } catch {
        // x402 logs and ignores thrown hook errors. Its explicit abort contract is required.
        return { abort: true, reason: "receipt_authority_unavailable", message: "Payment was not submitted: durable receipt intent unavailable." };
      }
      return undefined;
    });
    // The only place a customer payment is counted as real: after the facilitator confirms settlement.
    server.onAfterSettle(async (ctx) => {
      if (!ctx.result.success) return;
      try { await ledger.append({
        kind: "settled",
        endpoint: "x402",
        usd: Number(ctx.requirements.amount) / 1e6,
        tx: ctx.result.transaction,
        payer: ctx.result.payer,
        asset: ctx.requirements.asset,
        ok: true,
        reportId: reportContext.getStore()?.reportId,
      }); } catch {
        // Settlement may already be irreversible. Keep the durable pending intent,
        // do not retry, and never claim that this customer was not charged.
        deps.onUnexpectedError?.();
      }
    });
    app.use(paymentMiddleware(buildRoutes(cfg, payTo), server));
  }

  // ---- paid routes ----
  const paid = (tier: Tier) => async (req: Request, res: Response) => {
    try {
      const request = (deps.parseReportRequest ?? parseRequest)(req.body);
      // Even cached reports need durable generated/customer evidence before settlement.
      if (!await ledger.ready(cfg.dailySpendCapUsd)) throw new SpendCapError("Shared authority unavailable.");
      const { report, paidCalls, warnings, cached, diagnostics } = await agent.run(request, tier);
      // "generated" is NOT a sale: the customer's payment settles after this handler returns.
      const payload = { report, evidence: { builderCode: cfg.builderCode, agentId: cfg.agentId || null, cached, supplierPurchases: paidCalls, ...(diagnostics ? { responseShapes: diagnostics } : {}) }, warnings };
      const validated = deps.validateReportResponse ? deps.validateReportResponse(payload) : payload;
      await ledger.append({ kind: "generated", endpoint: `/api/${tier}`, usd: 0, ok: true,
        reportId: reportContext.getStore()?.reportId, note: cached ? "cache hit" : undefined });
      res.json(validated);
    } catch (e) {
      // 4xx/5xx here means the x402 middleware does NOT settle the buyer's payment.
      if (e instanceof ValidationError) return void res.status(400).json({ error: e.message });
      if (e instanceof SpendCapError) return void res.status(503).json({ error: "temporarily unavailable: spend limit reached, you were not charged" });
      if (e instanceof ReportError) return void res.status(502).json({ error: e.message, note: "you were not charged" });
      deps.onUnexpectedError?.();
      res.status(500).json({ error: "internal error, you were not charged" });
    }
  };
  app.post("/api/pulse", paid("pulse"));
  app.post("/api/audit", paid("audit"));

  // Malformed JSON and similar: clean 4xx instead of a stack trace. (4xx = the buyer is not charged.)
  app.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    const status = (err as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return void res.status(status).json({ error: "invalid request body, send JSON like {\"project\":\"Name\"}" });
    }
    next(err);
  });

  return app;
}

// ---- entrypoint ----
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""));
if (isMain) {
  const cfg = loadConfig();
  const check = checkRepoMatchesCode(cfg.builderCode, cfg.githubRepo);
  if (check.status === "mismatch") {
    console.error(`\n[${cfg.requireRepoMatch ? "ERROR" : "warn"}] GITHUB_REPO=${check.repo} derives ${check.derived}, but BUILDER_CODE is ${check.expected}.`);
    console.error("That is fine ONLY if your code was issued independently of the repo. If it is repo-derived, tagged transactions credit nobody.\n");
    if (cfg.requireRepoMatch) process.exit(1);
  }
  if (check.status === "skipped") console.warn(`[warn] ${check.reason}: run \`npm run check-tag\` once to confirm your tag matches your repo.`);
  if (cfg.devNoPaywall) console.warn("[warn] DEV_NO_PAYWALL=1: x402 is OFF. Never run production like this.");
  if (cfg.mockBuy) console.warn("[warn] MOCK_BUY=1: serving fixture data, nothing is being bought.");
  if (!cfg.devNoPaywall && !cfg.x402ApiKey) console.warn("[warn] X402_API_KEY is empty: /verify works but the first /settle will fail with 401.");
  createApp(cfg).listen(cfg.port, () => console.log(`GrowthScout listening on :${cfg.port}  (${cfg.publicUrl})`));
}
