import { invoiceStatus } from "../rules-engine/receivables";
import {
  InvariantReadError,
  flag,
  readAll,
  resultOf,
  tally,
  unreadable,
  whole,
  type InvariantResult,
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

export const SETTLEMENT_TOTALS_SQL = `SELECT s.gross_cents AS gross, s.deductions_cents AS deductions,
       s.net_cents AS net, s.carry_forward_cents AS carry,
       CAST(COALESCE(SUM(l.amount_cents) FILTER (WHERE l.kind IN (${list(EARNING_KINDS)})), 0) AS bigint) AS earned,
       CAST(COALESCE(SUM(l.amount_cents) FILTER (WHERE l.kind IN (${list(DEDUCTION_KINDS)})), 0) AS bigint) AS deducted,
       count(l.id) FILTER (WHERE l.kind NOT IN (${list([...EARNING_KINDS, ...DEDUCTION_KINDS])})) AS odd_lines,
       count(l.id) AS lines
  FROM settlements s
  LEFT JOIN settlement_lines l ON l.tenant_id = s.tenant_id AND l.settlement_id = s.id
 GROUP BY s.tenant_id, s.id`;

// A recovery line cites exactly one advance; recovered_cents moves when the week is paid.
export const RECOVERY_SQL = `SELECT a.recovered_cents AS recovered,
       CAST(COALESCE((
         SELECT -SUM(l.amount_cents)
           FROM settlement_lines l
           JOIN settlements s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id
          WHERE l.tenant_id = a.tenant_id AND l.kind = 'advance_recovery' AND s.status = 'paid'
            AND jsonb_array_length(l.sources) = 1
            AND l.sources -> 0 ->> 'table' = 'advances'
            AND l.sources -> 0 ->> 'id' = CAST(a.id AS text)), 0) AS bigint) AS recovered_lines
  FROM advances a`;

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

export const PAYOUTS_SQL = `SELECT m.amount_cents AS amount, m.outside_amount_cents AS outside_amount,
       CASE m.kind WHEN 'advance_payout' THEN a.amount_cents WHEN 'settlement_payout' THEN s.net_cents END
         AS subject_amount,
       (m.counterparty_table = 'drivers' AND m.counterparty_id =
         CASE m.kind WHEN 'advance_payout' THEN a.driver_id WHEN 'settlement_payout' THEN s.driver_id END)
         IS TRUE AS same_driver
  FROM money_actions m
  LEFT JOIN advances a ON m.kind = 'advance_payout' AND a.tenant_id = m.tenant_id AND a.id = m.subject_id
  LEFT JOIN settlements s ON m.kind = 'settlement_payout' AND s.tenant_id = m.tenant_id AND s.id = m.subject_id
 WHERE m.channel = 'payment' AND m.state = 'confirmed'`;

export const PAYMENTS_SQL = `SELECT p.amount_cents AS amount, CAST(COALESCE(SUM(pa.amount_cents), 0) AS bigint) AS applied
  FROM customer_payments p
  LEFT JOIN payment_applications pa ON pa.tenant_id = p.tenant_id AND pa.payment_id = p.id
 GROUP BY p.tenant_id, p.id`;

export const INVOICES_SQL = `SELECT i.status, i.amount_cents AS amount, (i.paid_on IS NOT NULL) AS has_paid_on,
       CAST(COALESCE(SUM(pa.amount_cents), 0) AS bigint) AS applied
  FROM invoices i
  LEFT JOIN payment_applications pa ON pa.tenant_id = i.tenant_id AND pa.invoice_id = i.id
 GROUP BY i.tenant_id, i.id`;

export type SettlementTotalsRow = {
  gross: unknown;
  deductions: unknown;
  net: unknown;
  carry: unknown;
  earned: unknown;
  deducted: unknown;
  odd_lines: unknown;
  lines: unknown;
};
export type RecoveryRow = { recovered: unknown; recovered_lines: unknown };
export type RecoveryLinesRow = { lines: unknown; uncited: unknown; orphaned: unknown };
export type PayoutRow = { amount: unknown; outside_amount: unknown; subject_amount: unknown; same_driver: unknown };
export type PaymentRow = { amount: unknown; applied: unknown };
export type InvoiceRow = { status: unknown; amount: unknown; has_paid_on: unknown; applied: unknown };

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
  let lines = 0;
  for (const s of rows.settlements) {
    const [gross, deductions, net, carry] = [whole(s.gross), whole(s.deductions), whole(s.net), whole(s.carry)];
    const [earned, deducted] = [whole(s.earned), whole(s.deducted)];
    lines += whole(s.lines);
    if (whole(s.odd_lines) > 0) tally(v, "settlement_line_kind_unknown");
    if (gross !== earned || deductions !== -deducted || net !== gross - deductions + carry) {
      tally(v, "settlement_totals_off");
    }
  }

  for (const r of rows.recoveries) {
    if (whole(r.recovered) !== whole(r.recovered_lines)) tally(v, "recovery_off");
  }
  if (rows.recoveryLines.length !== 1) throw new InvariantReadError("recovery_lines_unread");
  const [rl] = rows.recoveryLines;
  whole(rl.lines);
  tally(v, "recovery_line_uncited", whole(rl.uncited));
  tally(v, "recovery_line_orphaned", whole(rl.orphaned));

  for (const p of rows.payouts) {
    if (p.subject_amount === null) {
      tally(v, "payout_subject_missing");
      continue;
    }
    const amount = whole(p.amount);
    const outside = p.outside_amount === null ? null : whole(p.outside_amount);
    if (amount !== whole(p.subject_amount) || outside !== amount || !flag(p.same_driver)) {
      tally(v, "payout_mismatch");
    }
  }

  for (const p of rows.payments) {
    if (whole(p.applied) > whole(p.amount)) tally(v, "payment_overapplied");
  }

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
      settlements: rows.settlements.length,
      lines,
      advances: rows.recoveries.length,
      payouts: rows.payouts.length,
      payments: rows.payments.length,
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
    invoices: await q.query<InvoiceRow>(INVOICES_SQL),
  };
}

export async function checkLedger(admin: Db): Promise<InvariantResult> {
  try {
    return judgeLedger(await readAll(admin, readLedger));
  } catch (err) {
    return unreadable("I1", err);
  }
}
