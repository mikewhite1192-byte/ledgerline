// The fixed sentence a proposal card shows for each reason category. Cards never show model
// prose: the operator picks categories from the tool's enum, the gateway adds exceptions, and
// this table turns each into words. An unknown category shows the generic line.

const SENTENCES: Readonly<Record<string, string>> = {
  // propose_advance
  earned_unpaid_covers: "Earned, unpaid pay this week covers the advance.",
  open_advance_exists: "The driver already has an open advance; it counts against the limit.",
  over_cap: "The ask was over the limit, so the amount is the most the rules allow.",
  fee_applies: "The carrier's advance fee applies.",
  driver_asked: "The driver asked for it.",
  // gateway exceptions
  capped_to_eligible: "Cut to the most the pay rules allow after a larger ask was refused.",
  // propose_pay_correction
  missed_pay: "Pay the driver earned is missing from the statement.",
  wrong_rate: "The pay line used the wrong rate.",
  wrong_driver: "The pay was put on the wrong driver.",
  duplicate_charge: "The same charge was taken twice.",
  missing_reimbursement: "A reimbursement the driver is owed is missing.",
  charge_not_owed: "The driver was charged for a day with no load.",
  // propose_invoice_fix
  rate_mismatch: "The invoice does not match the load's agreed rate.",
  missing_accessorial: "An accessorial on the load is missing from the invoice.",
  fuel_surcharge_wrong: "The fuel surcharge on the invoice is wrong.",
  duplicate_line: "The same line appears twice on the invoice.",
  // propose_load_rate
  missing_rate: "The load has no rate yet; this fills it from the load's rate confirmation.",
  // the rules engine's advance reasons
  driver_inactive: "The driver is not active on that date.",
  below_minimum: "The amount is below the carrier's minimum advance.",
  no_unpaid_earnings: "The driver has no earned, unpaid pay to advance against.",
  over_driver_limit: "The amount is over the driver's advance limit.",
  exceeds_earned_share: "The amount is over the share of earned pay the rules allow.",
  possible_duplicate: "A similar advance was asked for recently.",
  // the invoice queue (engine proposals)
  engine_total: "The rules engine computed this total from the load's rate and charges.",
  // propose_payment_reapply
  payment_on_wrong_invoice:
    "The payment matches another open invoice for the same customer exactly, and overpays the one it is on.",
  // the sweep's second opinion: an issue a driver's check raised that the rules engine did not
  sub_agent_flag:
    "A second check of this driver's week pointed at this record and the rules engine did not. Look at the record before paying.",
};

const GENERIC = "A rule check found this.";

export function reasonSentence(category: string): string {
  return Object.prototype.hasOwnProperty.call(SENTENCES, category) ? SENTENCES[category] : GENERIC;
}

// Every category a sentence exists for, for tests.
export const REASON_SENTENCE_CATEGORIES: readonly string[] = Object.keys(SENTENCES);

// Screen categories, as the flagged quote block names them.
const FLAG_WORDS: Readonly<Record<string, string>> = {
  instruction_to_agent: "instructions to the assistant",
  authority_claim: "a claim of authority",
  urgency_pressure: "pressure to act fast",
  amount_or_payee_change: "a change of amount or payee",
  data_exfiltration: "a request for data",
  off_policy_request: "an off-policy request",
  pattern_match: "a known attack pattern",
  parse_failed: "a screen that could not be read",
  screen_error: "a screen that did not finish",
};

export function flagWords(categories: readonly string[]): string {
  const words = categories.map((c) =>
    Object.prototype.hasOwnProperty.call(FLAG_WORDS, c) ? FLAG_WORDS[c] : "a screening flag",
  );
  return [...new Set(words)].join(", ") || "a screening flag";
}
