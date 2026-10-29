import { z } from "zod";
import { readEngineProposalViews } from "../agent/gateway/store/views";
import type { ProposalView } from "../agent/view";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import {
  PAYMENT_LABELS,
  RECEIPT_STATUSES,
  VENDOR_BILL_CATEGORIES,
  VENDOR_BILL_STATUSES,
  BILL_URGENCIES,
} from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { CASH_KINDS } from "./check";

// What the Cash page shows: the latest stored check (its figures, receipt lines and the
// explanation that passed the figures check), the vendor bills, and the live cards. Every number
// comes from a stored row; nothing here computes money. A stored check that cannot be read whole
// is an error, never zeros (unknown is not zero).

const cents = z.number().int().safe();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const figuresSchema = z.object({
  bankBalanceCents: cents,
  balanceAsOf: day,
  cashOnHandCents: cents,
  expectedReceiptsCents: cents,
  payRunCents: cents,
  fuelLoadsCents: cents,
  vendorBillsDueCents: cents,
  gapCents: cents,
});

const lineSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  customerId: z.string(),
  balanceCents: cents,
  dueOn: day,
  expectedOn: day,
  onTimeBps: z.number().int().min(0).max(10_000),
  label: z.enum(PAYMENT_LABELS),
  status: z.enum(RECEIPT_STATUSES),
  expectedCents: cents,
});

export type CashFiguresView = z.infer<typeof figuresSchema>;
export type CashLineView = z.infer<typeof lineSchema> & { customerName: string | null };

export type CashCheckView = {
  id: string;
  asOf: string;
  payDay: string;
  createdAt: string;
  payRunSource: "stored" | "preview";
  figures: CashFiguresView;
  lines: CashLineView[];
  explanation: string | null;
  explainCategory: string | null;
};

export type VendorBillView = {
  id: string;
  billRef: string;
  vendorName: string;
  category: (typeof VENDOR_BILL_CATEGORIES)[number];
  amountCents: number;
  dueOn: string;
  urgency: (typeof BILL_URGENCIES)[number];
  status: (typeof VENDOR_BILL_STATUSES)[number];
  deferredTo: string | null;
  paidOn: string | null;
};

export type CashView = {
  check: CashCheckView | null;
  bills: VendorBillView[];
  // The engine's waiting, approved and running cards, factoring first, then the bill, then chases.
  cards: ProposalView[];
};

export const BILLS_SHOWN = 50;

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type CheckRow = {
  id: string;
  as_of: string;
  pay_day: string;
  created_at: string;
  pay_run_source: string;
  figures: string;
  lines: string;
  explanation: string | null;
  explain_category: string | null;
};

type BillRow = {
  id: string;
  bill_ref: string;
  vendor_name: string;
  category: string;
  amount_cents: number | string;
  due_on: string;
  urgency: string;
  status: string;
  deferred_to: string | null;
  paid_on: string | null;
};

const BILL_SELECT = `SELECT CAST(id AS text) AS id, bill_ref, vendor_name, category, amount_cents,
       CAST(due_on AS text) AS due_on, urgency, status, CAST(deferred_to AS text) AS deferred_to,
       CAST(paid_on AS text) AS paid_on
  FROM vendor_bills`;

function parsed<T>(schema: z.ZodType<T>, text: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DbError("unknown");
  }
  const out = schema.safeParse(raw);
  if (!out.success) throw new DbError("unknown");
  return out.data;
}

function billOf(r: BillRow): VendorBillView {
  const amount = Number(r.amount_cents);
  const category = VENDOR_BILL_CATEGORIES.find((c) => c === r.category);
  const urgency = BILL_URGENCIES.find((u) => u === r.urgency);
  const status = VENDOR_BILL_STATUSES.find((s) => s === r.status);
  if (!Number.isSafeInteger(amount) || !category || !urgency || !status) throw new DbError("unknown");
  return {
    id: r.id,
    billRef: r.bill_ref,
    vendorName: r.vendor_name,
    category,
    amountCents: amount,
    dueOn: r.due_on,
    urgency,
    status,
    deferredTo: r.deferred_to,
    paidOn: r.paid_on,
  };
}

export async function readCashView(q: Queryable): Promise<CashView> {
  const [row] = await q.query<CheckRow>(
    `SELECT CAST(id AS text) AS id, CAST(as_of AS text) AS as_of, CAST(pay_day AS text) AS pay_day,
            ${TS("created_at")} AS created_at, pay_run_source, CAST(figures AS text) AS figures,
            CAST(lines AS text) AS lines, explanation, explain_category
       FROM cash_checks
      WHERE tenant_id = current_tenant_id()
      ORDER BY created_at DESC, id LIMIT 1`,
  );
  let check: CashCheckView | null = null;
  if (row) {
    if (row.pay_run_source !== "stored" && row.pay_run_source !== "preview") throw new DbError("unknown");
    const lines = parsed(z.array(lineSchema), row.lines);
    // The customers the lines name, read by the ids stored on this one check.
    const names = await q.query<{ id: string; name: string }>(
      `SELECT CAST(c.id AS text) AS id, c.name
         FROM customers c
        WHERE c.tenant_id = current_tenant_id()
          AND c.id IN (SELECT CAST(x->>'customerId' AS uuid)
                         FROM cash_checks k, jsonb_array_elements(k.lines) AS x
                        WHERE k.tenant_id = current_tenant_id() AND k.id = CAST($1 AS uuid))`,
      [row.id],
    );
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    check = {
      id: row.id,
      asOf: row.as_of,
      payDay: row.pay_day,
      createdAt: row.created_at,
      payRunSource: row.pay_run_source,
      figures: parsed(figuresSchema, row.figures),
      lines: lines.map((l) => ({ ...l, customerName: nameOf.get(l.customerId) ?? null })),
      explanation: row.explanation,
      explainCategory: row.explain_category,
    };
  }
  const bills = await q.query<BillRow>(
    `${BILL_SELECT} WHERE tenant_id = current_tenant_id()
      ORDER BY (status = 'paid'), due_on, bill_ref
      LIMIT ${BILLS_SHOWN}`,
  );
  const cards: ProposalView[] = [];
  for (const kind of CASH_KINDS) cards.push(...(await readEngineProposalViews(q, kind)));
  return { check, bills: bills.map(billOf), cards };
}

// One vendor bill for its record page; null when this carrier has no such bill.
export async function readVendorBill(q: Queryable, id: string): Promise<VendorBillView | null> {
  if (!isUuid(id)) return null;
  const [row] = await q.query<BillRow>(`${BILL_SELECT} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`, [
    id,
  ]);
  return row ? billOf(row) : null;
}

export type CashHome = { payDay: string; gapCents: number; createdAt: string };

// Home's one line: the latest check's pay day and gap, or null when there is no check yet.
export async function readCashHome(session: Session, deps: { db?: TenantDb } = {}): Promise<CashHome | null> {
  const db = deps.db ?? getDb();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const [row] = await q.query<{ pay_day: string; gap_cents: number | string; created_at: string }>(
      `SELECT CAST(pay_day AS text) AS pay_day, gap_cents, ${TS("created_at")} AS created_at
         FROM cash_checks
        WHERE tenant_id = current_tenant_id()
        ORDER BY created_at DESC, id LIMIT 1`,
    );
    if (!row) return null;
    const gap = Number(row.gap_cents);
    if (!Number.isSafeInteger(gap)) throw new DbError("unknown");
    return { payDay: row.pay_day, gapCents: gap, createdAt: row.created_at };
  });
}
