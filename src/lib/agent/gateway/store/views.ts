import { flags } from "../../../../config/flags";
import type { Queryable } from "../../../db";
import { billDeferArgsSchema, chaseArgsSchema, factoringArgsSchema } from "../../../cash/args";
import { chargeArgsSchema } from "../../../data/detention-charge";
import { changeArgsSchema } from "../../../pay-rules/change";
import { isUuid } from "../../../uuid";
import { argStrings, parseReportArgs } from "../../../reports/args";
import { isReportName } from "../../../reports/types";
import { cardLabel } from "../../../advances/cards";
import { isParkReason } from "../../../advances/parking";
import { finalChecklist, parseChecklist } from "../../checklist";
import { reasonSentence } from "../../reasons";
import {
  turnErrorFor,
  type CardStatus,
  type CashCardView,
  type DetentionView,
  type FlagView,
  type ProposalView,
  type RefView,
  type ReportView,
  type RuleChangeView,
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
  checklist: string | null;
};
type StepRow = {
  id: string;
  seq: number | string;
  kind: string;
  label: string;
  state: string;
  report: string | null;
  masked_figures: string | null;
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
  engine_check: string | null;
  engine_override_reason: string | null;
  engine_override_at: string | null;
  engine_override_role: string | null;
  card_last4: string | null;
  args: string | null;
  card_load_driver?: string | null;
  park_reason?: string | null;
  exceptions: string | null;
  // A factoring card's request (0060), once its approval wrote one.
  factoring_status?: string | null;
  // A card pull-back's pull row (0080), once its approval wrote one.
  pull_status?: string | null;
};
type FlagRow = { input_id: string; body_text: string; categories: string | null };

const TURN_COLUMNS =
  "t.id, t.conversation_id, t.seq, t.user_text, t.status, t.ended_reason, t.assistant_text, " +
  "CAST(t.checklist AS text) AS checklist";

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
  if (role === "judge") return "a demo visitor";
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

// The code-side engine check as stored (0045): null until it ran; a value the card does not know
// reads as unavailable, never as matched.
function engineCheckOf(r: ProposalRow): ProposalView["engineCheck"] {
  if (r.engine_check === null) return null;
  return r.engine_check === "matched" || r.engine_check === "mismatch" ? r.engine_check : "unavailable";
}

function engineOverrideOf(r: ProposalRow): ProposalView["engineOverride"] {
  if (r.engine_override_reason === null || r.engine_override_at === null) return null;
  return {
    reason: r.engine_override_reason,
    byLabel: overrideLabel(r.engine_override_role),
    at: r.engine_override_at,
  };
}

// A detention charge's figures from its stored args, every field checked; null when they do not
// read back whole (the card then shows the title and amount only).
function detentionOf(r: ProposalRow): DetentionView | null {
  if (r.kind !== "detention_charge" || typeof r.args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(r.args);
  } catch {
    return null;
  }
  const parsed = chargeArgsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    freeMinutes: a.freeMinutes,
    hourlyCents: a.hourlyCents,
    invoiceAmountBeforeCents: a.invoiceAmountBeforeCents,
    stops: a.stops.map((s) => ({
      stop: s.stop,
      dwellMinutes: s.dwellMinutes,
      overMinutes: s.overMinutes,
      quarters: s.quarters,
      cents: s.cents,
    })),
  };
}

// An advance's load line from its stored args: the load's number, its cap and what was left
// under it after this advance at proposal time. Null when it names no load or does not read back
// whole; capCents and leftAfterCents are null together when the carrier has no per-load cap.
// shareBps is set only on a card the advance at pickup drafted (src/lib/advances/at-pickup.ts):
// the carrier's per-load share of trip pay, a whole number of basis points from 1 to 10000.
const LOAD_NUMBER = /^[A-Za-z0-9._-]{1,40}$/;
const wholeOrNull = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0);

