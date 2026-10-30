import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg, { type Pool } from "pg";
import { PgLedger, UnconfiguredLedger } from "../src/pg-ledger.js";
import { SpendCapError, heldUsd, type BudgetLedger, type LedgerEntry } from "../src/ledger.js";
import { BuyClient, newSpend } from "../src/buy.js";
import { loadConfig } from "../src/config.js";
import { generatePrivateKey } from "viem/accounts";
import { createApp } from "../src/server.js";
import express from "express";
import { mockResponse } from "../src/mock.js";
import { classifyManualReviews } from "../src/alerting.js";

const tx = `0x${"ab".repeat(32)}`;
const endpoint = "https://gateway.usebuy.ai/v1/social/x/posts/search";

/** Real PostgreSQL, synthetic wallets, fake suppliers/facilitator; never a payment. */
test("shared authority integration", { skip: !process.env.DATABASE_URL }, async t => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID().replaceAll("-", "");
  const role = `gs_test_${suffix}`; // Strictly generated identifier, never user input.
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT ON public.growth_wallets TO ${role}`);
  await admin.query(`GRANT SELECT, INSERT ON public.growth_evidence TO ${role}`);
  const pools: Pool[] = [];
  const wallets: string[] = [];
  t.after(async () => {
    await Promise.all(pools.map(p => p.end()));
    await admin.query("DELETE FROM public.growth_evidence WHERE wallet=ANY($1::text[])", [wallets]);
    await admin.query("DELETE FROM public.growth_wallets WHERE wallet=ANY($1::text[])", [wallets]);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  });
  function pool() {
    const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}`, max: 8 });
    pools.push(p);
    return p;
  }
  async function fixture(cap = 22500) {
    const wallet = `test:${suffix}:${randomUUID()}`, authority = randomUUID();
    wallets.push(wallet);
    await admin.query(`INSERT INTO public.growth_wallets(wallet,authority,daily_micro,enabled,reconciled)
      VALUES($1,$2,$3,true,true)`, [wallet, authority, cap]);
    const p = pool();
    return { wallet, authority, p, ledger: new PgLedger("", wallet, authority, p) };
  }
  // Inject write/commit acknowledgement failures while retaining real transactions/locks.
  function faultPool(p: Pool, fail: (sql: string) => "before" | "after" | undefined): Pool {
    return new Proxy(p, {
      get(target, property) {
        if (property !== "connect") {
          const v = Reflect.get(target, property);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return async () => {
          const c = await p.connect();
          return {
            release: () => c.release(),
            query: async (sql: string, params?: unknown[]) => {
              const mode = fail(sql);
              if (mode === "before") throw new Error("injected write failure");
              const result = await c.query(sql, params);
              if (mode === "after") throw new Error("injected lost acknowledgement");
              return result;
            },
          };
        };
      },
    });
  }
  await t.test("independent replicas share exactly one wallet cap; configuration drift fails closed", async () => {
    const f = await fixture();
    const replica = new PgLedger("", f.wallet, f.authority, pool());
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? replica : f.ledger).reserve(.0075, .0225)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 3);
    assert.equal(await replica.spentToday(), .0225);
    await assert.rejects(replica.reserve(.0075, .03), SpendCapError);
    assert.equal(await replica.ready(.03), false);
    assert.equal(await new PgLedger("", f.wallet, randomUUID(), pool()).ready(), false);
    assert.equal(await new PgLedger("", f.wallet, f.authority, admin).ready(), false, "migration owner must not sign");
    await assert.rejects(new UnconfiguredLedger().reserve(), SpendCapError);
  });
  await t.test("unfinished and uncertain payments survive restart and UTC midnight", async () => {
    const f = await fixture();
    const a = await f.ledger.reserve(.0075, .0225);
    const b = await f.ledger.reserve(.0075, .0225);
    await f.ledger.append({ kind: "spend", reservationId: b.id, endpoint, usd: .005,
      capUsd: .0075, ok: false, uncertain: true });
    // Test-only timestamp adjustment, never a runtime operation.
    await admin.query("UPDATE public.growth_evidence SET ts=ts-interval '2 days' WHERE wallet=$1", [f.wallet]);
    const restarted = new PgLedger("", f.wallet, f.authority, pool());
    await a();
    assert.equal(await restarted.spentToday(), .015);
    const c = await restarted.reserve(.0075, .0225);
    await assert.rejects(restarted.reserve(.0075, .0225), SpendCapError);
    await restarted.append({ kind: "spend", reservationId: c.id, endpoint, usd: .005,
      capUsd: .005, ok: true, tx });
    const tomorrow = new Date(Date.now() + 86400000);
    assert.equal(await restarted.spentToday(tomorrow), .015, "known old payments expire; unknown ones do not");
  });
  await t.test("failed reservation writes never launch a supplier; lost commit ACK keeps funds held", async () => {
    const f = await fixture(7500);
    let calls = 0;
    const cfg = { ...loadConfig(), privateKey: generatePrivateKey(), reportPurchasesEnabled: true,
      mockBuy: false, dailySpendCapUsd: .0075 };
    const broken = new PgLedger("", f.wallet, f.authority,
      faultPool(f.p, sql => sql.includes("INSERT INTO") ? "before" : undefined));
    await assert.rejects(new BuyClient(cfg, broken, async () => {
      calls++; throw new Error("must not run");
    }).search("x", "Acme", newSpend()), SpendCapError);
    assert.equal(calls, 0);
    assert.equal(await f.ledger.spentToday(), 0);
    const uncertainCommit = new PgLedger("", f.wallet, f.authority,
      faultPool(f.p, sql => sql === "COMMIT" ? "after" : undefined));
    await assert.rejects(uncertainCommit.reserve(.0075, .0075), SpendCapError);
    assert.equal(await new PgLedger("", f.wallet, f.authority, pool()).spentToday(), .0075);
  });
  await t.test("receipt-write failure after a supplier response cannot release or retry funds", async () => {
    const f = await fixture(7500);
    const broken = new PgLedger("", f.wallet, f.authority,
      faultPool(f.p, sql => sql.includes("INSERT INTO") && inserted ? "before" : undefined));
    let inserted = false, calls = 0;
    const cfg = { ...loadConfig(), privateKey: generatePrivateKey(), reportPurchasesEnabled: true,
      mockBuy: false, dailySpendCapUsd: .0075 };
    const buyer = new BuyClient(cfg, broken, async () => {
      inserted = true; calls++;
      return { code: 0, stdout: '{"data":[]}', stderr: JSON.stringify({ transaction: tx, amount: "5000" }) };
    });
    await assert.rejects(buyer.search("x", "Acme", newSpend()), SpendCapError);
    assert.equal(await f.ledger.spentToday(), .0075);
    await assert.rejects(buyer.search("x", "Acme", newSpend()), SpendCapError);
    assert.equal(calls, 1);
  });
  await t.test("evidence is append-only and customer generation is not a sale", async () => {
    const f = await fixture();
    const reportId = randomUUID();
    await f.ledger.append({ kind: "generated", endpoint: "/api/audit", usd: 0, ok: true, reportId });
    await f.ledger.append({ kind: "customer_pending", endpoint: "x402", usd: .1, asset: "usdc", ok: false, reportId });
    assert.equal((await f.ledger.summary()).customers.confirmedPayments, 0);
    assert.equal((await f.ledger.summary()).customers.settlementsNeedingReview, 1);
    const receipt = { kind: "settled" as const, endpoint: "x402", usd: .1, asset: "usdc", ok: true, reportId, tx };
    await f.ledger.append(receipt);
    await f.ledger.append(receipt);
    assert.equal((await f.ledger.summary()).customers.confirmedPayments, 1);
    assert.equal((await f.ledger.summary()).customers.settlementsNeedingReview, 0);
    await assert.rejects(f.p.query("UPDATE public.growth_evidence SET entry='{}' WHERE wallet=$1", [f.wallet]), /permission denied/);
    await assert.rejects(f.p.query("DELETE FROM public.growth_evidence WHERE wallet=$1", [f.wallet]), /permission denied/);
    await assert.rejects(f.p.query("TRUNCATE public.growth_evidence"), /permission denied/);
    await assert.rejects(f.p.query("UPDATE public.growth_wallets SET daily_micro=1000000 WHERE wallet=$1", [f.wallet]), /permission denied/);
  });
  await t.test("signer consumes each shared reservation once, even in competing processes", async () => {
    const f = await fixture();
    const reservation = await f.ledger.reserve(.0075, .0225);
    const source = new URL("../src/signer-budget-gate.mjs", import.meta.url).href;
    const script = `import {claimSignerReservation} from ${JSON.stringify(source)};
      try { await claimSignerReservation(process.argv[1],process.argv[2],.0075); console.log("claimed"); }
      catch { console.log("refused"); }`;
    function worker() {
      return new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.wallet, endpoint], {
          env: { PATH: process.env.PATH, HOME: process.env.HOME,
            BUDGET_DATABASE_URL: process.env.DATABASE_URL, BUDGET_AUTHORITY_ID: f.authority,
            BUDGET_RESERVATION_ID: reservation.id, PGOPTIONS: `-c role=${role}` },
        });
        let output = "";
        child.stdout.on("data", b => { output += String(b); });
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error("Claim worker failed")));
      });
    }
    const outputs = await Promise.all([worker(), worker(), worker()]);
    assert.equal(outputs.filter(s => s === "claimed").length, 1);
    assert.equal(outputs.filter(s => s === "refused").length, 2);
    assert.equal(await f.ledger.spentToday(), .0075);
  });
  await t.test("aged reviews alert once across replicas/restarts and stop after settlement", async () => {
    const f = await fixture();
    const unresolvedReservation = await f.ledger.reserve(.0075, .0225);
    const resolvedReservation = await f.ledger.reserve(.0075, .0225);
    await f.ledger.append({ kind: "spend", reservationId: resolvedReservation.id,
      endpoint, usd: .005, capUsd: .005, ok: true, tx });
    const unresolvedReport = randomUUID(), resolvedReport = randomUUID();
    for (const reportId of [unresolvedReport, resolvedReport]) {
      await f.ledger.append({ kind: "generated", endpoint: "/api/audit", usd: 0, ok: true, reportId });
      await f.ledger.append({ kind: "customer_pending", endpoint: "x402", usd: .1,
        asset: "usdc", ok: false, reportId });
    }
    await f.ledger.append({ kind: "settled", endpoint: "x402", usd: .1, asset: "usdc",
      ok: true, reportId: resolvedReport, tx: `0x${"cd".repeat(32)}` });
    await admin.query("UPDATE public.growth_evidence SET ts=clock_timestamp()-interval '30 minutes' WHERE wallet=$1", [f.wallet]);
    const secondReplica = new PgLedger("", f.wallet, f.authority, pool());
    let delivered = 0;
    const callback = () => { delivered++; };
    const [first, second] = await Promise.all([
      f.ledger.scanAlerts(new Date(), undefined, callback),
      secondReplica.scanAlerts(new Date(), undefined, callback),
    ]);
    assert.equal(delivered, 2, "only the unresolved supplier reservation and customer intent alert");
    assert.equal(first.length + second.length, 2);
    assert.ok([...first, ...second].some(a => a.type === "supplier_reservation" && a.key === unresolvedReservation.id));
    assert.ok([...first, ...second].some(a => a.type === "customer_settlement" && a.key === unresolvedReport));
    assert.ok(![...first, ...second].some(a => a.key === resolvedReservation.id || a.key === resolvedReport));
    assert.equal((await new PgLedger("", f.wallet, f.authority, pool()).scanAlerts()).length, 0,
      "alert dedup markers survive constructing a fresh ledger");
    assert.equal((await f.ledger.all()).filter(e => e.kind === "alerted").length, 2);
  });
  await t.test("a failed alert delivery rolls back its marker and is retried", async () => {
    const f = await fixture();
    const reservation = await f.ledger.reserve(.0075, .0225);
    await admin.query("UPDATE public.growth_evidence SET ts=clock_timestamp()-interval '1 hour' WHERE wallet=$1", [f.wallet]);
    await assert.rejects(f.ledger.scanAlerts(new Date(), undefined, () => { throw new Error("log sink unavailable"); }), SpendCapError);
    assert.equal((await f.ledger.all()).filter(e => e.kind === "alerted").length, 0);
    const retried = await new PgLedger("", f.wallet, f.authority, pool()).scanAlerts();
    assert.equal(retried.length, 1);
    assert.equal(retried[0]!.key, reservation.id);
  });
});

