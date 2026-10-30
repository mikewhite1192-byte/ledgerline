import type { Queryable } from "../../../db";
import { readCheckInput, readRowsWhereId } from "../../../data/read";
import { runAllChecks } from "../../../rules-engine";
import { findingInWeek, fixPlanFor, type FixLeg } from "../../../sweep/plan";
import { isUuid } from "../../../uuid";
import { engineOrThrow, readStoredProposal, safeArgs, type ProposalRow } from "../tools/read/get-proposal";
import type { GatewayContext, ProposalDraft } from "../types";
import { impactOf, PROPOSAL_TITLES } from "./proposals";

// The code-side engine check (design 3.6): the rules engine's own figure for a proposal, compared
// in code with what the proposal says, to the cent, whole values only. It reads the same engine
// result the auditor's pack carries (engineOrThrow), but before the pack is cut, so a cut never
// decides it. An engine refusal or a kind with no comparison here is unavailable, never matched; a
// read or engine error is no check at all (null), so nothing is stored and a later pass tries
// again. Reads only; the store writes the result once (audit.ts, writeEngineCheck).
//
// Kinds merged after the design (the three Cash Friday kinds, the pay rule change, the money code
// and the card match) have no comparison yet and read unavailable. A load from a rate confirmation
// (load_create) is compared: the checks run again on the stored reading. An escrow release stays
// unavailable: its amount is the driver's stored balance, which its precheck reads again.

export type EngineCheck = "matched" | "mismatch" | "unavailable";
export type EngineCheckResult = { check: EngineCheck; engineCents: number | null };

export const ENGINE_UNAVAILABLE: EngineCheckResult = { check: "unavailable", engineCents: null };

// The kinds compared on engineFor's result. A pay correction is compared on the sweep's own plan.
const COMPARED: ReadonlySet<string> = new Set([
  "advance_payout",
  "invoice_fix",
  "invoice_post",
  "load_rate_fill",
  "payment_reapply",
  "detention_charge",
  "settlement_approve",
  "load_create",
]);

// Whether the engine compares this kind at all. A kind with no comparison here (the card match,
// the Cash Friday kinds, the pay rule change, the money code, the pay policy setup) has no
// recompute by design, so a draft of it is never refused for the lack of one (design-agents-102
// 3.2 and D3: only a kind the engine does compare is refused when its recompute cannot run).
export function engineCompares(kind: string): boolean {
  return kind === "pay_correction" || COMPARED.has(kind);
}

// Whole cents the column can hold, else null: a figure that is not one is no figure.
function centsOf(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 1_000_000_000 ? v : null;
}

