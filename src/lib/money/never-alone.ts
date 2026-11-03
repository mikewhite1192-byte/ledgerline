import { PROPOSAL_KINDS } from "../agent/gateway/types";

// The work that never happens alone: a named person always gives the yes. Pure, no database, no
// clock, no model. Money and autopilot code import it (src/lib/proposals/execute.ts, the reject
// path, src/lib/autopilot/policy.ts); agent code never does (the ledger allowlist in
// eslint.config.mjs refuses money/never-alone for src/lib/agent/**), so the model can explain a
// refusal by its code but never carries the rule.
//
// Three walls hold a never-alone kind away from the autopilot: the autopilot_rules check in
// 0077_never_alone.sql (mode auto only on AUTO_ALLOWED_KINDS), decide() refusing it with
// kind_never_alone before it reads the rule, and the approval gate refusing the autopilot login
// on it even if a rule row slipped in.

// The kinds the owner may set to Auto: the three that move nothing out of the company and the two
// that pay a driver inside the owner's per-driver day. The database check in 0077 lists exactly
// these. A load_move card is always a person's tap (0070's rule kind check has no load_move).
export const AUTO_ALLOWED_KINDS = [
  "invoice_post",
  "card_match",
  "payment_reapply",
  "advance_payout",
  "money_code",
] as const;
export type AutoAllowedKind = (typeof AUTO_ALLOWED_KINDS)[number];

const AUTO_ALLOWED: ReadonlySet<string> = new Set(AUTO_ALLOWED_KINDS);

// Every other proposal kind the code knows: a named person always approves it (D-072:
// settlement_approve stays Ask; a pay stub needs a person to review and tap Approve). A
// card_load_ruling books what a driver owes, so it is never alone by construction, and a
// card_pullback takes money back off a driver's card, so it is too, and a deficit_book (a cancelled
// trip's advance booked as owed) books what a driver owes, as a card_load_ruling does.
export const NEVER_ALONE_KINDS: readonly string[] = PROPOSAL_KINDS.filter((k) => !AUTO_ALLOWED.has(k));

const NEVER_ALONE: ReadonlySet<string> = new Set(NEVER_ALONE_KINDS);

// The refusal words, as stable codes a route returns and the agent explains in a line. Brokerage
// words ship now so a request gets "not yet, and never by the model" before that lane exists.
export const NEVER_ALONE_REFUSALS = [
  "advance_start",
  "take_off_card",
  "reject_after_money_moved",
  "load_past_room",
  "override",
  "name_reordered",
  "activate_after_hand_load",
  "activate_without_zero_test",
  "identity_confirm",
  "stub_delete_or_rebuild",
  "net_over_cap",
  "contradicting_line",
  "deficit_without_named_person",
  "send_invoice",
  "send_stub",
  "pay_card_statement",
  "escrow_return",
  "bonus_pay",
  // Brokerage.
  "sell_price",
  "mismatched_bill",
  "bank_details",
  "pay_carrier",
  "over_limit",
  "accounting_change_void_delete",
] as const;
export type NeverAloneRefusal = (typeof NEVER_ALONE_REFUSALS)[number];

export function isNeverAloneRefusal(value: unknown): value is NeverAloneRefusal {
  return typeof value === "string" && (NEVER_ALONE_REFUSALS as readonly string[]).includes(value);
}

// A kind the owner may set to Auto. Whole values only: an inherited name or a near spelling is not.
export function autoAllowed(kind: unknown): kind is AutoAllowedKind {
  return typeof kind === "string" && AUTO_ALLOWED.has(kind);
}

// One of the known proposal kinds that are never alone.
export function isNeverAloneKind(kind: unknown): boolean {
  return typeof kind === "string" && NEVER_ALONE.has(kind);
}

// The approver must be a person's membership, never the autopilot or a service login. Fails
// closed: any kind not on the Auto allowlist, an unknown one too, needs a person.
export function namedPersonRequired(kind: unknown): boolean {
  return !autoAllowed(kind);
}

// A person may reject a proposal only while no money has left for it: no ledger row, or one that
// failed (nothing left). Reserved (the call may be on its way), sent, confirmed and unknown are
// refused, and so is any state that does not read. null means no money_actions row.
export function rejectAllowed(ledgerState: string | null): boolean {
  return ledgerState === null || ledgerState === "failed";
}
