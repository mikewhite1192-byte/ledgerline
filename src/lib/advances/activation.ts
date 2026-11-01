import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { ledgerRecordSql } from "../card-loads/facts";
import { getDb, type Queryable, type TenantDb } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { isLocalDate } from "../time/local-date";
import { readDefaultCard } from "./cards";
import { cardNameMatches, readCardStatementName, type IdentityCard } from "./identity";
import { readMember } from "./member";

// The activation checklist (design-s9, 0085): before an admin arms a driver who is not armed, three
// steps are on record with a person's name for the driver's default active card: the driver's
// identity confirmed against the card on file, a zero-dollar test sent to that card, and the card's
// loads acknowledged. Code refuses the arm (./arming.ts) while a step is missing, while the card's
// statement names someone else, or while a load on any of the driver's cards has no payment record
// and no ruling. The agent reads the checklist and says what is missing; it records no step and
// never arms.
//
// A step is about one card: a new default card starts the checklist over, and the old card's rows
// stay as history. What can go stale (the statement's name, the card's loads) is read again live at
// every arm. Nothing here is paid or sent: the zero-dollar test is sent from the card provider's
// side and an admin records that it was.
//
// Dedupe key: (tenant_id, driver_id, card_id, step), unique in 0085. The same click again writes
// nothing (changed false).

// The switch (flags.activationChecklist), read fresh on every call (never cached), so a switch
// turned off stops the next request. The route, recordActivationStep and armDriver each ask it.
export function activationOn(): boolean {
  return flags.activationChecklist?.enabled === true;
}

export const ACTIVATION_STEPS = ["identity_confirmed", "zero_test_sent", "hand_load_acknowledged"] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

// A whole-value membership test: a near miss (another case, a space, a prefix) is not a step.
export function isActivationStep(value: unknown): value is ActivationStep {
  return typeof value === "string" && (ACTIVATION_STEPS as readonly string[]).includes(value);
}

// What the arm is refused with, the never-alone words (src/lib/money/never-alone.ts), in this
// fixed order: the first one missing is the arm's category.
export const ARM_BLOCKERS = ["identity_confirm", "activate_without_zero_test", "activate_after_hand_load"] as const;
export type ArmBlocker = (typeof ARM_BLOCKERS)[number];

export type ActivationChecklist = {
  // The driver's default active card, by id and last four digits; null when there is none.
  card: { id: string; last4: string } | null;
  // Whether each step is on record for that card.
  steps: Record<ActivationStep, boolean>;
  // The card statement's latest name against the driver: no_statement when the statement has no
  // row for the card yet.
  identity: "match" | "mismatch" | "no_statement" | "no_card";
  // Loads on any of the driver's cards with no payment record and no ruling. null: the count did
  // not read as a whole number (unknown, which blocks).
  openHandLoads: number | null;
  blockers: ArmBlocker[];
};

export type ActivationFacts = Omit<ActivationChecklist, "blockers">;

// Pure: which blockers the facts leave, in ARM_BLOCKERS order. With no card nothing can be checked,
// so all three stand.
export function activationBlockers(facts: ActivationFacts): ArmBlocker[] {
  if (facts.card === null) return [...ARM_BLOCKERS];
  const out: ArmBlocker[] = [];
  if (!facts.steps.identity_confirmed || facts.identity === "mismatch") out.push("identity_confirm");
  if (!facts.steps.zero_test_sent) out.push("activate_without_zero_test");
  if (!facts.steps.hand_load_acknowledged || facts.openHandLoads !== 0) out.push("activate_after_hand_load");
  return out;
}

// The day before which a load never counts: the card load ruling's own start date, read as the
// ruling reads it (src/lib/card-loads/ruling.ts), so a load the ruling will never draft for does
// not block. A date that does not read counts every load (fails closed).
function handLoadStart(): string {
  const start = flags.cardLoadRuling?.startDate;
  return isLocalDate(start) ? start : "0001-01-01";
}

