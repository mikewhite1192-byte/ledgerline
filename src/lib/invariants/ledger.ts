import { invoiceStatus } from "../rules-engine/receivables";
import {
  InvariantReadError,
  countOf,
  flag,
  onlyRow,
  readAll,
  readPaged,
  refuseUnread,
  resultOf,
  tally,
  unreadable,
  whole,
  type InvariantResult,
  type PageKey,
  type ReadQuery,
} from "./types";
import type { Db } from "../db/types";

// I1: the ledger balances to the cent.
// - Every settlement's lines add up to its stored totals, and net = gross - deductions + carry.
// - Every advance's recovered_cents equals the recovery lines on paid settlements that cite it.
// - Every confirmed payout paid its subject's amount to its subject's driver, and the outside
//   amount equals it.
// - No customer payment is applied for more than it brought in, and every invoice's status is
//   the one its applications give it.
// A paid week is not recomputed from today's rows: escrow balances, recoveries and approved
// accessorials move on after a week is paid, so a recompute would differ for good reasons.

export const EARNING_KINDS = ["load_pay", "accessorial_pay", "reimbursement"] as const;
export const DEDUCTION_KINDS = [
  "fuel",
  "other_deduction",
  "carried_shortfall",
  "lease",
  "insurance",
  "escrow",
  "advance_recovery",
] as const;

const list = (kinds: readonly string[]) => kinds.map((k) => `'${k}'`).join(", ");

// Each check reads one aggregate row, not one row per record (a Data API response holds at most
// 1 MiB). The inner SELECT is the per-record row the check judges; the outer one counts what the
// per-record judgment counted. "unread" counts the records whose values the per-record read would
// have refused (a NULL where a whole number belongs): any at all leaves I1 unread.

// Every settlement's lines add up to its stored totals, and net = gross - deductions + carry.
export const SETTLEMENT_TOTALS_SQL = `SELECT count(*) AS settlements, CAST(COALESCE(SUM(t.lines), 0) AS bigint) AS lines,
       count(*) FILTER (WHERE t.gross IS NULL OR t.deductions IS NULL OR t.net IS NULL OR t.carry IS NULL
                          OR t.earned IS NULL OR t.deducted IS NULL OR t.odd_lines IS NULL
                          OR t.lines IS NULL) AS unread,
       count(*) FILTER (WHERE t.odd_lines > 0) AS odd_kind,
       count(*) FILTER (WHERE t.gross <> t.earned OR t.deductions <> -t.deducted
                          OR t.net <> t.gross - t.deductions + t.carry) AS totals_off
  FROM (SELECT s.gross_cents AS gross, s.deductions_cents AS deductions,
               s.net_cents AS net, s.carry_forward_cents AS carry,
               CAST(COALESCE(SUM(l.amount_cents) FILTER (WHERE l.kind IN (${list(EARNING_KINDS)})), 0) AS bigint) AS earned,
               CAST(COALESCE(SUM(l.amount_cents) FILTER (WHERE l.kind IN (${list(DEDUCTION_KINDS)})), 0) AS bigint) AS deducted,
               count(l.id) FILTER (WHERE l.kind NOT IN (${list([...EARNING_KINDS, ...DEDUCTION_KINDS])})) AS odd_lines,
               count(l.id) AS lines
          FROM settlements s
          LEFT JOIN settlement_lines l ON l.tenant_id = s.tenant_id AND l.settlement_id = s.id
         GROUP BY s.tenant_id, s.id) t`;

// A recovery line cites exactly one advance; recovered_cents moves when the week is paid.
export const RECOVERY_SQL = `SELECT count(*) AS advances,
       count(*) FILTER (WHERE r.recovered IS NULL OR r.recovered_lines IS NULL) AS unread,
       count(*) FILTER (WHERE r.recovered <> r.recovered_lines) AS recovery_off
  FROM (SELECT a.recovered_cents AS recovered,
               CAST(COALESCE((
                 SELECT -SUM(l.amount_cents)
                   FROM settlement_lines l
                   JOIN settlements s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id
                  WHERE l.tenant_id = a.tenant_id AND l.kind = 'advance_recovery' AND s.status = 'paid'
                    AND jsonb_array_length(l.sources) = 1
                    AND l.sources -> 0 ->> 'table' = 'advances'
                    AND l.sources -> 0 ->> 'id' = CAST(a.id AS text)), 0) AS bigint) AS recovered_lines
          FROM advances a) r`;