test("held budget is independent of timestamp ties or evidence order", () => {
  const now = new Date("2026-10-27T00:00:00.000Z");
  const reserve: LedgerEntry = { ts: now.toISOString(), kind: "reserved", reservationId: "id", capUsd: .0075, endpoint, usd: 0, ok: false };
  const known: LedgerEntry = { ...reserve, kind: "spend", usd: .005, capUsd: .005, ok: true, tx };
  assert.equal(heldUsd([known, reserve], now), .005);
  assert.equal(heldUsd([reserve, known], now), .005);
  assert.equal(heldUsd([reserve, { ...known, ok: false, uncertain: true }], new Date("2026-10-28T00:00:00Z")), .0075);
});

test("manual review thresholds ignore fresh items and classify settled evidence as resolved", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const reservation = randomUUID(), freshReservation = randomUUID();
  const unresolvedReport = randomUUID(), resolvedReport = randomUUID();
  const base = (kind: LedgerEntry["kind"], id: string, ts: string): LedgerEntry => ({
    ts, kind, endpoint: "synthetic", usd: 0, ok: false,
    ...(kind === "reserved" ? { reservationId: id, capUsd: .0075 } : { reportId: id }),
  });
  const entries: LedgerEntry[] = [
    base("reserved", reservation, "2026-10-27T11:40:00.000Z"),
    base("reserved", freshReservation, "2026-10-27T11:59:00.000Z"),
    base("customer_pending", unresolvedReport, "2026-10-27T11:50:00.000Z"),
    base("customer_pending", resolvedReport, "2026-10-27T11:50:00.000Z"),
    { ts: "2026-10-27T11:41:00.000Z", kind: "spend", endpoint: "synthetic",
      reservationId: reservation, usd: .005, capUsd: .005, ok: true, tx },
    { ...base("settled", resolvedReport, "2026-10-27T11:55:00.000Z"), ok: true, tx },
  ];
  const alerts = classifyManualReviews(entries, now, { supplierMs: 900_000, customerMs: 300_000 });
  assert.deepEqual(alerts.map(a => `${a.type}:${a.key}`), [`customer_settlement:${unresolvedReport}`]);
});