export function advanceLoadOf(args: string | null): NonNullable<ProposalView["load"]> | null {
  if (typeof args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return null;
  }
  const load = raw && typeof raw === "object" ? (raw as Record<string, unknown>).load : null;
  if (!load || typeof load !== "object") return null;
  const { number, capCents, leftAfterCents, shareBps } = load as Record<string, unknown>;
  if (typeof number !== "string" || !LOAD_NUMBER.test(number)) return null;
  if (!wholeOrNull(capCents) || !wholeOrNull(leftAfterCents)) return null;
  if ((capCents === null) !== (leftAfterCents === null)) return null;
  if (shareBps === undefined) return { number, capCents, leftAfterCents };
  if (!Number.isSafeInteger(shareBps) || (shareBps as number) < 1 || (shareBps as number) > 10_000) return null;
  return { number, capCents, leftAfterCents, shareBps: shareBps as number };
}

// A card match's lines from its stored args: the card by its last four digits, its pool name, the
// day and state of the purchase, the driver picked and the other drivers code ranked. Null when the
// args do not read back whole; a value outside its shape is never shown.
const DRIVER_CODE = /^[A-Za-z0-9._-]{1,40}$/;
const PORTAL_NAME = /^[A-Z0-9 -]{2,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A card load ruling's line from its stored args and the driver's code read at render. Null when
// the args do not read back whole; a value outside its shape is never shown.
export function cardLoadOf(args: string | null, driverCode: string | null | undefined): NonNullable<ProposalView["cardLoad"]> | null {
  if (typeof args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { cardLast4, postedOn } = raw as Record<string, unknown>;
  if (typeof cardLast4 !== "string" || !LAST4.test(cardLast4)) return null;
  if (typeof postedOn !== "string" || !DAY.test(postedOn)) return null;
  const code = typeof driverCode === "string" && DRIVER_CODE.test(driverCode) ? driverCode : null;
  return { last4: cardLast4, postedOn, driverCode: code };
}

// A card pull-back's line from its stored args (the engine's plan): the card's last four, what the
// approval pulls and what a breakdown books as owed. Null when the args do not read back whole or
// out of the plan's shape (something pulled, never above what was asked; a breakdown's shortfall
// is the rest, a take-back has none).
export function pullViewOf(args: string | null, amountCents: number): NonNullable<ProposalView["pull"]> | null {
  if (typeof args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { cardLast4, requestedCents, pullCents, shortfallCents, advanceId } = raw as Record<string, unknown>;
  if (typeof cardLast4 !== "string" || !LAST4.test(cardLast4)) return null;
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!whole(requestedCents) || !whole(pullCents) || !whole(shortfallCents)) return null;
  if (requestedCents !== amountCents || pullCents < 1 || pullCents > requestedCents) return null;
  const onAdvance = typeof advanceId === "string";
  if (!onAdvance && advanceId !== null) return null;
  if (onAdvance ? shortfallCents !== 0 : pullCents + shortfallCents !== requestedCents) return null;
  return { last4: cardLast4, pullCents, shortfallCents, onAdvance };
}

export function cardMatchOf(args: string | null): NonNullable<ProposalView["cardMatch"]> | null {
  if (typeof args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const { last4, portalName, postedOn, state, driverCode, candidates } = a;
  if (typeof last4 !== "string" || !LAST4.test(last4)) return null;
  if (typeof portalName !== "string" || !PORTAL_NAME.test(portalName)) return null;
  if (typeof postedOn !== "string" || !DAY.test(postedOn)) return null;
  if (state !== null && (typeof state !== "string" || !/^[A-Z]{2}$/.test(state))) return null;
  if (typeof driverCode !== "string" || !DRIVER_CODE.test(driverCode)) return null;
  const others: string[] = [];
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      const code = c && typeof c === "object" ? (c as Record<string, unknown>).code : null;
      if (typeof code === "string" && DRIVER_CODE.test(code) && code !== driverCode && !others.includes(code)) {
        others.push(code);
      }
    }
  }
  return { last4, portalName, postedOn, state: state as string | null, driverCode, others: others.slice(0, 5) };
}

// An exception the gateway attached that the card states, after the reasons.
const SHOWN_EXCEPTIONS: ReadonlySet<string> = new Set(["capped_to_eligible", "card_not_drivers", "driver_not_candidate"]);

const CASH_KINDS: ReadonlySet<string> = new Set(["factoring_request", "bill_defer", "collections_chase"]);

// A Cash Friday card's figures from its stored args, every field checked; null when they do not
// read back whole (the card then shows the title, the amount and the reasons only).
function cashOf(r: ProposalRow): CashCardView | null {
  if (!CASH_KINDS.has(r.kind) || typeof r.args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(r.args);
  } catch {
    return null;
  }
  if (r.kind === "factoring_request") {
    const p = factoringArgsSchema.safeParse(raw);
    if (!p.success) return null;
    return {
      kind: "factoring_request",
      requestStatus: typeof r.factoring_status === "string" ? r.factoring_status : null,
      shortCents: p.data.shortCents,
      advanceBps: p.data.advanceBps,
      feeBps: p.data.feeBps,
      invoices: p.data.invoices.map((i) => ({
        invoiceId: i.invoiceId,
        invoiceNumber: i.invoiceNumber,
        balanceCents: i.balanceCents,
        advanceCents: i.advanceCents,
        feeCents: i.feeCents,
        netCents: i.netCents,
        reserveCents: i.reserveCents,
      })),
    };
  }
  if (r.kind === "bill_defer") {
    const p = billDeferArgsSchema.safeParse(raw);
    if (!p.success) return null;
    const { billId, billRef, amountCents, dueOn, deferredTo, shortCents } = p.data;
    return { kind: "bill_defer", billId, billRef, amountCents, dueOn, deferredTo, shortCents };
  }
  const p = chaseArgsSchema.safeParse(raw);
  if (!p.success) return null;
  return {
    kind: "collections_chase",
    overdueInvoices: p.data.overdueInvoices,
    invoices: p.data.invoices.map((i) => ({
      invoiceId: i.invoiceId,
      invoiceNumber: i.invoiceNumber,
      balanceCents: i.balanceCents,
      dueOn: i.dueOn,
    })),
  };
}

// A pay rule change's figures from its stored args, every field checked; null when they do not
// read back whole (the card then shows the title and amount only).
function ruleChangeOf(r: ProposalRow): RuleChangeView | null {
  if (r.kind !== "pay_rule_change" || typeof r.args !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(r.args);
  } catch {
    return null;
  }
  const parsed = changeArgsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    ruleKey: a.ruleKey,
    oldValue: a.oldValue,
    newValue: a.newValue,
    askedFrom: a.askedFrom,
    effectiveFrom: a.effectiveFrom,
    snapped: a.snapped,
    applied: a.applied,
    appliesTo: a.appliesTo,
    impact: {
      basis: a.impact.basis,
      periodId: a.impact.periodId,
      periodStart: a.impact.periodStart,
      periodEnd: a.impact.periodEnd,
      driversCompared: a.impact.driversCompared,
      driversChanged: a.impact.driversChanged,
      netDeltaCents: a.impact.netDeltaCents,
      ownerOperatorsOnly: a.impact.ownerOperatorsOnly,
      top: a.impact.top.map((t) => ({
        driverId: t.driverId,
        code: t.code,
        deltaCents: t.deltaCents,
        settlementId: t.settlementId,
      })),
    },
  };
}

