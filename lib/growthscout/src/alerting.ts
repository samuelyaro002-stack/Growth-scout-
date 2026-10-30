import type { LedgerEntry, OperationalAlert } from "./ledger.js";

export const ALERT_THRESHOLDS = {
  supplierMs: 15 * 60_000,
  customerMs: 5 * 60_000,
} as const;

/** Classify durable open incidents only. No provider payloads or customer data escape. */
export function classifyManualReviews(
  entries: LedgerEntry[],
  now: Date,
  thresholds: { supplierMs?: number; customerMs?: number } = ALERT_THRESHOLDS,
): OperationalAlert[] {
  const supplierMs = thresholds.supplierMs ?? ALERT_THRESHOLDS.supplierMs;
  const customerMs = thresholds.customerMs ?? ALERT_THRESHOLDS.customerMs;
  const completedReservations = new Set(entries
    .filter(e => e.kind === "spend" && e.ok && !e.uncertain)
    .map(e => e.reservationId).filter((id): id is string => Boolean(id)));
  const confirmedReports = new Set(entries
    .filter(e => e.kind === "settled" && e.ok)
    .map(e => e.reportId).filter((id): id is string => Boolean(id)));
  const alerts: OperationalAlert[] = [];
  for (const entry of entries) {
    if (entry.kind === "reserved" && entry.reservationId &&
      !completedReservations.has(entry.reservationId)) {
      const age = Math.floor((now.getTime() - Date.parse(entry.ts)) / 1000);
      if (age >= Math.ceil(supplierMs / 1000)) alerts.push({
        type: "supplier_reservation", key: entry.reservationId,
        ageSeconds: Math.max(0, age), thresholdSeconds: Math.ceil(supplierMs / 1000),
        severity: age >= Math.ceil(supplierMs / 1000) * 4 ? "critical" : "warning",
      });
    }
    if (entry.kind === "customer_pending" && entry.reportId && !confirmedReports.has(entry.reportId)) {
      const age = Math.floor((now.getTime() - Date.parse(entry.ts)) / 1000);
      if (age >= Math.ceil(customerMs / 1000)) alerts.push({
        type: "customer_settlement", key: entry.reportId,
        ageSeconds: Math.max(0, age), thresholdSeconds: Math.ceil(customerMs / 1000),
        severity: age >= Math.ceil(customerMs / 1000) * 4 ? "critical" : "warning",
      });
    }
  }
  return alerts;
}

/** Safe, bounded operator log payload. Keys are internal UUIDs; never include tx or payment data. */
export function safeAlertPayload(alert: OperationalAlert) {
  return {
    event: "growthscout_manual_review",
    type: alert.type,
    incidentId: alert.key,
    ageSeconds: alert.ageSeconds,
    thresholdSeconds: alert.thresholdSeconds,
    severity: alert.severity,
  };
}
