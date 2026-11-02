// The Settings > Autopilot page's words, shared by the page and its forms. Plain values only.

// Each kind of work the autopilot has a rule for, as the owner reads it.
export const RULE_KIND_LABELS: Readonly<Record<string, string>> = {
  advance_payout: "Driver advances",
  pay_correction: "Pay fixes",
  invoice_fix: "Invoice fixes",
  load_rate_fill: "Missing rates",
  invoice_post: "Sending invoices",
  payment_reapply: "Payment moves",
  settlement_approve: "Weekly settlements",
  detention_charge: "Detention charges",
  factoring_request: "Factoring requests",
  bill_defer: "Bill delays",
  collections_chase: "Payment reminders",
  pay_rule_change: "Pay rule changes",
  card_match: "Card matches",
  money_code: "Money codes",
  pay_policy_setup: "Pay rules setup",
  load_create: "New loads",
  escrow_release: "Escrow releases",
};

export const ruleKindLabel = (kind: string): string => RULE_KIND_LABELS[kind] ?? "Other work";

export const MODE_LABELS: Readonly<Record<string, string>> = { off: "Off", ask: "Ask me", auto: "Auto" };

export const RULES_LINK_LEAD = "What the autopilot may approve by itself is set on ";
export const RULES_LINK_LABEL = "Autopilot rules";

export const ADMIN_ONLY = "Only an admin sets the autopilot rules.";
export const NEVER_ALONE_NOTE = "A person always approves this, so Auto is not offered.";
export const NOT_ARMED_NOTE = "Auto is saved but waits until this kind is switched on.";

// A fixed message per category; nothing the server says is shown. Each table has an unknown one.
type Messages = Readonly<Record<string, string> & { unknown: string }>;

export const RULE_SAVE_MESSAGES: Messages = {
  not_found: "The autopilot rules are off for this carrier. Nothing was changed.",
  role: ADMIN_ONLY + " Nothing was changed.",
  forbidden: ADMIN_ONLY + " Nothing was changed.",
  bad_request: "That rule was not understood. Check each limit is a whole number. Nothing was changed.",
  never_alone: "A person always approves this kind, so it cannot be set to Auto. Nothing was changed.",
  over_ceiling: "A limit is above the most this kind allows. Nothing was changed.",
  changed: "Someone changed this rule a moment ago. The rule now shows as saved; check it and save again.",
  unknown: "The save did not confirm. Reload this page to see the rule as saved.",
};

export const PAUSE_MESSAGES: Messages = {
  disabled: "The autopilot is off. Nothing was changed.",
  role: "Only an admin can resume the autopilot. It stays paused.",
  forbidden: "Only staff of this carrier can pause the autopilot. Nothing was changed.",
  bad_request: "That was not understood. Nothing was changed.",
  unknown: "The change did not confirm. Reload this page to see the switch as saved.",
};

// Any other category ("unavailable" included) may follow a change that committed and lost its
// reply, so it reads as the table's unknown sentence: reload to see, never "try again".
export const messageFor = (table: Messages, category: string | null): string =>
  category !== null && Object.hasOwn(table, category) ? table[category] : table.unknown;
