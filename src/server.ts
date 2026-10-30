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
      description: "GrowthScout pulse: live X snapshot, Africa share, sentiment and a 0-100 growth score for a Web3 project",
      mimeType: "application/json",
      extensions: ext,
    },
    "POST /api/audit": {
      accepts: buildAccepts(cfg, cfg.priceAuditUsd, payTo),
      description: "GrowthScout audit: X + Reddit + YouTube, Africa-market gap analysis and a prioritised growth plan",
      mimeType: "application/json",
      extensions: ext,
    },
  } as RoutesConfig;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function landing(cfg: Config): string {
  const base = esc(cfg.publicUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GrowthScout</title>
<style>
:root{--bg:#fbfaf6;--fg:#1a1a17;--mut:#6b6a63;--acc:#0b7a4b;--card:#fff;--line:#e4e1d6}
@media (prefers-color-scheme:dark){:root{--bg:#121410;--fg:#eceae0;--mut:#9c9a8e;--acc:#4cd694;--card:#1a1d17;--line:#2c3027}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px}
h1{font-size:2rem;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
code,pre{font:13px ui-monospace,monospace}pre{overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
.price{color:var(--acc);font-weight:600}a{color:var(--acc)}
</style></head><body><main>
<h1>GrowthScout</h1>
<p class="sub">Growth intelligence for Web3 projects, with an Africa lens. Pay per report in stablecoins on Celo. No account, no API key.</p>
<div class="card"><b>Pulse</b> <span class="price">$${cfg.pricePulseUsd.toFixed(2)}</span><br>Live X snapshot, Africa-mention share, sentiment and a 0-100 growth score.<pre>POST ${base}/api/pulse
{"project":"Celo","handle":"@Celo_Org"}</pre></div>
<div class="card"><b>Audit</b> <span class="price">$${cfg.priceAuditUsd.toFixed(2)}</span><br>X + Reddit + YouTube, Africa gap analysis and a prioritised growth plan.<pre>POST ${base}/api/audit
{"project":"Celo","keywords":["MiniPay"]}</pre></div>
<div class="card">Pay with any x402 client. With <a href="https://usebuy.ai">buy</a>:<pre>buy curl --max-amount 0.12 -X POST \\
  -H 'Content-Type: application/json' \\
  --data '{"project":"YourProject"}' \\
  ${base}/api/audit</pre>Not ready to pay? <a href="/api/sample">See a free sample report</a> (fixture data, clearly labelled).</div>
<p class="sub">Every paid report is built from data we buy live through <a href="https://usebuy.ai">buy</a>. <a href="/api/receipts">Public ledger</a> · <a href="/.well-known/agent.json">ERC-8004 identity</a></p>
</main></body></html>`;
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
  app.get("/health", async (_req, res) => {
    const budgetReady = await ledger.ready(cfg.dailySpendCapUsd);
    res.json({ ok: true, mock: cfg.mockBuy, paywall: !cfg.devNoPaywall, purchasesEnabled: cfg.reportPurchasesEnabled && budgetReady, agentId: cfg.agentId || null });
  });
  app.get("/.well-known/agent.json", (_req, res) => res.json(buildRegistrationFile(cfg)));
  app.get("/api/growthscout/health", async (_req, res) => {
    const budgetReady = await ledger.ready(cfg.dailySpendCapUsd);
    res.json({ ok: true, mock: cfg.mockBuy, paywall: !cfg.devNoPaywall,
      purchasesEnabled: cfg.reportPurchasesEnabled && budgetReady,
      budgetReady, agentId: cfg.agentId || null });
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
      const { report, paidCalls, warnings, cached } = await agent.run(request, tier);
      // "generated" is NOT a sale: the customer's payment settles after this handler returns.
      const payload = { report, evidence: { builderCode: cfg.builderCode, agentId: cfg.agentId || null, cached, supplierPurchases: paidCalls }, warnings };
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
