import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, type Queryable } from "../db";
import { autopilotModeFor } from "../autopilot/mode";
import { autopilotSub } from "../autopilot/session";
import { isServiceSub } from "../sweep/service-session";
import { isUuid } from "../uuid";
import { askWords, cleanName, isAskedKind, toldWords, type AskFacts } from "./words";

// The agent's questions and told lines (agent_asks, 0072), each inside a tenant transaction the
// caller holds. Code writes every word (./words.ts); an ask never approves anything. Yes goes
// through POST /api/proposals/[id]/approve, the usual gate, and only then is the ask answered.

const DAY_MS = 86_400_000;
const LIVE_ASK = "('open', 'snoozed')";
const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type AskResult =
  | { kind: "created"; askId: string }
  | { kind: "exists" }
  | { kind: "skipped"; category: string };

type ProposalRow = {
  kind: string;
  status: string;
  subject_table: string;
  subject_id: string;
  amount_cents: string;
  args: string | null;
  decided_by: string | null;
  decision: string | null;
};

const PROPOSAL_SQL = `SELECT kind, status, subject_table, CAST(subject_id AS text) AS subject_id,
       CAST(amount_cents AS text) AS amount_cents, CAST(args AS text) AS args, decided_by,
       CAST(autopilot_decision AS text) AS decision
  FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

function objectOf(text: string | null): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const uuidOr = (v: unknown): string | null => (isUuid(v) ? v.toLowerCase() : null);
const wholeOr = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

async function readProposal(q: Queryable, proposalId: string): Promise<ProposalRow | null> {
  const rows = await q.query<ProposalRow>(PROPOSAL_SQL, [proposalId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1 || typeof rows[0].kind !== "string" || !/^\d{1,12}$/.test(String(rows[0].amount_cents))) {
    throw new DbError("unknown");
  }
  return rows[0];
}

const NAMES_SQL = `SELECT d.first_name, d.last_name, l.load_number, c.name AS customer_name
  FROM (SELECT CAST($1 AS uuid) AS driver_id, CAST($2 AS uuid) AS load_id) x
  LEFT JOIN loads l ON l.tenant_id = current_tenant_id() AND l.id = x.load_id
  LEFT JOIN drivers d ON d.tenant_id = current_tenant_id() AND d.id = coalesce(x.driver_id, l.driver_id)
  LEFT JOIN customers c ON c.tenant_id = current_tenant_id() AND c.id = l.customer_id`;

// The names a sentence uses, read from the records the proposal names: its driver (the subject,
// or the args' driverId) and its load (the subject, or the args' loadId), with the load's driver
// and customer.
async function factsOf(q: Queryable, p: ProposalRow): Promise<AskFacts> {
  const args = objectOf(p.args);
  const nested = args.load && typeof args.load === "object" ? (args.load as Record<string, unknown>) : {};
  const driverId = p.subject_table === "drivers" ? uuidOr(p.subject_id) : uuidOr(args.driverId);
  const loadId = p.subject_table === "loads" ? uuidOr(p.subject_id) : (uuidOr(args.loadId) ?? uuidOr(nested.loadId));
  const rows = await q.query<{ first_name: unknown; last_name: unknown; load_number: unknown; customer_name: unknown }>(
    NAMES_SQL,
    [driverId, loadId],
  );
  if (rows.length !== 1) throw new DbError("unknown");
  const r = rows[0];
  const first = cleanName(r.first_name);
  const last = cleanName(r.last_name);
  const stage = typeof args.toStage === "string" ? args.toStage : typeof args.stage === "string" ? args.stage : null;
  return {
    kind: p.kind,
    amountCents: Number(p.amount_cents),
    driverName: first && last ? cleanName(`${first} ${last}`) : (first ?? last),
    loadNumber: cleanName(r.load_number),
    customerName: cleanName(r.customer_name),
    percent: wholeOr(args.percent) ?? wholeOr(args.advancePercent),
    stage,
  };
}

const INSERT_SQL = `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text,
       created_at, updated_at)
  VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), $4, CAST($5 AS uuid), $6,
          CAST($7 AS timestamptz), CAST($7 AS timestamptz))`;

// One question about a proposal the desk just drafted, in the transaction that saved it. Only for
// an asked kind, while the proposal waits, and when the autopilot would not do it by itself
// (autopilotModeFor is ask; the autopilot's own ask decision passes mode "ask"). One live ask per
// proposal: a second call, or a racing one, finds it (agent_asks_one_live_ask).
export async function askFor(
  q: Queryable,
  proposalId: string,
  now: Date,
  opts: { mode?: "ask" } = {},
): Promise<AskResult> {
  if (flags.agentAsks.enabled !== true) return { kind: "skipped", category: "switched_off" };
  if (!isUuid(proposalId)) return { kind: "skipped", category: "bad_request" };
  const p = await readProposal(q, proposalId);
  if (!p) return { kind: "skipped", category: "not_found" };
  if (!isAskedKind(p.kind)) return { kind: "skipped", category: "not_asked_kind" };
  if (p.status !== "proposed") return { kind: "skipped", category: "not_waiting" };
  const mode = opts.mode ?? (await autopilotModeFor(q, p.kind, now.getTime()));
  if (mode !== "ask") return { kind: "skipped", category: mode === "auto" ? "autopilot" : "kept_off" };
  const live = await q.query<{ id: string }>(
    `SELECT CAST(id AS text) AS id FROM agent_asks
      WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid) AND kind = 'ask'
        AND status IN ${LIVE_ASK}`,
    [proposalId],
  );
  if (live.length > 0) return { kind: "exists" };
  const text = askWords(await factsOf(q, p));
  const id = randomUUID();
  // A racing call that inserted first wins; this one then finds its row.
  const n = await q.execute(
    `${INSERT_SQL}
     ON CONFLICT (tenant_id, proposal_id) WHERE kind = 'ask' AND status IN ${LIVE_ASK} DO NOTHING`,
    [id, "ask", proposalId, p.subject_table, p.subject_id, text, now.toISOString()],
  );
  return n === 1 ? { kind: "created", askId: id } : { kind: "exists" };
}

// The desk drafted it (the sweep's login): a person chatting with the agent already sees the card.
export const asksForSession = (session: Session): boolean => isServiceSub(session.sub);

// The told line after the autopilot approved a proposal and its executor finished: only for a
// proposal done and decided by this carrier's autopilot login. A live ask about it closes as
// void first (it was decided without the person). One told line per proposal.
export async function tellFor(q: Queryable, tenantId: string, proposalId: string, now: Date): Promise<AskResult> {
  if (flags.agentAsks.enabled !== true) return { kind: "skipped", category: "switched_off" };
  if (!isUuid(proposalId) || !isUuid(tenantId)) return { kind: "skipped", category: "bad_request" };
  const p = await readProposal(q, proposalId);
  if (!p) return { kind: "skipped", category: "not_found" };
  if (p.status !== "done" || p.decided_by !== autopilotSub(tenantId)) return { kind: "skipped", category: "not_autopilot" };
  await q.execute(
    `UPDATE agent_asks SET status = 'void', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid) AND kind = 'ask'
        AND status IN ${LIVE_ASK}`,
    [proposalId, now.toISOString()],
  );
  const decision = objectOf(p.decision);
  const limit = wholeOr(decision.maxCents);
  const text = toldWords({ ...(await factsOf(q, p)), limitCents: limit !== null && limit >= 0 ? limit : null });
  const id = randomUUID();
  const n = await q.execute(`${INSERT_SQL} ON CONFLICT (tenant_id, proposal_id) WHERE kind = 'told' DO NOTHING`, [
    id,
    "told",
    proposalId,
    p.subject_table,
    p.subject_id,
    text,
    now.toISOString(),
  ]);
  return n === 1 ? { kind: "created", askId: id } : { kind: "exists" };
}

// The desk's pass: a live ask whose proposal no longer waits (a person decided it on its card, it
// was rejected, expired or retired) or is past proposalMaxAgeDays becomes void; a told line past
// the same age is done. Returns the asks closed.
export async function closeStaleAsks(q: Queryable, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - flags.proposalMaxAgeDays * DAY_MS).toISOString();
  const voided = await q.execute(
    `UPDATE agent_asks a SET status = 'void', updated_at = CAST($1 AS timestamptz)
       FROM proposals p
      WHERE a.tenant_id = current_tenant_id() AND p.tenant_id = a.tenant_id AND p.id = a.proposal_id
        AND a.kind = 'ask' AND a.status IN ${LIVE_ASK}
        AND (p.status <> 'proposed' OR p.created_at < CAST($2 AS timestamptz))`,
    [now.toISOString(), cutoff],
  );
  const told = await q.execute(
    `UPDATE agent_asks SET status = 'done', updated_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND kind = 'told' AND status = 'open'
        AND created_at < CAST($2 AS timestamptz)`,
    [now.toISOString(), cutoff],
  );
  return voided + told;
}

// "Not now": the ask comes back at `untilIso`. Only a live ask whose proposal still waits.
export async function snoozeAsk(q: Queryable, askId: string, untilIso: string, now: Date): Promise<boolean> {
  if (!isUuid(askId)) return false;
  const n = await q.execute(
    `UPDATE agent_asks a SET status = 'snoozed', snoozed_until = CAST($2 AS timestamptz),
            updated_at = CAST($3 AS timestamptz)
       FROM proposals p
      WHERE a.tenant_id = current_tenant_id() AND a.id = CAST($1 AS uuid) AND a.kind = 'ask'
        AND a.status IN ${LIVE_ASK} AND p.tenant_id = a.tenant_id AND p.id = a.proposal_id
        AND p.status = 'proposed'`,
    [askId, untilIso, now.toISOString()],
  );
  return n === 1;
}

// "Got it" on a told line: an open one becomes done (0072 lets a told line move open -> done).
export async function acknowledgeTold(q: Queryable, askId: string, now: Date): Promise<boolean> {
  if (!isUuid(askId)) return false;
  const n = await q.execute(
    `UPDATE agent_asks SET status = 'done', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'told' AND status = 'open'`,
    [askId, now.toISOString()],
  );
  return n === 1;
}

// After a person's approval went through the gate: the live ask about that proposal is answered.
export async function answerAsksFor(q: Queryable, proposalId: string, sub: string, now: Date): Promise<number> {
  if (!isUuid(proposalId)) return 0;
  return q.execute(
    `UPDATE agent_asks SET status = 'answered', answered_by = $2, answered_at = CAST($3 AS timestamptz),
            updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid) AND kind = 'ask'
        AND status IN ${LIVE_ASK}`,
    [proposalId, sub.slice(0, 200), now.toISOString()],
  );
}

export type AskView = {
  id: string;
  kind: "ask" | "told";
  proposalId: string;
  proposalKind: string;
  subjectTable: string;
  subjectId: string;
  text: string;
  reason: string | null;
  status: "open" | "snoozed";
  createdAt: string;
  // When it showed: its creation, or the end of its snooze.
  shownAt: string;
};

type AskRow = {
  id: string;
  kind: string;
  proposal_id: string;
  proposal_kind: string;
  subject_table: string;
  subject_id: string;
  text: string;
  reason: string | null;
  status: string;
  created_at: string;
  shown_at: string;
};

// Showing now: open, or snoozed and its time has come; an ask only while its proposal still waits
// (one decided elsewhere hides at once, before the desk's pass voids it).
const SHOWING = `(a.status = 'open' OR (a.status = 'snoozed' AND a.snoozed_until <= CAST($1 AS timestamptz)))
  AND (a.kind = 'told' OR p.status = 'proposed')`;
const SHOWN_AT = `(CASE WHEN a.status = 'snoozed' THEN a.snoozed_until ELSE a.created_at END)`;

const viewOf = (r: AskRow): AskView => ({
  id: r.id,
  kind: r.kind === "told" ? "told" : "ask",
  proposalId: r.proposal_id,
  proposalKind: r.proposal_kind,
  subjectTable: r.subject_table,
  subjectId: r.subject_id,
  text: r.text,
  reason: typeof r.reason === "string" ? r.reason : null,
  status: r.status === "snoozed" ? "snoozed" : "open",
  createdAt: r.created_at,
  shownAt: r.shown_at,
});

// The carrier's asks showing now, newest first, at most `limit`; with `sinceIso`, only those shown
// after it. openCount counts every one showing now.
export async function readShowingAsks(
  q: Queryable,
  input: { nowIso: string; sinceIso: string | null; limit: number },
): Promise<{ asks: AskView[]; openCount: number }> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
  const rows = await q.query<AskRow>(
    `SELECT CAST(a.id AS text) AS id, a.kind, CAST(a.proposal_id AS text) AS proposal_id, p.kind AS proposal_kind,
            a.subject_table, CAST(a.subject_id AS text) AS subject_id, a.text, a.reason, a.status,
            ${ts("a.created_at")} AS created_at, ${ts(SHOWN_AT)} AS shown_at
       FROM agent_asks a
       JOIN proposals p ON p.tenant_id = a.tenant_id AND p.id = a.proposal_id
      WHERE a.tenant_id = current_tenant_id() AND a.status IN ${LIVE_ASK} AND ${SHOWING}
        AND (CAST($2 AS timestamptz) IS NULL OR ${SHOWN_AT} > CAST($2 AS timestamptz))
      ORDER BY ${SHOWN_AT} DESC, a.id DESC
      LIMIT ${limit}`,
    [input.nowIso, input.sinceIso],
  );
  const [counted] = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM agent_asks a
       JOIN proposals p ON p.tenant_id = a.tenant_id AND p.id = a.proposal_id
      WHERE a.tenant_id = current_tenant_id() AND a.status IN ${LIVE_ASK} AND ${SHOWING}`,
    [input.nowIso],
  );
  const openCount = Number(counted?.n);
  if (!Number.isSafeInteger(openCount) || openCount < 0) throw new DbError("unknown");
  return { asks: rows.map(viewOf), openCount };
}