// A statement load on any card on the driver's file (any status: a closed card's unruled load is
// still the driver's), written to the records on or after the start date in the carrier's zone,
// with no payment record behind it (ledgerRecordSql: unknown is never "no record"), no deficit a
// ruling booked on it and no ruling done on it. The card token stays inside SQL.
const OPEN_HAND_LOADS_SQL = `SELECT CAST(count(*) AS text) AS n
    FROM card_transactions t
    JOIN tenants tn ON tn.id = t.tenant_id
    JOIN driver_cards c ON c.tenant_id = t.tenant_id AND c.provider = t.provider AND c.provider_token = t.card_token
   WHERE t.tenant_id = current_tenant_id() AND c.driver_id = CAST($1 AS uuid) AND t.kind = 'load'
     AND CAST((t.created_at AT TIME ZONE tn.timezone) AS date) >= CAST($2 AS date)
     AND NOT ${ledgerRecordSql("t.provider_ref", "t.provider", "t.card_token")}
     AND NOT EXISTS (SELECT 1 FROM driver_deficits dd WHERE dd.tenant_id = t.tenant_id
                       AND dd.source_kind = 'card_load' AND dd.source_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.tenant_id = t.tenant_id
                       AND pr.kind = 'card_load_ruling' AND pr.subject_id = t.id
                       AND pr.status = 'done' AND pr.decision_note IN ('owes_nothing', 'deficit'))`;

const STEPS_SQL = `SELECT step FROM driver_activation_steps
  WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND card_id = CAST($2 AS uuid)`;

