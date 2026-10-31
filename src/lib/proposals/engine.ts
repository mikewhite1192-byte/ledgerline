import { randomUUID } from "node:crypto";
import { distinctRefs } from "../agent/gateway/refs";
import {
  PROPOSAL_TITLES,
  canonicalJson,
  dedupeKey,
  findByDedupe,
  impactOf,
} from "../agent/gateway/store/proposals";
import type { GatewayRef, GatewayTable, ProposalKind } from "../agent/gateway/types";
import { askFor, asksForSession } from "../asks/store";
import type { Session } from "../auth/claims";
import { DbError, type Queryable } from "../db";

// Proposals the rules engine makes outside a chat turn (origin 'engine', 0015): the invoice queue
// now, the pay run next. No model and no turn made them, so they carry no conversation, turn,
// gateway decision or trace. They are approved through the same gate and route as an agent's.
//
// One live card per kind and subject, as for the agent. A card whose content changed (the load's
// rate was fixed, say) retires the old card, if nobody has approved it yet, and stands up a new
// one. args.revision counts the subject's earlier cards that ended expired or failed, so a fresh
// card can follow one of those while a card a person rejected stays rejected until its content
// changes: the same content and revision hash to the same dedupe key.

const CATEGORY = /^[a-z_]{2,40}$/;

export type EngineDraft = {
  kind: ProposalKind;
  subjectTable: GatewayTable;
  subjectId: string;
  amountCents: number;
  args: Record<string, unknown>;
  exceptions: string[];
  reasons: string[];
  sources: GatewayRef[];
  // What the code that drafted the card found, as a category (0009's pattern). Default 'engine';
  // the card check's driver pick says 'match_picked'.
  operatorVerdict?: string;
};

export type EnginePersistResult =
  | { kind: "created"; proposalId: string }
  | { kind: "duplicate"; proposalId: string }
  | { kind: "live_exists"; proposalId: string }
  | { kind: "already_decided"; proposalId: string; status: string };

type Live = { id: string; status: string; args: string };

const withoutRevision = (args: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...args };
  delete rest.revision;
  return rest;
};

function parseArgs(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function liveFor(q: Queryable, kind: ProposalKind, subjectId: string): Promise<Live | null> {
  const rows = await q.query<Live>(
    `SELECT id, status, CAST(args AS text) AS args FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = $1 AND subject_id = CAST($2 AS uuid)
        AND status IN ('proposed', 'approved', 'executing')
      FOR UPDATE`,
    [kind, subjectId],
  );
  return rows[0] ?? null;
}

// Retires one waiting engine card. decided_by is the person whose action retired it (0009 needs a
// decider whenever a decision time is set). Returns the rows moved (0 or 1).
async function retire(q: Queryable, id: string, session: Session, now: Date): Promise<number> {
  return q.execute(
    `UPDATE proposals
        SET status = 'expired', decided_by = $2, decided_at = CAST($3 AS timestamptz),
            decision_note = 'superseded', updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND origin = 'engine'
        AND status = 'proposed'`,
    [id, session.sub, now.toISOString()],
  );
}

// Inside a tenant transaction the caller holds.
export async function persistEngineProposal(
  q: Queryable,
  draft: EngineDraft,
  session: Session,
  now: Date,
): Promise<EnginePersistResult> {
  const live = await liveFor(q, draft.kind, draft.subjectId);
  if (live) {
    const same =
      canonicalJson(withoutRevision(parseArgs(live.args))) === canonicalJson(withoutRevision(draft.args));
    if (same) return { kind: "duplicate", proposalId: live.id };
    // Approved or running: the person's approval stands; the executor re-checks the total.
    if (live.status !== "proposed") return { kind: "live_exists", proposalId: live.id };
    if ((await retire(q, live.id, session, now)) !== 1) {
      return { kind: "live_exists", proposalId: live.id };
    }
  }

  const [counted] = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = $1 AND subject_id = CAST($2 AS uuid)
        AND status IN ('expired', 'failed')`,
    [draft.kind, draft.subjectId],
  );
  const revision = Number(counted?.n);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("could not count earlier cards");
  const args = { ...withoutRevision(draft.args), revision };
  const key = dedupeKey(draft.kind, draft.subjectId, args);

  const existing = await findByDedupe(q, key);
  if (existing) return { kind: "already_decided", proposalId: existing.id, status: existing.status };

  const verdict = draft.operatorVerdict ?? "engine";
  if (!CATEGORY.test(verdict)) throw new Error("not a verdict category");
  const id = randomUUID();
  const impact = impactOf(draft.kind, draft.amountCents);
  const reasons = [...new Set(draft.reasons.filter((c) => CATEGORY.test(c)))].slice(0, 12);
  await q.execute(
    `INSERT INTO proposals
       (id, tenant_id, origin, conversation_id, turn_id, gateway_decision_id, trace_id, kind,
        subject_table, subject_id, amount_cents, direction, title, reasons, sources, args,
        exceptions, operator_verdict, dedupe_key, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'engine', NULL, NULL, NULL, NULL, $2, $3,
             CAST($4 AS uuid), $5, $6, $7, CAST($8 AS jsonb), CAST($9 AS jsonb), CAST($10 AS jsonb),
             CAST($11 AS jsonb), $14, $12, CAST($13 AS timestamptz), CAST($13 AS timestamptz))`,
    [
      id,
      draft.kind,
      draft.subjectTable,
      draft.subjectId,
      impact.amountCents,
      impact.direction,
      PROPOSAL_TITLES[draft.kind],
      JSON.stringify(reasons.map((category) => ({ category }))),
      JSON.stringify(distinctRefs(draft.sources).slice(0, 16)),
      JSON.stringify(args),
      JSON.stringify(draft.exceptions.filter((c) => CATEGORY.test(c))),
      key,
      now.toISOString(),
      verdict,
    ],
  );
  // The desk's card gets its question in the same transaction (src/lib/asks). A database error
  // has already aborted the transaction and goes up; any other throw (a zone Intl cannot read)
  // costs only the question, never the card.
  if (asksForSession(session)) {
    try {
      await askFor(q, id, now);
    } catch (err) {
      if (err instanceof DbError) throw err;
      console.warn("proposals: the question could not be written:", err instanceof Error ? err.name : "unknown");
    }
  }
  return { kind: "created", proposalId: id };
}

// Retires every waiting engine card of a kind whose subject no longer qualifies: keep is the whole
// list of subjects that still do (every invoiceable load, not just this press's capped share). A
// load that became an exception, was invoiced some other way or left the queue loses its card.
// Approved and running cards are left alone: their executors re-check. Returns the rows moved.
export async function retireEngineProposalsExcept(
  q: Queryable,
  kind: ProposalKind,
  keep: ReadonlySet<string>,
  session: Session,
  now: Date,
): Promise<number> {
  const rows = await q.query<{ id: string; subject_id: string }>(
    `SELECT id, subject_id FROM proposals
      WHERE tenant_id = current_tenant_id() AND origin = 'engine' AND kind = $1 AND status = 'proposed'
      ORDER BY id
      FOR UPDATE`,
    [kind],
  );
  let moved = 0;
  for (const r of rows) {
    if (!keep.has(r.subject_id)) moved += await retire(q, r.id, session, now);
  }
  return moved;
}