// The reason pass: asks still waiting for their one reason try, oldest first.
export type ReasonCandidate = {
  id: string;
  proposalKind: string;
  amountCents: number;
  text: string;
  reasons: string[];
  sources: string[];
  dedupeKey: string;
};

export async function readReasonCandidates(q: Queryable, limit: number): Promise<ReasonCandidate[]> {
  const n = Math.max(0, Math.min(10, Math.trunc(limit)));
  if (n === 0) return [];
  const rows = await q.query<{
    id: string;
    proposal_kind: string;
    amount_cents: string;
    text: string;
    reasons: string | null;
    sources: string | null;
    dedupe_key: string;
  }>(
    `SELECT CAST(a.id AS text) AS id, p.kind AS proposal_kind, CAST(p.amount_cents AS text) AS amount_cents, a.text,
            CAST(p.reasons AS text) AS reasons, CAST(p.sources AS text) AS sources, p.dedupe_key
       FROM agent_asks a
       JOIN proposals p ON p.tenant_id = a.tenant_id AND p.id = a.proposal_id
      WHERE a.tenant_id = current_tenant_id() AND a.kind = 'ask' AND a.status = 'open'
        AND a.reason_call_id IS NULL AND p.status = 'proposed'
      ORDER BY a.created_at, a.id
      LIMIT ${n}`,
  );
  const list = (text: string | null, field: "category" | "table"): string[] => {
    try {
      const v: unknown = JSON.parse(text ?? "[]");
      if (!Array.isArray(v)) return [];
      return v
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)[field] : null))
        .filter((x): x is string => typeof x === "string" && /^[a-z_]{2,40}$/.test(x));
    } catch {
      return [];
    }
  };
  return rows
    .filter((r) => /^\d{1,12}$/.test(String(r.amount_cents)))
    .map((r) => ({
      id: r.id,
      proposalKind: r.proposal_kind,
      amountCents: Number(r.amount_cents),
      text: r.text,
      reasons: [...new Set(list(r.reasons, "category"))].slice(0, 6),
      sources: [...new Set(list(r.sources, "table"))].slice(0, 8),
      dedupeKey: r.dedupe_key,
    }));
}