async function openHandLoads(q: Queryable, driverId: string): Promise<number | null> {
  const rows = await q.query<{ n: string }>(OPEN_HAND_LOADS_SQL, [driverId, handLoadStart()]);
  if (rows.length !== 1) return null;
  const n = Number(rows[0].n);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// The checklist for one driver, inside a tenant transaction the caller holds (armDriver reads it
// under the driver's row lock, so a step recorded or a card changed in between is seen before or
// after, never half). Reads only.
export async function readActivationChecklist(q: Queryable, driverId: string): Promise<ActivationChecklist> {
  const none: Record<ActivationStep, boolean> = { identity_confirmed: false, zero_test_sent: false, hand_load_acknowledged: false };
  if (!isCanonicalUuid(driverId)) {
    const facts: ActivationFacts = { card: null, steps: none, identity: "no_card", openHandLoads: null };
    return { ...facts, blockers: activationBlockers(facts) };
  }
  const open = await openHandLoads(q, driverId);
  const card = await readDefaultCard(q, driverId);
  // A card the statement read cannot place (another driver's, a holder of no known kind) is no card.
  const names = card ? await readCardStatementName(q, driverId, card.id) : null;
  if (card === null || names === null) {
    const facts: ActivationFacts = { card: null, steps: none, identity: "no_card", openHandLoads: open };
    return { ...facts, blockers: activationBlockers(facts) };
  }
  const rows = await q.query<{ step: string }>(STEPS_SQL, [driverId, card.id]);
  const recorded = new Set(rows.map((r) => r.step).filter(isActivationStep));
  const steps: Record<ActivationStep, boolean> = {
    identity_confirmed: recorded.has("identity_confirmed"),
    zero_test_sent: recorded.has("zero_test_sent"),
    hand_load_acknowledged: recorded.has("hand_load_acknowledged"),
  };
  const identity = names.statementName === null ? "no_statement" : cardNameMatches(names) ? "match" : "mismatch";
  const facts: ActivationFacts = { card: { id: card.id, last4: card.last4 }, steps, identity, openHandLoads: open };
  return { ...facts, blockers: activationBlockers(facts) };
}

// What the driver page hands the panel: the checklist only when its card is the card the page's
// identity read labels Default (a whole-value compare; no card on both sides also agrees). The two
// are separate reads, so a default card changed between them would show one card as Default while
// Record sent the other's id; then no checklist is shown, and a reload shows the new card.
export function checklistForPage(
  cards: readonly Pick<IdentityCard, "id" | "status" | "isDefault">[],
  checklist: ActivationChecklist | null,
): ActivationChecklist | null {
  if (checklist === null) return null;
  const shown = cards.filter((c) => c.status === "active" && c.isDefault);
  if (shown.length > 1) return null;
  const shownId = shown.length === 1 ? shown[0].id : null;
  return (checklist.card?.id ?? null) === shownId ? checklist : null;
}

export type ActivationRefusal =
  | "disabled"
  | "bad_request"
  | "role"
  | "not_found"
  | "driver_inactive"
  | "no_card"
  | "card_changed"
  | "identity_mismatch"
  | "hand_load_open";

export type ActivationResult =
  | { ok: true; changed: boolean; checklist: ActivationChecklist }
  | { ok: false; category: ActivationRefusal; retryable: false };

const NOTE_MAX = 240;

const refuse = (category: ActivationRefusal): ActivationResult => ({ ok: false, category, retryable: false });

// An admin records one step on the driver's default active card. One tenant transaction with the
// driver row locked FOR UPDATE (the lock arming and the status change take). Each step has its own
// code check first, and a refusal writes nothing. The step names the card the page showed: when the
// driver's default card is another one now (an admin changed it since the page loaded), the step is
// card_changed and nothing is written, so a step is never recorded for a card nobody looked at.
//   identity_confirmed: a statement that names someone else is identity_mismatch (the fix is the
//     card or the statement, not the click); a card with no statement row yet records, with the
//     person's note.
//   zero_test_sent: the card is the driver's default active card of the simulated provider, so in
//     test mode (readDefaultCard reads no card of any other shape). The send itself happened
//     outside the app; this is the admin's record of it.
//   hand_load_acknowledged: no open load on the driver's cards (unknown counts as open), else
//     hand_load_open: the person rules on the load's card first; this click is not a ruling.
export async function recordActivationStep(
  session: Session,
  driverId: string,
  change: { step: string; cardId: string; note?: string | null },
  deps: { db?: TenantDb; clock?: () => Date; newId?: () => string } = {},
): Promise<ActivationResult> {
  // Asked here as well as on the route, so a caller that skips it is still refused.
  if (!activationOn()) return refuse("disabled");
  if (!isCanonicalUuid(driverId) || !isActivationStep(change.step) || !isCanonicalUuid(change.cardId)) {
    return refuse("bad_request");
  }
  const step = change.step;
  const note = typeof change.note === "string" && change.note.trim().length > 0 ? change.note.trim() : null;
  if (note !== null && note.length > NOTE_MAX) return refuse("bad_request");
  const db = deps.db ?? getDb();
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  const newId = deps.newId ?? randomUUID;
  return db.withTenant(session.tenantId, async (q) => {
    const member = await readMember(q, session);
    if (member.role !== "admin") return refuse("role");
    const rows = await q.query<{ active_to: string | null }>(
      `SELECT to_char(active_to, 'YYYY-MM-DD') AS active_to
         FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [driverId],
    );
    if (rows.length !== 1) return refuse("not_found");
    // A driver with a last day on file cannot be armed, so nothing is recorded toward it.
    if (rows[0].active_to !== null) return refuse("driver_inactive");
    const before = await readActivationChecklist(q, driverId);
    if (before.card === null) return refuse("no_card");
    // A whole-value compare of canonical ids, under the driver lock.
    if (before.card.id !== change.cardId) return refuse("card_changed");
    if (step === "identity_confirmed" && before.identity === "mismatch") return refuse("identity_mismatch");
    if (step === "hand_load_acknowledged" && before.openHandLoads !== 0) return refuse("hand_load_open");
    const written = await q.execute(
      `INSERT INTO driver_activation_steps (id, tenant_id, driver_id, card_id, step, note, membership_id, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, CAST($6 AS uuid),
               CAST($7 AS timestamptz))
       ON CONFLICT (tenant_id, driver_id, card_id, step) DO NOTHING`,
      [newId(), driverId, before.card.id, step, note, member.id, nowIso],
    );
    // Read back in the same transaction, so the answer is what the arm would now see.
    const checklist = await readActivationChecklist(q, driverId);
    return { ok: true, changed: written === 1, checklist } as const;
  });
}
