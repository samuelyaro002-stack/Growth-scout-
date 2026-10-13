import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Three kinds of evidence, kept apart on purpose so one can never imply another:
 *   spend     we paid a supplier through buy
 *   generated we produced a report (says nothing about whether the customer's payment settled)
 *   settled   the x402 facilitator confirmed a customer payment, with the settlement tx hash
 */
export interface LedgerEntry {
  ts: string;
  kind: "spend" | "generated" | "settled";
  /** what was bought (gateway URL) or sold (our route) */
  endpoint: string;
  /** best estimate of the amount actually moved, USD */
  usd: number;
  /** worst case this entry could have cost. Used by the caps. Defaults to usd. */
  capUsd?: number;
  /** true when usd is the catalogue price because buy's quote could not be read */
  estimated?: boolean;
  /** settlement tx hash */
  tx?: string;
  payer?: string;
  asset?: string;
  ok: boolean;
  /** true when we cannot tell whether money moved. Never retry these. */
  uncertain?: boolean;
  note?: string;
}

export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapError";
  }
}

export class Ledger {
  readonly file: string;
  /** budget held by purchases that are in flight right now */
  private reservedUsd = 0;

  constructor(dataDir: string) {
    this.file = join(dataDir, "ledger.jsonl");
    mkdirSync(dirname(this.file), { recursive: true });
  }

  append(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
    const full: LedgerEntry = { ts: new Date().toISOString(), ...entry };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }

  all(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LedgerEntry;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is LedgerEntry => e !== undefined);
  }

  /** Worst-case USD spent in the current UTC day (uncertain calls count as spent). */
  spentToday(now = new Date()): number {
    const day = now.toISOString().slice(0, 10);
    return this.all()
      .filter((e) => e.kind === "spend" && e.ts.startsWith(day) && (e.ok || e.uncertain))
      .reduce((sum, e) => sum + (e.capUsd ?? e.usd), 0);
  }

  /**
   * Atomically hold `maxUsd` of today's budget for a purchase that is about to start.
   * The check and the hold happen in one synchronous step, so concurrent requests cannot
   * both squeeze under the cap. Always call the returned release() when the purchase ends.
   */
  reserve(maxUsd: number, dailyCap: number): () => void {
    if (this.spentToday() + this.reservedUsd + maxUsd > dailyCap + 1e-9) {
      throw new SpendCapError(`daily spend cap $${dailyCap.toFixed(2)} reached`);
    }
    this.reservedUsd += maxUsd;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedUsd = Math.max(0, this.reservedUsd - maxUsd);
    };
  }

  get inFlightUsd(): number {
    return this.reservedUsd;
  }

  summary() {
    const entries = this.all();
    const spends = entries.filter((e) => e.kind === "spend");
    const okSpends = spends.filter((e) => e.ok);
    const settled = entries.filter((e) => e.kind === "settled" && e.ok);
    return {
      supplier: {
        paidCalls: okSpends.length,
        uncertainCalls: spends.filter((e) => e.uncertain).length,
        totalSpentUsd: Number(okSpends.reduce((s, e) => s + e.usd, 0).toFixed(6)),
        amountsEstimatedFromCatalogue: okSpends.filter((e) => e.estimated).length,
        settlementTxs: okSpends.map((e) => e.tx).filter((t): t is string => Boolean(t)),
      },
      customers: {
        reportsGenerated: entries.filter((e) => e.kind === "generated").length,
        confirmedPayments: settled.length,
        uniquePayers: new Set(settled.map((e) => e.payer?.toLowerCase()).filter(Boolean)).size,
        settlementTxs: settled.map((e) => e.tx).filter((t): t is string => Boolean(t)),
      },
    };
  }
}
