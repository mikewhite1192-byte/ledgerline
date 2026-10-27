import type { Queryable } from "../../../db";
import { argStrings, parseReportArgs } from "../../../reports/args";
import { isReportName } from "../../../reports/types";
import { reasonSentence } from "../../reasons";
import {
  turnErrorFor,
  type CardStatus,
  type FlagView,
  type ProposalView,
  type RefView,
  type ReportView,
  type StepView,
  type TurnStatus,
  type TurnView,
} from "../../view";

// Reading a turn back for the chat (the poll route, the end of a stream, a page reload). Inside a
// tenant transaction; a person sees only their own conversations.

const QUOTE_CHARS = 280;
const RECENT_TURNS = 10;

type TurnRow = {
  id: string;
  conversation_id: string;
  seq: number | string;
  user_text: string;
  status: string;
  ended_reason: string | null;
  assistant_text: string;
};
type StepRow = {
  id: string;
  seq: number | string;
  kind: string;
  label: string;
  state: string;
  report: string | null;
};
type ProposalRow = {
  id: string;
  kind: ProposalView["kind"];
  subject_table: string;
  subject_id: string;
  subject_label: string | null;
  amount_cents: number | string;
  direction: ProposalView["direction"];
  title: string;
  reasons: string;
  sources: string;
  status: string;
  money_state: string | null;
  flagged_input_id: string | null;
  flag_categories: string | null;
  operator_verdict: string;
  auditor_verdict: string | null;
  auditor_concerns: string | null;
  auditor_checked_at: string | null;
  auditor_override_reason: string | null;
  auditor_override_at: string | null;
  override_role: string | null;
};
type FlagRow = { input_id: string; body_text: string; categories: string | null };

const TURN_COLUMNS =
  "t.id, t.conversation_id, t.seq, t.user_text, t.status, t.ended_reason, t.assistant_text";

// What the card shows, from the proposal and its ledger row. approved with no ledger row stays
// approved, not unknown: the ledger reserves its row before any outside call, so no row means no
// money moved.
export function cardStatusOf(status: string, moneyState: string | null): CardStatus {
  if (status === "executing") {
    if (moneyState === "confirmed") return "done";
    if (moneyState === "failed") return "failed";
    if (moneyState === "reserved") return "executing";
    return "unknown";
  }
  const known: CardStatus[] = ["proposed", "approved", "rejected", "expired", "done", "failed"];
  return known.includes(status as CardStatus) ? (status as CardStatus) : "unknown";
}

function parseArray(text: string | null): unknown[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function refsOf(text: string | null): RefView[] {
  return parseArray(text).flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const { table, id } = r as Record<string, unknown>;
    return typeof table === "string" && typeof id === "string" ? [{ table, id }] : [];
  });
}

function stringsOf(text: string | null): string[] {
  return parseArray(text).filter((c): c is string => typeof c === "string");
}

const CONCERN = /^[a-z_]{2,40}$/;

// Who overrode, as the card says it: the member's role, never their sub or email (memberships
// hold no display name).
function overrideLabel(role: string | null): string {
  if (role === "admin") return "an admin";
  if (role === "staff") return "a staff member";
  return "a member";
}

function overrideOf(r: ProposalRow): ProposalView["auditorOverride"] {
  if (r.auditor_override_reason === null || r.auditor_override_at === null) return null;
  return {
    reason: r.auditor_override_reason,
    byLabel: overrideLabel(r.override_role),
    at: r.auditor_override_at,
  };
}