function proposalView(r: ProposalRow): ProposalView {
  const reasons = parseArray(r.reasons).flatMap((x) => {
    const category = x && typeof x === "object" ? (x as Record<string, unknown>).category : null;
    return typeof category === "string"
      ? [{ category, text: reasonSentence(category), source: null }]
      : [];
  });
  for (const e of parseArray(r.exceptions)) {
    if (typeof e === "string" && SHOWN_EXCEPTIONS.has(e) && !reasons.some((x) => x.category === e)) {
      reasons.push({ category: e, text: reasonSentence(e), source: null });
    }
  }
  const engineCheck = engineCheckOf(r);
  const engineOverride = engineOverrideOf(r);
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
    // A parked advance never has a ledger row, so a parked one left executing (its payout refused
    // at the reserve) reads approved with its parked line, not unknown. A pull marked unknown moved
    // money its record could not finish (another amount confirmed, or the advance moved): never
    // failed or done whatever its ledger row says, since a person settles it.
    status:
      r.kind === "card_pullback" && r.pull_status === "unknown"
        ? "unknown"
        : isParkReason(r.park_reason) && r.money_state === null
          ? "approved"
          : cardStatusOf(r.status, r.money_state),
    flagged: r.flagged_input_id !== null,
    flagCategories: stringsOf(r.flag_categories),
    operatorVerdict: r.operator_verdict,
    auditorVerdict: r.auditor_verdict,
    auditorConcerns: stringsOf(r.auditor_concerns).filter((c) => CONCERN.test(c)),
    auditorCheckedAt: r.auditor_checked_at,
    auditorOverride: overrideOf(r),
    engineCheck,
    engineOverride,
    // Held for a person's reason (the approve gate asks the same): a waiting proposal whose
    // numbers did not match, while verifyEngineMismatchBlocks is on.
    engineHeld:
      engineCheck === "mismatch" && flags.verifyEngineMismatchBlocks && engineOverride === null && r.status === "proposed",
    destination: destinationOf(r),
    ...(r.kind === "detention_charge" ? { detention: detentionOf(r) } : {}),
    ...(r.kind === "advance_payout" ? { load: advanceLoadOf(r.args), parked: parkedOf(r) } : {}),
    ...(r.kind === "card_match" ? { cardMatch: cardMatchOf(r.args) } : {}),
    ...(r.kind === "card_load_ruling" ? { cardLoad: cardLoadOf(r.args, r.card_load_driver) } : {}),
    ...(r.kind === "card_pullback"
      ? { pull: pullViewOf(r.args, Number(r.amount_cents)), pullForPerson: r.pull_status === "unknown" }
      : {}),
    ...(CASH_KINDS.has(r.kind) ? { cash: cashOf(r) } : {}),
    ...(r.kind === "pay_rule_change" ? { ruleChange: ruleChangeOf(r) } : {}),
  };
}