export const RECOVERY_LINES_SQL = `SELECT count(*) AS lines,
       count(*) FILTER (WHERE NOT (jsonb_array_length(l.sources) = 1
                                   AND l.sources -> 0 ->> 'table' = 'advances')) AS uncited,
       count(*) FILTER (WHERE jsonb_array_length(l.sources) = 1
                          AND l.sources -> 0 ->> 'table' = 'advances'
                          AND NOT EXISTS (SELECT 1 FROM advances a
                                           WHERE a.tenant_id = l.tenant_id
                                             AND CAST(a.id AS text) = l.sources -> 0 ->> 'id')) AS orphaned
  FROM settlement_lines l
 WHERE l.kind = 'advance_recovery'`;

// A payout whose subject is gone (no advance or settlement behind it) is a violation of its own,
// judged before its amounts. Otherwise the amount must equal the subject's, the outside amount
// must equal the amount (a missing outside amount never does), and the driver must match.
export const PAYOUTS_SQL = `SELECT count(*) AS payouts,
       count(*) FILTER (WHERE p.subject_amount IS NULL) AS subject_missing,
       count(*) FILTER (WHERE p.subject_amount IS NOT NULL AND p.amount IS NULL) AS unread,
       count(*) FILTER (WHERE p.subject_amount IS NOT NULL
                          AND (p.amount <> p.subject_amount OR p.outside_amount IS DISTINCT FROM p.amount
                               OR NOT p.same_driver)) AS mismatch
  FROM (SELECT m.amount_cents AS amount, m.outside_amount_cents AS outside_amount,
               CASE m.kind WHEN 'advance_payout' THEN a.amount_cents WHEN 'settlement_payout' THEN s.net_cents END
                 AS subject_amount,
               (m.counterparty_table = 'drivers' AND m.counterparty_id =
                 CASE m.kind WHEN 'advance_payout' THEN a.driver_id WHEN 'settlement_payout' THEN s.driver_id END)
                 IS TRUE AS same_driver
          FROM money_actions m
          LEFT JOIN advances a ON m.kind = 'advance_payout' AND a.tenant_id = m.tenant_id AND a.id = m.subject_id
          LEFT JOIN settlements s ON m.kind = 'settlement_payout' AND s.tenant_id = m.tenant_id AND s.id = m.subject_id
         WHERE m.channel = 'payment' AND m.state = 'confirmed') p`;

export const PAYMENTS_SQL = `SELECT count(*) AS payments,
       count(*) FILTER (WHERE p.amount IS NULL OR p.applied IS NULL) AS unread,
       count(*) FILTER (WHERE p.applied > p.amount) AS overapplied
  FROM (SELECT p.amount_cents AS amount, CAST(COALESCE(SUM(pa.amount_cents), 0) AS bigint) AS applied
          FROM customer_payments p
          LEFT JOIN payment_applications pa ON pa.tenant_id = p.tenant_id AND pa.payment_id = p.id
         GROUP BY p.tenant_id, p.id) p`;

// An invoice's status is judged by the receivables rules themselves (invoiceStatus), so invoices
// are read one row each, in pages by key (readPaged).
const INVOICE_COLUMNS = `CAST(i.tenant_id AS text) AS page_tenant, CAST(i.id AS text) AS page_id,
       i.status, i.amount_cents AS amount, (i.paid_on IS NOT NULL) AS has_paid_on,
       CAST(COALESCE((SELECT SUM(pa.amount_cents) FROM payment_applications pa
                       WHERE pa.tenant_id = i.tenant_id AND pa.invoice_id = i.id), 0) AS bigint) AS applied
  FROM invoices i`;

export const INVOICES_FIRST_SQL = `SELECT ${INVOICE_COLUMNS}
 ORDER BY i.tenant_id, i.id
 LIMIT CAST($1 AS integer)`;

export const INVOICES_AFTER_SQL = `SELECT ${INVOICE_COLUMNS}
 WHERE (i.tenant_id, i.id) > (CAST($1 AS uuid), CAST($2 AS uuid))
 ORDER BY i.tenant_id, i.id
 LIMIT CAST($3 AS integer)`;

