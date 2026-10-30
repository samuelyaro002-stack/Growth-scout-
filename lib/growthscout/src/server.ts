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
import { assertValidCode } from "./tag.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PgLedger, UnconfiguredLedger } from "./pg-ledger.js";
import type { BudgetLedger } from "./ledger.js";
import type { OperationalAlert } from "./ledger.js";
import { safeAlertPayload } from "./alerting.js";

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

export interface AppDeps {
  onUnexpectedError?: () => void;
  onOperationalAlert?: (alert: Record<string, unknown>) => void;
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
  const ledger: BudgetLedger = deps.ledger ?? (cfg.mockBuy ? new Ledger(cfg.dataDir) :
    cfg.budgetDatabaseUrl && cfg.budgetAuthorityId && cfg.privateKey ?
      new PgLedger(cfg.budgetDatabaseUrl,
        `eip155:42220:${privateKeyToAccount(cfg.privateKey as `0x${string}`).address.toLowerCase()}`,
        cfg.budgetAuthorityId) : new UnconfiguredLedger());
  const buy = deps.buy ?? new BuyClient(cfg, ledger);
  const agent = new GrowthAgent(buy, cfg.mockBuy);
  if (ledger.scanAlerts) {
    let scanning = false;
    let scanFailureAlerted = false;
    const scan = async () => {
      if (scanning) return;
      scanning = true;
      try {
        const alerts = await ledger.scanAlerts!(undefined, undefined, alert => {
          deps.onOperationalAlert?.(safeAlertPayload(alert));
        });
        scanFailureAlerted = false;
        void alerts;
      } catch {
        if (!scanFailureAlerted) {
          scanFailureAlerted = true;
          const alert: OperationalAlert = {
            type: "supplier_reservation", key: "shared-ledger-unavailable",
            ageSeconds: 0, thresholdSeconds: 0, severity: "critical",
          };
          try {
            deps.onOperationalAlert?.({
              event: "growthscout_manual_review", type: "alert_scan_unavailable",
              severity: alert.severity,
            });
          } catch { /* do not let log failures affect app startup */ }
        }
      } finally { scanning = false; }
    };
    void scan();
    const timer = setInterval(() => { void scan(); }, 60_000);
    timer.unref();
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  const reportContext = new AsyncLocalStorage<{ reportId: string }>();
  app.use((_req, _res, next) => reportContext.run({ reportId: randomUUID() }, next));

  // ---- free routes (registered before the paywall) ----
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

