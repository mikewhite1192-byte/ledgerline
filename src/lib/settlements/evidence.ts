import type { Queryable } from "../db";
import { readCheckInput } from "../data/read";
import { runAllChecks, type PayLine } from "../rules-engine";
import { isUuid } from "../uuid";
import { linesHash } from "./hash";
import { readPeriod, readStoredLines, readStoredSettlement, recheckSettlement } from "./stored";

// The auditor's evidence for a settlement_approve card, checked the way its executor checks it:
// the card's numbers against the stored draft, the stored draft against a fresh engine run over
// the records as they stand now (the pre-pay recheck, which also checks every cited record), and
// the checks' findings for this driver. Every value is a number, a code, an id or a boolean; line
// labels and names never reach the pack. Reads only: this file is reachable from agent code and
// imports no money write or adapter.

const MAX_KINDS = 12;
const MAX_FINDINGS = 8;

type Totals = { grossCents: number; deductionsCents: number; netCents: number; carryForwardCents: number };

// Line cents summed by kind, in first-seen order, so the pack stays small whatever the week holds.
function byKind(lines: readonly PayLine[]): { kind: string; amountCents: number; count: number }[] {
  const out = new Map<string, { kind: string; amountCents: number; count: number }>();
  for (const l of lines) {
    const row = out.get(l.kind) ?? { kind: l.kind, amountCents: 0, count: 0 };
    row.amountCents += l.amountCents;
    row.count += 1;
    out.set(l.kind, row);
  }
  return [...out.values()].slice(0, MAX_KINDS);
}

const totalsOf = (t: Totals) => ({
  grossCents: t.grossCents,
  deductionsCents: t.deductionsCents,
  netCents: t.netCents,
  carryForwardCents: t.carryForwardCents,
});

const sameTotals = (a: Totals, b: Totals) =>
  a.grossCents === b.grossCents &&
  a.deductionsCents === b.deductionsCents &&
  a.netCents === b.netCents &&
  a.carryForwardCents === b.carryForwardCents;

export async function settlementEvidence(
  q: Queryable,
  proposal: { subject_table: string; subject_id: string; amount_cents: number | string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const settlementId = proposal.subject_id;
  if (proposal.subject_table !== "settlements" || args.settlementId !== settlementId || !isUuid(settlementId)) {
    return { ok: false, reason: "unavailable" };
  }
  const stored = await readStoredSettlement(q, settlementId, false);
  if (!stored) return { ok: true, check: "settlement_approve", found: false };
  const lines = await readStoredLines(q, settlementId);
  const card: Totals = {
    grossCents: Number(args.grossCents),
    deductionsCents: Number(args.deductionsCents),
    netCents: Number(args.netCents),
    carryForwardCents: Number(args.carryForwardCents),
  };
  const base = {
    ok: true,
    check: "settlement_approve",
    found: true,
    status: stored.status,
    parkedReason: stored.parkedReason,
    proposedCents: Number(proposal.amount_cents),
    stored: { ...totalsOf(stored), lines: byKind(lines) },
    matches: {
      cardEqualsStored:
        sameTotals(card, stored) &&
        Number(proposal.amount_cents) === stored.netCents &&
        args.driverId === stored.driverId &&
        args.periodId === stored.periodId &&
        args.linesHash === linesHash(lines),
    },
  };
  // A paid or approved paystub is not re-run: its numbers are what was approved.
  if (stored.status !== "draft") return base;
  const check = await recheckSettlement(q, stored, lines);
  // The checks under the paystub's own week's pay rules version (D-093); a week not found keeps
  // the newest open week's.
  const period = await readPeriod(q, stored.periodId);
  const findings = runAllChecks(await readCheckInput(q, period?.start))
    .filter((f) => f.driverId === stored.driverId)
    .slice(0, MAX_FINDINGS)
    .map((f) => ({ check: f.check, category: f.category, amountCents: f.amountCents ?? null }));
  return {
    ...base,
    engine: {
      ok: true,
      ...totalsOf(check.fresh),
      lines: byKind(check.fresh.lines),
      exceptions: [...new Set(check.fresh.exceptions.map((e) => e.category))],
      insuredDays: check.fresh.insuredDays,
    },
    matches: { ...base.matches, storedEqualsEngine: check.park === null },
    park: check.park,
    findings,
  };
}
