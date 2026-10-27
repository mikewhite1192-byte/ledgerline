import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { readCashFridayInput, readTenant } from "../data/read";
import { tenantLock } from "../invoices/number";
import { persistEngineProposal, retireEngineProposalsExcept, type EnginePersistResult } from "../proposals/engine";
import { computeCashFriday, type CashOption, type CashPosition, type CashRefusal } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { optionArgs, optionReasons } from "./args";
import { explainCheck, type ExplainDeps, type Explained } from "./explain";

// "Check Friday's cash" on the Cash page (design 4.4). One press: the rules engine works out the carrier's
// position for the open week's pay day from its own records, the figures go in one cash_checks row,
// each way out the engine found becomes an engine card a person approves or rejects, and the
// waiting cards it no longer finds are retired. Then, outside that transaction, Muse Wonder
// explains the figures in one paragraph, kept only when every dollar figure in it is the engine's.
//
// Nothing here moves money or writes outside the app: the cards wait for a person, and their
// executors are the only writers (src/lib/proposals/executors/cash-friday.ts). The switch is read
// here and in the route. A refusal (no bank balance, two open weeks, a pay run that cannot be
// worked out) writes nothing and comes back as its category: unknown is never zero.

export const CASH_KINDS = ["factoring_request", "bill_defer", "collections_chase"] as const;

export type CheckOption = {
  kind: CashOption["kind"];
  subjectTable: CashOption["subjectTable"];
  subjectId: string;
  amountCents: number;
  coversShort: boolean | null;
  proposalId: string;
  // What the press did with the card: made it, found it unchanged, found it already approved, or
  // found a person already decided the same content.
  card: EnginePersistResult["kind"];
};

export type CheckResult =
  | { ok: true; checkId: string; gapCents: number; options: CheckOption[]; explained: boolean }
  | { ok: false; category: "disabled" | "no_tenant" | CashRefusal };

export type CheckDeps = ExplainDeps & {
  db?: TenantDb;
  explain?: (session: Session, input: Parameters<typeof explainCheck>[1]) => Promise<Explained>;
};

// What a stored receipt line keeps: no sources (the invoice id is the link), nothing a customer wrote.
function storedLine(l: CashPosition["lines"][number]) {
  return {
    invoiceId: l.invoiceId,
    invoiceNumber: l.invoiceNumber,
    customerId: l.customerId,
    balanceCents: l.balanceCents,
    dueOn: l.dueOn,
    expectedOn: l.expectedOn,
    onTimeBps: l.onTimeBps,
    label: l.label,
    status: l.status,
    expectedCents: l.expectedCents,
  };
}

export async function runCashCheck(session: Session, now: Date, deps: CheckDeps = {}): Promise<CheckResult> {
  if (!flags.cashFridayEnabled) return { ok: false, category: "disabled" };
  const db = deps.db ?? getDb();
  const checkId = randomUUID();
  const nowIso = now.toISOString();

  const made = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    // Two presses at once take turns, so neither sees the other's half-made cards.
    await tenantLock(q, "cash_check");
    const tenant = await readTenant(q);
    if (!tenant) return { ok: false as const, category: "no_tenant" as const };
    const input = await readCashFridayInput(q, tenant.timezone, flags.cashFridayLimits);
    const result = computeCashFriday(input, localDateOf(nowIso, tenant.timezone));
    if (!result.ok) return { ok: false as const, category: result.refusal };

    await q.execute(
      `INSERT INTO cash_checks (id, tenant_id, period_id, as_of, pay_day, figures, lines, options, gap_cents,
         pay_run_source, created_by, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS date), CAST($4 AS date),
         CAST($5 AS jsonb), CAST($6 AS jsonb), CAST('[]' AS jsonb), $7, $8, $9, CAST($10 AS timestamptz))`,
      [
        checkId,
        result.periodId,
        result.asOf,
        result.payDay,
        JSON.stringify(result.figures),
        JSON.stringify(result.lines.map(storedLine)),
        result.figures.gapCents,
        result.payRunSource,
        session.sub,
        nowIso,
      ],
    );

    // Options exist only when the gap is below zero, so the short is at least one cent.
    const shortCents = -result.figures.gapCents;
    const options: CheckOption[] = [];
    for (const o of result.options) {
      const persisted = await persistEngineProposal(
        q,
        {
          kind: o.kind,
          subjectTable: o.subjectTable,
          subjectId: o.subjectId,
          amountCents: o.amountCents,
          args: optionArgs(o, result.payDay, shortCents),
          exceptions: [],
          reasons: optionReasons(o),
          sources: o.sources,
        },
        session,
        now,
      );
      options.push({
        kind: o.kind,
        subjectTable: o.subjectTable,
        subjectId: o.subjectId,
        amountCents: o.amountCents,
        coversShort: o.kind === "collections_chase" ? null : o.coversShort,
        proposalId: persisted.proposalId,
        card: persisted.kind,
      });
    }
    // Every press: a waiting card the engine no longer finds (the week is covered now, the bill
    // was paid, the customer paid) is retired. Approved and running cards are left to their executors.
    for (const kind of CASH_KINDS) {
      const keep = new Set(result.options.filter((o) => o.kind === kind).map((o) => o.subjectId));
      await retireEngineProposalsExcept(q, kind, keep, session, now);
    }
    await q.execute(
      `UPDATE cash_checks SET options = CAST($2 AS jsonb)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [checkId, JSON.stringify(options)],
    );
    const categories = new Map(input.bills.map((b) => [b.id, b.category]));
    return { ok: true as const, result, options, billCategory: (id: string) => categories.get(id) ?? null };
  });
  if (!made.ok) return made;

  // The explanation runs after the check is stored, so a slow or failed call never loses the
  // figures or the cards. Only its outcome is written back: the paragraph, or a category.
  const explain = deps.explain ?? ((s, i) => explainCheck(s, i, deps));
  let explained: Explained;
  try {
    explained = await explain(session, { traceId: checkId, result: made.result, billCategory: made.billCategory });
  } catch {
    explained = { ok: false, category: "unknown", callId: null, costNanocents: null };
  }
  await db.withTenant(session.tenantId, async (q) => {
    await q.execute(
      `UPDATE cash_checks
          SET explanation = CAST($2 AS text), explain_call_id = CAST($3 AS uuid), explain_category = CAST($4 AS text)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [
        checkId,
        explained.ok ? explained.text : null,
        explained.callId,
        explained.ok ? null : explained.category,
      ],
    );
  });
  return { ok: true, checkId, gapCents: made.result.figures.gapCents, options: made.options, explained: explained.ok };
}
