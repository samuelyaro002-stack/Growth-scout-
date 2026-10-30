import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface LedgerEntry {
  ts: string;
  kind: "spend" | "generated" | "settled" | "reserved" | "released" | "launched" | "customer_pending" | "alerted";
  endpoint: string;
  usd: number;
  capUsd?: number;
  estimated?: boolean;
  tx?: string;
  payer?: string;
  asset?: string;
  ok: boolean;
  uncertain?: boolean;
  note?: string;
  reservationId?: string;
  reportId?: string;
  alertKey?: string;
  alertType?: "supplier_reservation" | "customer_settlement";
  ageSeconds?: number;
}
export type NewEntry = Omit<LedgerEntry, "ts">;
export type Reservation = (() => void | Promise<void>) & { id: string };
export interface BudgetLedger {
  append(entry: NewEntry): LedgerEntry | Promise<LedgerEntry>;
  reserve(maxUsd: number, dailyCap: number): Reservation | Promise<Reservation>;
  all(): LedgerEntry[] | Promise<LedgerEntry[]>;
  spentToday(now?: Date): number | Promise<number>;
  summary(): ReturnType<typeof summarize> | Promise<ReturnType<typeof summarize>>;
  ready(dailyCap?: number): Promise<boolean>;
  scanAlerts?(
    now?: Date,
    thresholds?: { supplierMs?: number; customerMs?: number },
    deliver?: (alert: OperationalAlert) => void,
  ): Promise<OperationalAlert[]>;
}
export interface OperationalAlert {
  type: "supplier_reservation" | "customer_settlement";
  key: string;
  ageSeconds: number;
  thresholdSeconds: number;
  severity: "warning" | "critical";
}
export function summarize(entries: LedgerEntry[]) {
  const spends = entries.filter(e => e.kind === "spend");
  const okSpends = spends.filter(e => e.ok);
  const settled = entries.filter(e => e.kind === "settled" && e.ok);
  return {
    supplier: {
      paidCalls: okSpends.length,
      uncertainCalls: spends.filter(e => e.uncertain).length,
      totalSpentUsd: Number(okSpends.reduce((s, e) => s + e.usd, 0).toFixed(6)),
      amountsEstimatedFromCatalogue: okSpends.filter(e => e.estimated).length,
      settlementTxs: okSpends.map(e => e.tx).filter(Boolean),
    },
    customers: {
      reportsGenerated: entries.filter(e => e.kind === "generated").length,
      confirmedPayments: settled.length,
      uniquePayers: new Set(settled.map(e => e.payer?.toLowerCase()).filter(Boolean)).size,
      settlementTxs: settled.map(e => e.tx).filter(Boolean),
      settlementsNeedingReview: entries.filter(e => e.kind === "customer_pending" &&
        !settled.some(s => s.reportId === e.reportId)).length,
    },
  };
}
export function heldUsd(entries: LedgerEntry[], now: Date) {
  const day = now.toISOString().slice(0, 10);
  const pending = new Map<string, LedgerEntry>();
  let total = 0;
  for (const e of entries) {
    if (e.kind === "reserved" && e.reservationId) pending.set(e.reservationId, e);
  }
  for (const e of entries) {
    // Unknown settlements are NEVER released by the clock or a failed invocation.
    if (e.kind === "spend" && e.ok && !e.uncertain && e.reservationId) pending.delete(e.reservationId);
    if (e.kind === "spend" && e.ok && !e.uncertain && e.ts.startsWith(day)) total += e.capUsd ?? e.usd;
  }
  for (const e of pending.values()) total += e.capUsd ?? e.usd;
  return total;
}
export class SpendCapError extends Error {
  constructor(message: string) { super(message); this.name = "SpendCapError"; }
}
export class Ledger {
  readonly file: string;
  private readonly lock: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, "ledger.jsonl");
    this.lock = join(dataDir, "ledger.lock");
  }
  async ready() { return true; } // Fixture/legacy reader only; never selected for live purchases.
  private transact<T>(fn: () => T): T {
    try { mkdirSync(this.lock, { mode: 0o700 }); }
    catch { throw new SpendCapError("Budget ledger is busy or requires recovery; no purchase was authorized."); }
    try { return fn(); } finally { rmdirSync(this.lock); }
  }
  private write(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
    const full = { ...entry, ts: new Date().toISOString() };
    const fd = openSync(this.file, "a", 0o600);
    try { appendFileSync(fd, JSON.stringify(full) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    return full;
  }
  append(entry: Omit<LedgerEntry, "ts">) { return this.transact(() => this.write(entry)); }
  all(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    // Corrupt or truncated evidence must fail closed, never silently remove spending.
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map(line => {
      const entry = JSON.parse(line) as LedgerEntry;
      if (typeof entry.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(entry.ts) || !Number.isFinite(Date.parse(entry.ts)) ||
          !Number.isFinite(entry.usd) || entry.usd < 0 ||
          (entry.capUsd !== undefined && (!Number.isFinite(entry.capUsd) || entry.capUsd < 0)) ||
          (entry.kind === "reserved" && (!entry.reservationId || !(entry.capUsd! > 0))) ||
          !["spend", "generated", "settled", "reserved", "released", "launched", "customer_pending"].includes(entry.kind)) {
        throw new SpendCapError("Budget ledger is invalid; manual recovery is required.");
      }
      return entry;
    });
  }
  spentToday(now = new Date()) {
    return heldUsd(this.all(), now);
  }
  reserve(maxUsd: number, dailyCap: number): (() => void) & { id: string } {
    if (!Number.isFinite(maxUsd) || maxUsd <= 0 || !Number.isFinite(dailyCap) || dailyCap < 0) {
      throw new SpendCapError("Invalid spending limit.");
    }
    const id = randomUUID();
    this.transact(() => {
      if (this.spentToday() + maxUsd > dailyCap + 1e-9) throw new SpendCapError("Daily spend cap reached.");
      this.write({ kind: "reserved", endpoint: "supplier", usd: 0, capUsd: maxUsd, ok: false, reservationId: id });
    });
    let released = false;
    const release = () => {
      if (released) return;
      // An exception/crash before durable settlement evidence must not free money.
      this.transact(() => {
        if (this.all().some(e => e.kind === "spend" && e.reservationId === id)) {
          this.write({ kind: "released", endpoint: "supplier", usd: 0, ok: true, reservationId: id });
          released = true;
        }
      });
    };
    return Object.assign(release, { id });
  }
  get inFlightUsd() {
    const pending = new Map<string, number>();
    for (const e of this.all()) {
      if (e.kind === "reserved" && e.reservationId) pending.set(e.reservationId, e.capUsd ?? 0);
      if (e.kind === "spend" && e.ok && !e.uncertain && e.reservationId) pending.delete(e.reservationId);
    }
    return [...pending.values()].reduce((s, n) => s + n, 0);
  }
  summary() {
    return summarize(this.all());
  }
}