// An advance parked after its approval (0079), read at render: its reason, whether a press may
// release it now (the parking switch, read now), and whether only an admin may (the approval went
// over a block or a mismatch). The executor asks all of it again; this only shapes the card.
function parkedOf(r: ProposalRow): ProposalView["parked"] {
  if (!isParkReason(r.park_reason)) return null;
  return {
    reason: r.park_reason,
    on: flags.advanceParking.enabled === true,
    adminOnly: r.auditor_override_at !== null || r.engine_override_at !== null,
  };
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const LAST4 = /^[0-9]{4}$/;

// Where an advance lands, read at render like the subject label. A proposal still waiting or
// approved names the card it would pay by its last four: the active card the proposal names, else
// the driver's default card; or a plain "no fuel card on file". A done proposal names the card its advance recorded, closed or not, and nothing without
// one. A rejected, expired, executing or failed proposal names no destination. Other kinds move no
// money to a card.
function destinationOf(r: ProposalRow): ProposalView["destination"] {
  if (r.kind !== "advance_payout") return null;
  const last4 = typeof r.card_last4 === "string" && LAST4.test(r.card_last4) ? r.card_last4 : null;
  if (r.status === "done") return last4 ? { label: cardLabel(last4), last4, testMode: true } : null;
  if (r.status !== "proposed" && r.status !== "approved") return null;
  return { label: last4 ? cardLabel(last4) : "no fuel card on file", last4, testMode: true };
}

const PROPOSAL_SQL = `
  SELECT p.id, p.kind, p.subject_table, p.subject_id,
         CASE p.subject_table
           WHEN 'drivers' THEN (SELECT d.code FROM drivers d WHERE d.id = p.subject_id)
           WHEN 'invoices' THEN (SELECT i.invoice_number FROM invoices i WHERE i.id = p.subject_id)
           WHEN 'loads' THEN (SELECT l.load_number FROM loads l
                               WHERE l.tenant_id = p.tenant_id AND l.id = p.subject_id)
           WHEN 'payment_applications' THEN (
             SELECT cp.payment_ref FROM payment_applications a
               JOIN customer_payments cp ON cp.tenant_id = a.tenant_id AND cp.id = a.payment_id
              WHERE a.tenant_id = p.tenant_id AND a.id = p.subject_id)
           WHEN 'card_transactions' THEN (SELECT 'card ending ' || t.card_last4 FROM card_transactions t
                                           WHERE t.tenant_id = p.tenant_id AND t.id = p.subject_id)
           WHEN 'vendor_bills' THEN (SELECT b.bill_ref FROM vendor_bills b
                                      WHERE b.tenant_id = p.tenant_id AND b.id = p.subject_id)
           WHEN 'customers' THEN (SELECT c.code FROM customers c
                                   WHERE c.tenant_id = p.tenant_id AND c.id = p.subject_id)
           WHEN 'pay_configs' THEN (SELECT CAST(c.effective_from AS text) FROM pay_configs c
                                     WHERE c.tenant_id = p.tenant_id AND c.id = p.subject_id)
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
           WHERE m.tenant_id = p.tenant_id AND m.cognito_sub = p.auditor_override_by) AS override_role,
         p.engine_check, p.engine_override_reason, ${ISO("p.engine_override_at")} AS engine_override_at,
         (SELECT m.role FROM memberships m
           WHERE m.tenant_id = p.tenant_id AND m.cognito_sub = p.engine_override_by) AS engine_override_role,
         CASE WHEN p.kind = 'advance_payout' AND p.subject_table = 'drivers' THEN
           CASE
             WHEN p.status IN ('proposed', 'approved') THEN
               (SELECT c.last4 FROM driver_cards c
                 WHERE c.tenant_id = p.tenant_id AND c.driver_id = p.subject_id AND c.status = 'active'
                   AND CASE WHEN p.args ->> 'cardId' IS NULL THEN c.is_default
                            ELSE CAST(c.id AS text) = p.args ->> 'cardId' END
                 LIMIT 1)
             WHEN p.status = 'done' THEN
               (SELECT c.last4 FROM advances a
                  JOIN driver_cards c ON c.tenant_id = a.tenant_id AND c.id = a.card_id
                                     AND c.driver_id = a.driver_id
                 WHERE a.tenant_id = p.tenant_id AND a.proposal_id = p.id AND a.driver_id = p.subject_id)
           END
         END AS card_last4,
         CASE WHEN p.kind IN ('detention_charge', 'advance_payout', 'card_match', 'factoring_request', 'bill_defer',
                             'collections_chase', 'pay_rule_change', 'card_load_ruling', 'card_pullback')
              THEN CAST(p.args AS text) END AS args,
         CASE WHEN p.kind = 'card_load_ruling' THEN
           (SELECT d.code FROM drivers d
             WHERE d.tenant_id = p.tenant_id AND CAST(d.id AS text) = p.args ->> 'driverId')
         END AS card_load_driver,
         CASE WHEN p.kind = 'advance_payout' AND p.status IN ('approved', 'executing') THEN
           (SELECT a.park_reason FROM advances a
             WHERE a.tenant_id = p.tenant_id AND a.proposal_id = p.id AND a.status = 'parked')
         END AS park_reason,
         CAST(p.exceptions AS text) AS exceptions,
         CASE WHEN p.kind = 'factoring_request' THEN
           (SELECT fr.status FROM factoring_requests fr WHERE fr.tenant_id = p.tenant_id AND fr.proposal_id = p.id)
         END AS factoring_status,
         CASE WHEN p.kind = 'card_pullback' THEN
           (SELECT cp.status FROM card_pullbacks cp WHERE cp.tenant_id = p.tenant_id AND cp.proposal_id = p.id)
         END AS pull_status
    FROM proposals p`;

// Proposals by id, for the sweep's run page (any staff member of the carrier sees a run's drafts,
// as the approve gate allows). Row security limits them to the carrier on the session.
export async function readProposalViews(q: Queryable, ids: readonly string[]): Promise<ProposalView[]> {
  // Only whole uuids go into the array literal.
  const safe = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (safe.length === 0) return [];
  const rows = await q.query<ProposalRow>(`${PROPOSAL_SQL} WHERE p.id = ANY(CAST($1 AS uuid[])) ORDER BY p.id`, [
    `{${safe.join(",")}}`,
  ]);
  return rows.map(proposalView);
}

async function viewOf(q: Queryable, t: TurnRow): Promise<TurnView> {
  const steps = await q.query<StepRow>(
    `SELECT id, seq, kind, label, state, CAST(detail->'report' AS text) AS report,
            detail->>'maskedFigures' AS masked_figures
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
  // A turn that ended without the loop's own last write (a failed store write, a lost request)
  // still reads with no item left in hand.
  const list = parseChecklist(t.checklist);
  const checklist = list && status !== "running" ? finalChecklist(list, status) : list;
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
    checklist,
    withheldFigures: withheldFiguresOf(steps),
  };
}

// How many figures in the answer's model steps were held back as not coming from a record
// (maskedFigures, operator/turn.ts), summed over the finished model steps. Null when any finished
// model step did not record a whole count, or none finished: unknown is not zero.
function withheldFiguresOf(steps: readonly StepRow[]): number | null {
  let total = 0;
  let seen = false;
  for (const s of steps) {
    if (s.kind !== "model" || s.state !== "done") continue;
    if (s.masked_figures === null || !/^[0-9]{1,6}$/.test(s.masked_figures)) return null;
    total += Number(s.masked_figures);
    seen = true;
  }
  return seen ? total : null;
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

// One turn, only if it is in a conversation this person started. A demo visit (visitId, the
// session's demoSessionId) sees only its own visit's conversations, since every judge shares one
// login; everyone else's are the ones with no visit.
export async function readTurnView(
  q: Queryable,
  sub: string,
  turnId: string,
  visitId: string | null = null,
): Promise<TurnView | null> {
  const rows = await q.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.id = CAST($1 AS uuid) AND c.created_by = $2
        AND c.demo_session_id IS NOT DISTINCT FROM CAST($3 AS uuid)`,
    [turnId, sub, visitId],
  );
  return rows.length === 1 ? viewOf(q, rows[0]) : null;
}

// This person's latest conversation (a demo visit's: its own latest), its last turns oldest
// first, for a page reload.
export async function readRecentTurnViews(
  q: Queryable,
  sub: string,
  visitId: string | null = null,
): Promise<TurnView[]> {
  const rows = await q.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM turns t
      WHERE t.conversation_id = (SELECT c.id FROM conversations c
                                  WHERE c.created_by = $1
                                    AND c.demo_session_id IS NOT DISTINCT FROM CAST($2 AS uuid)
                                  ORDER BY c.updated_at DESC, c.id LIMIT 1)
      ORDER BY t.seq DESC LIMIT ${RECENT_TURNS}`,
    [sub, visitId],
  );
  const out: TurnView[] = [];
  for (const r of rows.reverse()) out.push(await viewOf(q, r));
  return out;
}

// Every waiting pay rule change of the carrier, from any chat, oldest first: the Pay rules page's
// "Waiting for you". Any staff member sees them, as the approve gate allows.
export async function readWaitingRuleChangeViews(q: Queryable): Promise<ProposalView[]> {
  const rows = await q.query<ProposalRow>(
    `${PROPOSAL_SQL}
      WHERE p.tenant_id = current_tenant_id() AND p.kind = 'pay_rule_change'
        AND p.status IN ('proposed', 'approved', 'executing')
      ORDER BY p.created_at, p.id LIMIT 50`,
  );
  return rows.map(proposalView);
}

// The cards the rules engine made for one kind (the invoice queue), still waiting or running, for
// the page that lists them. Named tenant as well as row security, oldest first. subjectId: one
// record's card only (its record page), compared whole.
export async function readEngineProposalViews(
  q: Queryable,
  kind: ProposalView["kind"],
  limit = 200,
  subjectId: string | null = null,
): Promise<ProposalView[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("bad limit");
  if (subjectId !== null && !isUuid(subjectId)) throw new RangeError("bad subject id");
  const rows = await q.query<ProposalRow>(
    `${PROPOSAL_SQL}
      WHERE p.tenant_id = current_tenant_id() AND p.origin = 'engine' AND p.kind = $1
        AND p.status IN ('proposed', 'approved', 'executing')
        ${subjectId === null ? "" : "AND p.subject_id = CAST($2 AS uuid)"}
      ORDER BY p.created_at, p.id LIMIT ${limit}`,
    subjectId === null ? [kind] : [kind, subjectId.toLowerCase()],
  );
  return rows.map(proposalView);
}