function objectOf(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const verdictOf = (same: boolean, engineCents: unknown): EngineCheckResult => ({
  check: same ? "matched" : "mismatch",
  engineCents: centsOf(engineCents),
});

// One kind's engine result against the proposal's amount. Pure. Only true counts as a match: a
// missing or malformed field is unavailable, and a number one cent off is a mismatch.
export function compareEngine(kind: string, amountCents: number, engine: Record<string, unknown>): EngineCheckResult {
  if (engine.ok !== true || !Number.isSafeInteger(amountCents)) return ENGINE_UNAVAILABLE;
  switch (kind) {
    case "advance_payout": {
      const approved = centsOf(engine.approvedCents);
      if (typeof engine.eligible !== "boolean" || approved === null) return ENGINE_UNAVAILABLE;
      return verdictOf(engine.eligible && approved === amountCents, approved);
    }
    case "invoice_fix": {
      const inner = objectOf(engine.engine);
      const total = inner?.ok === true ? centsOf(inner.amountCents) : null;
      if (total === null) return ENGINE_UNAVAILABLE;
      return verdictOf(total === amountCents && engine.proposedCents === amountCents, total);
    }
    case "invoice_post": {
      // The load is gone: the card names a load the records no longer hold.
      if (engine.loadFound === false) return verdictOf(false, null);
      const inner = objectOf(engine.engine);
      const matches = objectOf(engine.matches);
      const total = inner?.ok === true ? centsOf(inner.amountCents) : null;
      if (total === null || !matches) return ENGINE_UNAVAILABLE;
      return verdictOf(matches.amount === true && matches.lines === true && total === amountCents, total);
    }
    case "load_rate_fill":
      // No money moves; the check is whether the rate limit still takes these exact numbers.
      if (typeof engine.supported !== "boolean") return ENGINE_UNAVAILABLE;
      return verdictOf(engine.supported, null);
    case "payment_reapply": {
      if (engine.found === false) return verdictOf(false, null);
      const applied = centsOf(engine.applicationCents);
      if (engine.found !== true || applied === null) return ENGINE_UNAVAILABLE;
      return verdictOf(
        engine.applicationOnFromInvoice === true && engine.findingMatches === true && applied === amountCents,
        engine.findingCents,
      );
    }
    case "detention_charge": {
      const inner = objectOf(engine.engine);
      const total = inner?.ok === true ? centsOf(inner.amountCents) : null;
      if (total === null) return ENGINE_UNAVAILABLE;
      return verdictOf(inner?.matchesProposal === true && total === amountCents, total);
    }
    case "settlement_approve": {
      if (engine.found === false) return verdictOf(false, null);
      // A paystub no longer a draft is not run again, so there is no fresh figure to compare.
      const inner = objectOf(engine.engine);
      const matches = objectOf(engine.matches);
      if (engine.found !== true || engine.status !== "draft" || inner?.ok !== true || !matches) return ENGINE_UNAVAILABLE;
      return verdictOf(matches.cardEqualsStored === true && matches.storedEqualsEngine === true, inner.netCents);
    }
    case "load_create": {
      // The deterministic checks run again on the stored reading: they must still take the card's
      // exact values, and the document's own total must be the card's amount.
      if (typeof engine.holds !== "boolean") return ENGINE_UNAVAILABLE;
      const total = centsOf(engine.totalCents);
      if (total === null) return ENGINE_UNAVAILABLE;
      return verdictOf(engine.holds && total === amountCents, total);
    }
    default:
      return ENGINE_UNAVAILABLE;
  }
}

// A pay correction against the fix legs the sweep would plan for the same week (sweep/plan.ts),
// compared the way the sweep compares its own drafts (sameNumbers): the same driver, the signed
// cents equal, the amount its size and the direction its sign. Pure. No leg for that driver this
// week means the engine has no figure for it: unavailable.
export function comparePayCorrection(
  p: Pick<ProposalRow, "subject_table" | "subject_id" | "amount_cents" | "direction">,
  args: Record<string, unknown>,
  legs: readonly FixLeg[],
): EngineCheckResult {
  const { driverId, deltaCents } = args;
  if (typeof driverId !== "string" || !isUuid(driverId) || typeof deltaCents !== "number") return ENGINE_UNAVAILABLE;
  if (!Number.isSafeInteger(deltaCents) || deltaCents === 0) return ENGINE_UNAVAILABLE;
  const driver = driverId.toLowerCase();
  const mine = legs.filter((l) => l.driverId.toLowerCase() === driver);
  if (mine.length === 0) return ENGINE_UNAVAILABLE;
  const stored =
    p.subject_table === "drivers" &&
    p.subject_id.toLowerCase() === driver &&
    Number(p.amount_cents) === Math.abs(deltaCents) &&
    p.direction === (deltaCents < 0 ? "in" : "out");
  const same = stored && mine.some((l) => l.expectedCents === deltaCents);
  if (same) return verdictOf(true, Math.abs(deltaCents));
  return verdictOf(false, mine.length === 1 ? Math.abs(mine[0].expectedCents) : null);
}

async function payCorrectionCheck(q: Queryable, p: ProposalRow, raw: Record<string, unknown>): Promise<EngineCheckResult> {
  const { periodId } = raw;
  if (typeof periodId !== "string" || !isUuid(periodId)) return ENGINE_UNAVAILABLE;
  const [period] = await readRowsWhereId(q, "settlement_periods", "id", periodId);
  if (!period) return ENGINE_UNAVAILABLE;
  const window = { start: period.period_start, end: period.period_end };
  const input = await readCheckInput(q);
  const legs: FixLeg[] = [];
  for (const f of runAllChecks(input)) {
    if (!findingInWeek(f, input, window)) continue;
    for (const leg of fixPlanFor(f, input, window)) if (leg.kind === "fix") legs.push(leg);
  }
  return comparePayCorrection(p, raw, legs);
}

// The check for one proposal on this carrier, as of ctx.now. Never throws. Null when a read or the
// engine threw (a database error, a timeout): that is not known, so the caller stores nothing and
// the next load or pass tries again. The error is logged by name only.
export async function engineCheck(
  q: Queryable,
  ctx: GatewayContext,
  proposalId: string,
): Promise<EngineCheckResult | null> {
  try {
    const stored = await readStoredProposal(q, proposalId);
    if (!stored) return ENGINE_UNAVAILABLE;
    return await checkRow(q, ctx, stored.row, stored.raw, stored.args);
  } catch (err) {
    console.warn("gateway: the engine check could not be computed:", err instanceof Error ? err.name : "unknown");
    return null;
  }
}

async function checkRow(
  q: Queryable,
  ctx: GatewayContext,
  row: ProposalRow,
  raw: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<EngineCheckResult> {
  if (row.kind === "pay_correction") return await payCorrectionCheck(q, row, raw);
  if (!COMPARED.has(row.kind)) return ENGINE_UNAVAILABLE;
  return compareEngine(row.kind, Number(row.amount_cents), await engineOrThrow(q, ctx, row, args, raw));
}

// A draft shaped as the row the insert would store and the engine reads: the amount and direction
// as impactOf stores them, the subject id as the database returns it, the args as their JSON. It
// is still proposed and has no id yet; no engine reads either.
function draftRow(draft: ProposalDraft): ProposalRow {
  const impact = impactOf(draft.kind, draft.amountCents);
  return {
    id: "00000000-0000-0000-0000-000000000000",
    kind: draft.kind,
    title: PROPOSAL_TITLES[draft.kind],
    subject_table: draft.subjectTable,
    subject_id: draft.subjectId.toLowerCase(),
    subject_label: null,
    amount_cents: impact.amountCents,
    direction: impact.direction,
    operator_verdict: "not_given",
    status: "proposed",
    reasons: "[]",
    sources: "[]",
    args: JSON.stringify(draft.args),
    exceptions: "[]",
    flagged: false,
    flag_categories: null,
  };
}

// The same check on a draft before it is saved (design-agents-102 3.2), so a card the engine does
// not recompute to the cent is never inserted. Never throws: null when a read or the engine threw,
// which the loop treats as unknown (refused), never as matched. The error is logged by name only.
export async function engineCheckDraft(
  q: Queryable,
  ctx: GatewayContext,
  draft: ProposalDraft,
): Promise<EngineCheckResult | null> {
  try {
    const row = draftRow(draft);
    const parsed: unknown = JSON.parse(row.args);
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return await checkRow(q, ctx, row, raw, safeArgs(raw));
  } catch (err) {
    console.warn("gateway: the engine check on a draft could not be computed:", err instanceof Error ? err.name : "unknown");
    return null;
  }
}
