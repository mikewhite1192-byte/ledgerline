import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { TenantDb } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject } from "../money/read";
import { MoneyError, type MoneyActionState } from "../money/types";
import { assertMembership } from "../tenant/context";
import { accountingAdapter } from "../adapters";
import { reconcileMoneyActions } from "../money/reconcile";
import {
  invoiceReconcileHooks,
  postInvoiceAction,
  readPostableInvoice,
  type InvoiceMoneyDeps,
  type PostableInvoice,
} from "./execute";
import type { RecordReconcileResult } from "./payments";

// "Post to QuickBooks" on an invoice's record page: the same money action the invoice_post
// executor runs, with the same ledger key. A row still in flight (reserved, sent, unknown) is
// replayed under its own attempt, so a second click never makes a second post; only a definite
// failure gets attempt + 1, at most invoiceLimits.maxPostAttempts times. The proposal is not
// involved, beyond being moved on when one is still waiting on this invoice's post.

export type PostRefusal =
  | "validation"
  | "not_found"
  | "already_posted"
  | "attempts_used"
  | "stale"
  | "role"
  | "disabled"
  | "not_connected"
  | "not_configured"
  | (string & {});

export type PostResult =
  | { ok: true; state: MoneyActionState; moneyActionId: string }
  | { ok: false; category: PostRefusal };

type Plan = { ok: true; invoice: PostableInvoice; attempt: number } | { ok: false; category: PostRefusal };

export async function postInvoice(
  db: TenantDb,
  session: Session,
  invoiceId: string,
  deps: InvoiceMoneyDeps = {},
): Promise<PostResult> {
  if (!flags.invoicesEnabled) return { ok: false, category: "disabled" };
  if (!isCanonicalUuid(invoiceId)) return { ok: false, category: "validation" };
  const plan = await db.withTenant(session.tenantId, async (q): Promise<Plan> => {
    await assertMembership(q, session);
    const read = await readPostableInvoice(q, invoiceId);
    if (!read.ok) return read;
    if (read.row.status === "void") return { ok: false, category: "validation" };
    if (read.row.qbo_id !== null) return { ok: false, category: "already_posted" };
    // The approver rule the proposal gate applies, so the button is never a way around it.
    const [member] = await q.query<{ role: string }>(
      "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
      [session.sub],
    );
    if (read.invoice.amountCents > flags.approverRole.adminAboveCents && member?.role !== "admin") {
      return { ok: false, category: "role" };
    }
    const rows = (await readBySubject(q, "invoices", invoiceId)).filter((a) => a.kind === "invoice");
    const latest = rows.reduce<(typeof rows)[number] | null>(
      (top, a) => (top === null || a.attempt > top.attempt ? a : top),
      null,
    );
    if (latest?.state === "confirmed") return { ok: false, category: "already_posted" };
    const attempt = latest === null ? 1 : latest.state === "failed" ? latest.attempt + 1 : latest.attempt;
    if (attempt > flags.invoiceLimits.maxPostAttempts) return { ok: false, category: "attempts_used" };
    return { ok: true, invoice: read.invoice, attempt };
  });
  if (!plan.ok) return plan;
  try {
    const out = await postInvoiceAction(db, session, plan.invoice, { attempt: plan.attempt, proposalId: null }, deps);
    return { ok: true, state: out.action.state, moneyActionId: out.action.id };
  } catch (err) {
    if (err instanceof MoneyError) return { ok: false, category: err.category };
    throw err;
  }
}

// The refresh on an invoice's record page: reads back this invoice's unsettled ledger rows only
// (same amount: confirmed; another amount: failed as amount_mismatch; nothing found: still
// unknown). Never sends anything new.
export async function reconcileInvoice(
  db: TenantDb,
  session: Session,
  invoiceId: string,
  deps: InvoiceMoneyDeps = {},
): Promise<RecordReconcileResult> {
  if (!flags.invoicesEnabled) return { ok: false, category: "disabled" };
  if (!isCanonicalUuid(invoiceId)) return { ok: false, category: "validation" };
  const accounting = deps.accounting ?? accountingAdapter();
  const summary = await reconcileMoneyActions(
    db,
    session,
    { subjectId: invoiceId, hooks: { invoice: invoiceReconcileHooks(db, session.tenantId, accounting) } },
    { ...deps, accounting },
  );
  return { ok: true, summary };
}