test("failed customer-intent persistence explicitly aborts x402 settlement", async t => {
  const cfg = { ...loadConfig(), privateKey: generatePrivateKey(), mockBuy: false,
    reportPurchasesEnabled: true, dailySpendCapUsd: .1, devNoPaywall: false };
  const payer = "0x1111111111111111111111111111111111111111";
  let settlements = 0, failIntent = true, failReceipt = false, alerts = 0;
  const entries: LedgerEntry[] = [];
  const ledger: BudgetLedger = {
    ready: async () => true, all: () => entries, spentToday: () => 0,
    summary: async () => ({ supplier: { paidCalls: 0, uncertainCalls: 0, totalSpentUsd: 0,
      amountsEstimatedFromCatalogue: 0, settlementTxs: [] },
    customers: { reportsGenerated: 0, confirmedPayments: 0, uniquePayers: 0, settlementTxs: [], settlementsNeedingReview: 0 } }),
    reserve: () => Object.assign(() => {}, { id: randomUUID() }),
    append: entry => {
      if ((entry.kind === "customer_pending" && failIntent) || (entry.kind === "settled" && failReceipt)) throw new Error("write failed");
      const full = { ...entry, ts: new Date().toISOString() };
      entries.push(full); return full;
    },
  };
  async function listen(app: ReturnType<typeof express>) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  const facilitator = express(); facilitator.use(express.json());
  facilitator.get("/supported", (_req, res) => res.json({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }], extensions: [], signers: { "eip155:42220": [payer] },
  }));
  facilitator.post("/verify", (_req, res) => res.json({ isValid: true, payer }));
  facilitator.post("/settle", (_req, res) => { settlements++; res.json({ success: true, transaction: tx, network: "eip155:42220", payer }); });
  cfg.facilitatorUrl = await listen(facilitator);
  const app = createApp(cfg, { ledger, onUnexpectedError: () => { alerts++; },
    buy: new BuyClient(cfg, ledger, async () => ({
      code: 0, stdout: JSON.stringify(mockResponse("x", "Acme")), stderr: JSON.stringify({ transaction: tx }),
    })) });
  const url = await listen(app);
  const post = (signature?: string) => fetch(url + "/api/pulse", { method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "payment-signature": signature } : {}) },
    body: JSON.stringify({ project: "Acme" }) });
  const challenge = await post();
  const required = JSON.parse(Buffer.from(challenge.headers.get("payment-required")!, "base64").toString());
  const signature = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource,
    accepted: required.accepts[0], payload: { signature: "0x00", authorization: { from: payer } } })).toString("base64");
  const refused = await post(signature);
  assert.notEqual(refused.status, 200);
  assert.equal(settlements, 0);
  failIntent = false; failReceipt = true;
  const response = await post(signature);
  assert.equal(response.status, 200);
  assert.equal(settlements, 1);
  assert.equal(alerts, 1);
  assert.equal(entries.filter(e => e.kind === "settled").length, 0);
  const intent = entries.find(e => e.kind === "customer_pending")!;
  assert.ok(intent.reportId);
  assert.ok(entries.some(e => e.kind === "generated" && e.reportId === intent.reportId));
});