// The one try, reserved before the call: the ask is marked with the call's trace id, so a retry
// or a second wake never calls again. True when this caller holds it.
export async function claimReasonTry(q: Queryable, askId: string, traceId: string): Promise<boolean> {
  const n = await q.execute(
    `UPDATE agent_asks SET reason_call_id = CAST($2 AS uuid)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND reason_call_id IS NULL`,
    [askId, traceId],
  );
  return n === 1;
}

// A reason already written for the same proposal (its dedupe key), so a retry costs nothing.
export async function cachedReason(q: Queryable, dedupeKey: string): Promise<string | null> {
  const rows = await q.query<{ reason: string }>(
    `SELECT a.reason FROM agent_asks a
       JOIN proposals p ON p.tenant_id = a.tenant_id AND p.id = a.proposal_id
      WHERE a.tenant_id = current_tenant_id() AND p.dedupe_key = $1 AND a.reason IS NOT NULL
      ORDER BY a.created_at LIMIT 1`,
    [dedupeKey],
  );
  return rows.length === 1 && typeof rows[0].reason === "string" ? rows[0].reason : null;
}

// The checked reason, written once, only by the try that holds the ask.
export async function saveReason(q: Queryable, askId: string, traceId: string, reason: string): Promise<boolean> {
  const n = await q.execute(
    `UPDATE agent_asks SET reason = $3
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND reason_call_id = CAST($2 AS uuid)
        AND reason IS NULL`,
    [askId, traceId, reason],
  );
  return n === 1;
}
