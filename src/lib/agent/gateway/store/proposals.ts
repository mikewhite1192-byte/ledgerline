import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../../db";
import { distinctRefs } from "../refs";
import type { ProposalKind } from "../types";
import type { PersistInput, PersistResult } from "./types";

// Persisting a proposal from an allowed propose_* outcome (design 2.7). The gateway already
// validated the args and the rules engine sized or capped the amount; this only stores it.
// Stored: ids, enums, cents and categories. Never model text.

export const PROPOSAL_TITLES: Readonly<Record<ProposalKind, string>> = {
  advance_payout: "Pay advance",
  pay_correction: "Pay correction",
  invoice_fix: "Invoice correction",
  load_rate_fill: "Fill missing rate",
  invoice_post: "Post invoice",
  payment_reapply: "Move payment to the right invoice",
  detention_charge: "Bill unbilled detention",
  pay_rule_change: "Change a pay rule",
};

const CATEGORY = /^[a-z_]{2,40}$/;
const LIVE = "('proposed', 'approved', 'executing')";
export const LIVE_STATUSES: readonly string[] = ["proposed", "approved", "executing"];

// JSON with object keys sorted at every level, so equal args hash equally.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function dedupeKey(kind: ProposalKind, subjectId: string, args: unknown): string {
  const hash = createHash("sha256").update(canonicalJson(args)).digest("hex");
  return `${kind}:${subjectId.toLowerCase()}:${hash}`;
}

// The card's impact: always non-negative cents with a direction.
export function impactOf(kind: ProposalKind, amountCents: number) {
  if (kind === "pay_correction") {
    return { amountCents: Math.abs(amountCents), direction: amountCents < 0 ? "in" : "out" } as const;
  }
  if (kind === "invoice_fix" || kind === "payment_reapply") {
    return { amountCents, direction: "none" } as const;
  }
  // A rate fill moves no money.
  if (kind === "load_rate_fill") return { amountCents: 0, direction: "none" } as const;
  // An invoice is money the customer owes in; nothing moves until they pay it.
  if (kind === "invoice_post") return { amountCents, direction: "in" } as const;
  // Money the customer owes the carrier on top of the invoice.
  if (kind === "detention_charge") return { amountCents, direction: "in" } as const;
  // A pay rule change's amount is the engine's signed change to last settled week's total net pay:
  // more pay is money out, less pay money kept in, none when no one's pay changes.
  if (kind === "pay_rule_change") {
    const direction = amountCents > 0 ? "out" : amountCents < 0 ? "in" : "none";
    return { amountCents: Math.abs(amountCents), direction } as const;
  }
  return { amountCents, direction: "out" } as const;
}

function categoriesOf(args: Record<string, unknown>, reasons: readonly string[]): string[] {
  const fromArgs = Array.isArray(args.reasonCategories) ? args.reasonCategories : [];
  const all = [...fromArgs, ...reasons].filter(
    (c): c is string => typeof c === "string" && CATEGORY.test(c),
  );
  return [...new Set(all)].slice(0, 12);
}

export type Existing = { id: string; flagged_input_id: string | null; status: string };

export async function findByDedupe(q: Queryable, key: string): Promise<Existing | null> {
  const rows = await q.query<Existing>(
    "SELECT id, flagged_input_id, status FROM proposals WHERE dedupe_key = $1",
    [key],
  );
  return rows[0] ?? null;
}

export async function findLive(q: Queryable, kind: ProposalKind, subjectId: string): Promise<string | null> {
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM proposals
      WHERE kind = $1 AND subject_id = CAST($2 AS uuid) AND status IN ${LIVE}`,
    [kind, subjectId],
  );
  return rows[0]?.id ?? null;
}

// The request an advance names (args.requestRef) must have a clean screening on record; a missing
// or flagged one flags the proposal. Unknown is not clean.
async function requestFlag(q: Queryable, args: Record<string, unknown>): Promise<string | null> {
  const ref = typeof args.requestRef === "string" ? args.requestRef : null;
  if (!ref) return null;
  const rows = await q.query<{ verdict: string }>(
    `SELECT verdict FROM screenings WHERE input_id = CAST($1 AS uuid)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ref],
  );
  return rows[0]?.verdict === "clean" ? null : ref;
}