export type SettlementTotalsRow = {
  settlements: unknown;
  lines: unknown;
  unread: unknown;
  odd_kind: unknown;
  totals_off: unknown;
};
export type RecoveryRow = { advances: unknown; unread: unknown; recovery_off: unknown };
export type RecoveryLinesRow = { lines: unknown; uncited: unknown; orphaned: unknown };
export type PayoutRow = { payouts: unknown; subject_missing: unknown; unread: unknown; mismatch: unknown };
export type PaymentRow = { payments: unknown; unread: unknown; overapplied: unknown };
export type InvoiceRow = PageKey & { status: unknown; amount: unknown; has_paid_on: unknown; applied: unknown };

// One aggregate row each, except invoices: one row per invoice.
export type LedgerRows = {
  settlements: SettlementTotalsRow[];
  recoveries: RecoveryRow[];
  recoveryLines: RecoveryLinesRow[];
  payouts: PayoutRow[];
  payments: PaymentRow[];
  invoices: InvoiceRow[];
};

export function judgeLedger(rows: LedgerRows): InvariantResult {
  const v: Record<string, number> = {};
  const s = onlyRow(rows.settlements, "settlements_unread");
  const settlements = countOf(s.settlements);
  const lines = countOf(s.lines);
  refuseUnread(s.unread, "not_whole");
  tally(v, "settlement_line_kind_unknown", countOf(s.odd_kind));
  tally(v, "settlement_totals_off", countOf(s.totals_off));

  const r = onlyRow(rows.recoveries, "recoveries_unread");
  const advances = countOf(r.advances);
  refuseUnread(r.unread, "not_whole");
  tally(v, "recovery_off", countOf(r.recovery_off));

  if (rows.recoveryLines.length !== 1) throw new InvariantReadError("recovery_lines_unread");
  const [rl] = rows.recoveryLines;
  whole(rl.lines);
  tally(v, "recovery_line_uncited", whole(rl.uncited));
  tally(v, "recovery_line_orphaned", whole(rl.orphaned));

  const p = onlyRow(rows.payouts, "payouts_unread");
  const payouts = countOf(p.payouts);
  tally(v, "payout_subject_missing", countOf(p.subject_missing));
  refuseUnread(p.unread, "not_whole");
  tally(v, "payout_mismatch", countOf(p.mismatch));

  const pay = onlyRow(rows.payments, "payments_unread");
  const payments = countOf(pay.payments);
  refuseUnread(pay.unread, "not_whole");
  tally(v, "payment_overapplied", countOf(pay.overapplied));

  let voided = 0;
  for (const i of rows.invoices) {
    const status = i.status;
    const amount = whole(i.amount);
    const applied = whole(i.applied);
    const paidOn = flag(i.has_paid_on);
    if (status === "void") {
      voided += 1;
      continue;
    }
    let expected: string;
    try {
      expected = invoiceStatus(amount, applied).status;
    } catch {
      tally(v, "invoice_status_off");
      continue;
    }
    if (status !== expected || paidOn !== (expected === "paid")) tally(v, "invoice_status_off");
  }

  return resultOf(
    "I1",
    {
      settlements,
      lines,
      advances,
      payouts,
      payments,
      invoices: rows.invoices.length - voided,
    },
    v,
  );
}

export async function readLedger(q: ReadQuery): Promise<LedgerRows> {
  return {
    settlements: await q.query<SettlementTotalsRow>(SETTLEMENT_TOTALS_SQL),
    recoveries: await q.query<RecoveryRow>(RECOVERY_SQL),
    recoveryLines: await q.query<RecoveryLinesRow>(RECOVERY_LINES_SQL),
    payouts: await q.query<PayoutRow>(PAYOUTS_SQL),
    payments: await q.query<PaymentRow>(PAYMENTS_SQL),
    invoices: await readPaged<InvoiceRow>(q, { first: INVOICES_FIRST_SQL, after: INVOICES_AFTER_SQL }),
  };
}

export async function checkLedger(admin: Db): Promise<InvariantResult> {
  try {
    return judgeLedger(await readAll(admin, readLedger));
  } catch (err) {
    return unreadable("I1", err);
  }
}
