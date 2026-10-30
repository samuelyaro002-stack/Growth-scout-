import { randomUUID } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import { heldUsd, summarize, SpendCapError, type BudgetLedger, type LedgerEntry, type NewEntry, type Reservation, type OperationalAlert } from "./ledger.js";
import { ALERT_THRESHOLDS, classifyManualReviews } from "./alerting.js";

const unavailable = () => new SpendCapError("Shared spending authority unavailable or not approved; no purchase authorized.");
export function micro(usd: number): number {
  const n = Math.round(usd * 1e6);
  if (!Number.isFinite(usd) || usd < 0 || usd > 1000 || Math.abs(n / 1e6 - usd) > 1e-12) throw unavailable();
  return n;
}

/** Live ledger: no local-file fallback, no startup DDL, no automatic reconciliation/retries. */
export class PgLedger implements BudgetLedger {
  readonly pool: Pool;
  constructor(connectionString: string, readonly wallet: string, readonly authority: string, pool?: Pool) {
    this.pool = pool ?? new pg.Pool({
      connectionString, max: 5, connectionTimeoutMillis: 5000,
      statement_timeout: 10000, idle_in_transaction_session_timeout: 15000,
    });
  }
  private async policy(c: PoolClient) {
    // Runtime must be an append-only role, NOT the DB owner/migration role.
    const permissions = await c.query<{ safe: boolean }>(`
      SELECT NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolbypassrls
        AND has_table_privilege(current_user, 'public.growth_wallets', 'SELECT')
        AND NOT has_any_column_privilege(current_user, 'public.growth_wallets', 'INSERT,UPDATE')
        AND NOT has_table_privilege(current_user, 'public.growth_wallets', 'DELETE,TRUNCATE')
        AND has_table_privilege(current_user, 'public.growth_evidence', 'SELECT')
        AND has_table_privilege(current_user, 'public.growth_evidence', 'INSERT')
        AND NOT has_any_column_privilege(current_user, 'public.growth_evidence', 'UPDATE')
        AND NOT has_table_privilege(current_user, 'public.growth_evidence', 'DELETE,TRUNCATE')
        AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
        AND NOT EXISTS (SELECT 1 FROM pg_class t WHERE t.oid IN
          ('public.growth_wallets'::regclass,'public.growth_evidence'::regclass)
          AND pg_has_role(current_user,t.relowner,'MEMBER'))
        AS safe FROM pg_roles r WHERE r.rolname=current_user`);
    if (!permissions.rows[0]?.safe) throw unavailable();
    const result = await c.query<{ daily_micro: string; authority: string; enabled: boolean; reconciled: boolean }>(
      "SELECT daily_micro, authority, enabled, reconciled FROM public.growth_wallets WHERE wallet=$1", [this.wallet]);
    const p = result.rows[0];
    if (!p || p.authority !== this.authority || !p.enabled || !p.reconciled) throw unavailable();
    return Number(p.daily_micro);
  }
  private async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    let c: PoolClient;
    try { c = await this.pool.connect(); } catch { throw unavailable(); }
    try {
      // Do not inherit repeatable-read snapshots or asynchronous commits from a DSN/role.
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await c.query("SET LOCAL synchronous_commit = on");
      // All API replicas/environments sharing this wallet serialize on the same authority.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [this.wallet]);
      const result = await fn(c);
      await c.query("COMMIT"); // Caller must not sign unless commit acknowledgement succeeds.
      return result;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      if (e instanceof SpendCapError) throw e;
      // Never leak a connection string, database details, provider output or signatures.
      throw unavailable();
    } finally { c.release(); }
  }
  private async read(c: PoolClient): Promise<LedgerEntry[]> {
    const result = await c.query<{ ts: Date; entry: NewEntry }>(
      "SELECT ts, entry FROM public.growth_evidence WHERE wallet=$1 ORDER BY ts, id", [this.wallet]);
    return result.rows.map(r => ({ ...r.entry, ts: r.ts.toISOString() }));
  }
  private async insert(c: PoolClient, entry: NewEntry, dedupe: string): Promise<LedgerEntry> {
    const result = await c.query<{ ts: Date }>(`
      INSERT INTO public.growth_evidence(id,wallet,kind,reservation_id,dedupe,entry,ts)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING ts`,
      [randomUUID(), this.wallet, entry.kind, entry.reservationId ?? null, dedupe, JSON.stringify(entry)]);
    return { ...entry, ts: result.rows[0]!.ts.toISOString() };
  }
  async ready(dailyCap?: number) {
    try {
      await this.transaction(async c => {
        const cap = await this.policy(c);
        if (dailyCap !== undefined && micro(dailyCap) !== cap) throw unavailable();
      });
      return true;
    }
    catch { return false; }
  }
  async reserve(maxUsd: number, dailyCap: number): Promise<Reservation> {
    const amount = micro(maxUsd);
    if (amount <= 0) throw unavailable();
    const id = randomUUID();
    await this.transaction(async c => {
      const cap = await this.policy(c);
      // Configuration drift may lower availability but must never raise the wallet cap.
      if (micro(dailyCap) !== cap) throw unavailable();
      const { rows } = await c.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const held = Math.round(heldUsd(await this.read(c), rows[0]!.now) * 1e6);
      if (held + amount > cap) throw new SpendCapError("Daily spend cap reached.");
      await this.insert(c, { kind: "reserved", endpoint: "supplier", usd: 0, capUsd: maxUsd, ok: false, reservationId: id }, `reserve:${id}`);
    });
    // A reservation ends only with durable, confirmed supplier evidence. No finally-release.
    return Object.assign(async () => {}, { id });
  }
  async append(entry: NewEntry): Promise<LedgerEntry> {
    micro(entry.usd);
    if (entry.capUsd !== undefined) micro(entry.capUsd);
    return this.transaction(async c => {
      await this.policy(c);
      if (!["spend", "generated", "settled", "customer_pending"].includes(entry.kind)) throw unavailable();
      const entries = await this.read(c);
      if (entry.kind === "spend") {
        const held = entries.find(e => e.kind === "reserved" && e.reservationId === entry.reservationId);
        if (!held || entry.capUsd === undefined || entry.capUsd > held.capUsd! || entry.usd > held.capUsd! ||
            (entry.ok && (!entry.tx || entry.uncertain))) throw unavailable();
        // Uncertain invocations retain the original maximum indefinitely, even after midnight.
      }
      if (entry.kind === "settled" && (!entry.ok || !entry.tx || !entry.reportId)) throw unavailable();
      if (entry.kind === "customer_pending" && (!entry.reportId ||
        !entries.some(e => e.kind === "generated" && e.reportId === entry.reportId))) throw unavailable();
      if (entry.kind === "settled" && !entries.some(e => e.kind === "customer_pending" &&
        e.reportId === entry.reportId && e.asset === entry.asset && e.usd === entry.usd)) throw unavailable();
      const dedupe = entry.kind === "spend" ? `spend:${entry.reservationId}` :
        entry.kind === "settled" ? `settled:${entry.asset}:${entry.tx?.toLowerCase()}` :
        `${entry.kind}:${entry.reportId ?? randomUUID()}`;
      const existing = entries.find(e => entry.kind === "settled" && e.kind === "settled" &&
        e.tx?.toLowerCase() === entry.tx?.toLowerCase() && e.asset === entry.asset);
      if (existing) return existing; // Facilitator replay is one sale, not two.
      return this.insert(c, entry, dedupe);
    });
  }
  async all() { return this.transaction(async c => { await this.policy(c); return this.read(c); }); }
  async spentToday(now?: Date) {
    return this.transaction(async c => {
      await this.policy(c);
      const { rows } = await c.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      return heldUsd(await this.read(c), now ?? rows[0]!.now);
    });
  }
  async summary() { return summarize(await this.all()); }
  async scanAlerts(
    now = new Date(),
    thresholds: { supplierMs?: number; customerMs?: number } = ALERT_THRESHOLDS,
    deliver?: (alert: OperationalAlert) => void,
  ): Promise<OperationalAlert[]> {
    return this.transaction(async c => {
      await this.policy(c);
      const entries = await this.read(c);
      const alreadyNotified = new Set(entries.filter(e => e.kind === "alerted")
        .map(e => e.alertKey).filter((key): key is string => Boolean(key)));
      const candidates = classifyManualReviews(entries, now, thresholds)
        .filter(alert => !alreadyNotified.has(`${alert.type}:${alert.key}`));
      const emitted: OperationalAlert[] = [];
      for (const alert of candidates) {
        // Deliver while holding the shared lock and before recording dedup evidence.
        // If the local logger throws, the transaction rolls back and the next scan retries.
        deliver?.(alert);
        // The shared advisory lock + unique dedupe key allow only one replica to emit.
        await this.insert(c, {
          kind: "alerted", endpoint: "operator-alert", usd: 0, ok: true,
          alertType: alert.type, alertKey: `${alert.type}:${alert.key}`,
          ageSeconds: alert.ageSeconds,
        }, `alert:${alert.type}:${alert.key}`);
        emitted.push(alert);
      }
      return emitted;
    });
  }
}

/** Missing explicit shared configuration must not create a fresh local budget. */
export class UnconfiguredLedger implements BudgetLedger {
  async ready() { return false; }
  async all(): Promise<LedgerEntry[]> { throw unavailable(); }
  async reserve(): Promise<Reservation> { throw unavailable(); }
  async append(): Promise<LedgerEntry> { throw unavailable(); }
  async spentToday(): Promise<number> { throw unavailable(); }
  async summary(): Promise<ReturnType<typeof summarize>> { throw unavailable(); }
}