async function setFlag(q: Queryable, id: string, inputId: string, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE proposals SET flagged_input_id = CAST($2 AS uuid), updated_at = CAST($3 AS timestamptz)
      WHERE id = CAST($1 AS uuid) AND flagged_input_id IS NULL AND status = 'proposed'`,
    [id, inputId, nowIso],
  );
}

// The same proposal already on record that a person has decided (rejected, expired, done or
// failed): there is no card to return, and the turn must not claim one.
function decided(existing: Existing): PersistResult | null {
  return LIVE_STATUSES.includes(existing.status)
    ? null
    : { kind: "already_decided", proposalId: existing.id, status: existing.status };
}

// Inside a tenant transaction. A duplicate that is still live returns the existing card (and flags
// it if this turn read a flagged input); one already decided is reported as such; another live
// proposal for the subject is refused, never queued.
export async function persistProposal(
  q: Queryable,
  input: PersistInput,
  now: Date,
): Promise<PersistResult> {
  const { draft } = input;
  const nowIso = now.toISOString();
  const key = dedupeKey(draft.kind, draft.subjectId, draft.args);
  const flag = input.flaggedInputId ?? (await requestFlag(q, draft.args));

  const existing = await findByDedupe(q, key);
  if (existing) {
    const done = decided(existing);
    if (done) return done;
    if (flag && !existing.flagged_input_id) await setFlag(q, existing.id, flag, nowIso);
    return {
      kind: "duplicate",
      proposalId: existing.id,
      flagged: Boolean(existing.flagged_input_id || (flag && existing.status === "proposed")),
    };
  }
  const live = await findLive(q, draft.kind, draft.subjectId);
  if (live) return { kind: "live_exists", proposalId: live };

  const id = randomUUID();
  const impact = impactOf(draft.kind, draft.amountCents);
  const verdict =
    typeof draft.args.operatorVerdict === "string" && CATEGORY.test(draft.args.operatorVerdict)
      ? draft.args.operatorVerdict
      : "not_given";
  await q.execute(
    `INSERT INTO proposals
       (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id, amount_cents,
        direction, title, reasons, sources, args, exceptions, operator_verdict, flagged_input_id,
        gateway_decision_id, dedupe_key, trace_id, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5,
             CAST($6 AS uuid), $7, $8, $9, CAST($10 AS jsonb), CAST($11 AS jsonb),
             CAST($12 AS jsonb), CAST($13 AS jsonb), $14, CAST($15 AS uuid), CAST($16 AS uuid), $17,
             $18, CAST($19 AS timestamptz), CAST($19 AS timestamptz))`,
    [
      id,
      input.conversationId,
      input.turnId,
      draft.kind,
      draft.subjectTable,
      draft.subjectId,
      impact.amountCents,
      impact.direction,
      PROPOSAL_TITLES[draft.kind],
      JSON.stringify(categoriesOf(draft.args, draft.reasons).map((category) => ({ category }))),
      JSON.stringify(distinctRefs(draft.sources).slice(0, 16)),
      JSON.stringify(draft.args),
      JSON.stringify(draft.exceptions.filter((c) => CATEGORY.test(c))),
      verdict,
      flag,
      input.gatewayDecisionId,
      key,
      input.traceId,
      nowIso,
    ],
  );
  return { kind: "created", proposalId: id, flagged: flag !== null };
}

// Re-reads after a unique violation (another turn wrote the same proposal or a live one for the
// subject between this turn's checks and its insert).
export async function findProposalConflict(
  q: Queryable,
  input: PersistInput,
): Promise<PersistResult | null> {
  const { draft } = input;
  const existing = await findByDedupe(q, dedupeKey(draft.kind, draft.subjectId, draft.args));
  if (existing) {
    return (
      decided(existing) ?? {
        kind: "duplicate",
        proposalId: existing.id,
        flagged: existing.flagged_input_id !== null,
      }
    );
  }
  const live = await findLive(q, draft.kind, draft.subjectId);
  return live ? { kind: "live_exists", proposalId: live } : null;
}

export async function flagTurnProposals(
  q: Queryable,
  turnId: string,
  inputId: string,
  now: Date,
): Promise<number> {
  return q.execute(
    `UPDATE proposals SET flagged_input_id = CAST($2 AS uuid), updated_at = CAST($3 AS timestamptz)
      WHERE turn_id = CAST($1 AS uuid) AND flagged_input_id IS NULL AND status = 'proposed'`,
    [turnId, inputId, now.toISOString()],
  );
}