function proposalView(r: ProposalRow): ProposalView {
  const reasons = parseArray(r.reasons).flatMap((x) => {
    const category = x && typeof x === "object" ? (x as Record<string, unknown>).category : null;
    return typeof category === "string"
      ? [{ category, text: reasonSentence(category), source: null }]
      : [];
  });
  return {
    id: r.id,
    kind: r.kind,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    subjectLabel: r.subject_label,
    amountCents: Number(r.amount_cents),
    direction: r.direction,
    title: r.title,
    reasons,
    sources: refsOf(r.sources),
    status: cardStatusOf(r.status, r.money_state),
    flagged: r.flagged_input_id !== null,
    flagCategories: stringsOf(r.flag_categories),
    operatorVerdict: r.operator_verdict,
    auditorVerdict: r.auditor_verdict,
    auditorConcerns: stringsOf(r.auditor_concerns).filter((c) => CONCERN.test(c)),
    auditorCheckedAt: r.auditor_checked_at,
    auditorOverride: overrideOf(r),
  };
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const PROPOSAL_SQL = `
  SELECT p.id, p.kind, p.subject_table, p.subject_id,
         CASE p.subject_table
           WHEN 'drivers' THEN (SELECT d.code FROM drivers d WHERE d.id = p.subject_id)
           WHEN 'invoices' THEN (SELECT i.invoice_number FROM invoices i WHERE i.id = p.subject_id)
         END AS subject_label,
         p.amount_cents, p.direction, p.title,
         CAST(p.reasons AS text) AS reasons, CAST(p.sources AS text) AS sources, p.status,
         (SELECT m.state FROM money_actions m WHERE m.id = p.money_action_id) AS money_state,
         p.flagged_input_id,
         (SELECT CAST(s.categories AS text) FROM screenings s WHERE s.input_id = p.flagged_input_id
           ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS flag_categories,
         p.operator_verdict, p.auditor_verdict,
         CAST(p.auditor_concerns AS text) AS auditor_concerns,
         ${ISO("p.auditor_checked_at")} AS auditor_checked_at,
         p.auditor_override_reason, ${ISO("p.auditor_override_at")} AS auditor_override_at,
         (SELECT m.role FROM memberships m
           WHERE m.tenant_id = p.tenant_id AND m.cognito_sub = p.auditor_override_by) AS override_role
    FROM proposals p`;

async function viewOf(q: Queryable, t: TurnRow): Promise<TurnView> {
  const steps = await q.query<StepRow>(
    `SELECT id, seq, kind, label, state, CAST(detail->'report' AS text) AS report
       FROM turn_steps WHERE turn_id = CAST($1 AS uuid) ORDER BY seq`,
    [t.id],
  );
  const proposals = await q.query<ProposalRow>(
    `${PROPOSAL_SQL} WHERE p.turn_id = CAST($1 AS uuid) ORDER BY p.created_at, p.id`,
    [t.id],
  );
  const flags = await q.query<FlagRow>(
    `SELECT u.id AS input_id, u.body_text,
            (SELECT CAST(s.categories AS text) FROM screenings s WHERE s.input_id = u.id
              ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS categories
       FROM untrusted_inputs u
      WHERE u.id IN (SELECT CAST(detail->>'flaggedInputId' AS uuid) FROM turn_steps
                      WHERE turn_id = CAST($1 AS uuid)
                        AND detail->>'flaggedInputId' ~ '^[0-9a-f-]{36}$')
      ORDER BY u.id`,
    [t.id],
  );
  const status = t.status as TurnStatus;
  return {
    id: t.id,
    conversationId: t.conversation_id,
    seq: Number(t.seq),
    userText: t.user_text,
    status,
    endedReason: t.ended_reason,
    text: t.assistant_text,
    steps: steps.map(
      (s): StepView => ({
        id: s.id,
        seq: Number(s.seq),
        kind: s.kind as StepView["kind"],
        label: s.label,
        state: s.state as StepView["state"],
      }),
    ),
    proposals: proposals.map(proposalView),
    reports: steps.flatMap(reportView),
    flags: flags.map(
      (f): FlagView => ({
        inputId: f.input_id,
        categories: stringsOf(f.categories),
        quote: f.body_text.length > QUOTE_CHARS ? `${f.body_text.slice(0, QUOTE_CHARS)}...` : f.body_text,
      }),
    ),
    error: turnErrorFor(status, t.ended_reason),
  };
}

// The report a finished tool step built, read back through the report's own strict schema;
// anything that does not parse is left out rather than shown.
function reportView(s: StepRow): ReportView[] {
  if (s.kind !== "tool" || s.state !== "done" || s.report === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(s.report);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const { name, args } = raw as { name?: unknown; args?: unknown };
  if (!isReportName(name)) return [];
  const parsed = parseReportArgs(name, args);
  return parsed ? [{ stepId: s.id, name, args: argStrings(parsed.args) }] : [];
}

// One turn, only if it is in a conversation this person started.
export async function readTurnView(q: Queryable, sub: string, turnId: string): Promise<TurnView | null> {
  const rows = await q.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.id = CAST($1 AS uuid) AND c.created_by = $2`,
    [turnId, sub],
  );
  return rows.length === 1 ? viewOf(q, rows[0]) : null;
}

// This person's latest conversation, its last turns oldest first, for a page reload.
export async function readRecentTurnViews(q: Queryable, sub: string): Promise<TurnView[]> {
  const rows = await q.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM turns t
      WHERE t.conversation_id = (SELECT c.id FROM conversations c WHERE c.created_by = $1
                                  ORDER BY c.updated_at DESC, c.id LIMIT 1)
      ORDER BY t.seq DESC LIMIT ${RECENT_TURNS}`,
    [sub],
  );
  const out: TurnView[] = [];
  for (const r of rows.reverse()) out.push(await viewOf(q, r));
  return out;
}
