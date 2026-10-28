// Plain-English words for the codes stored in the database. A screen never shows a raw code: an
// unknown one degrades to words ("partly_shipped" reads "Partly shipped").

const STATUS_LABELS: Record<string, string> = {
  // loads
  planned: "Planned",
  in_transit: "In transit",
  delivered: "Delivered",
  invoiced: "Invoiced",
  cancelled: "Canceled",
  // advances
  requested: "Requested",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected",
  // settlements and periods
  draft: "Draft",
  open: "Open",
  // invoices
  void: "Void",
  partially_paid: "Partly paid",
  past_due: "Past due",
  // money actions (ledger). A reserved row is approved but not sent yet: if its sender stopped
  // there, it goes out on the next try, so it never says it is being sent.
  reserved: "Waiting to send",
  sent: "Sent",
  confirmed: "Confirmed",
  // The outcome is not read back yet: it is checked again, and nothing is paid twice.
  unknown: "Not confirmed yet",
  failed: "Failed",
  // proposals
  proposed: "Waiting for approval",
  // Already approved and being carried out, between Approved and Done.
  executing: "Processing",
  done: "Done",
  expired: "Expired",
  // portal runs
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for a person",
  declined: "Declined",
  stopped: "Stopped",
  // model calls
  ok: "Answered",
  incomplete: "Stopped early",
  // invoice review (the same words as the invoice screens' review labels)
  sync_error: "Accounting sync error",
  rate_mismatch: "Rate mismatch",
  missing_documents: "Missing documents",
  duplicate_warning: "Duplicate warning",
  needs_review: "Needs review",
  ready_to_send: "Ready to send",
};

const LINE_KIND_LABELS: Record<string, string> = {
  load_pay: "Load pay",
  accessorial_pay: "Extra pay",
  reimbursement: "Reimbursement",
  fuel: "Fuel",
  other_deduction: "Other deduction",
  carried_shortfall: "Carried from last period",
  lease: "Truck lease",
  insurance: "Insurance",
  escrow: "Escrow",
  advance_recovery: "Advance repaid",
};

export const KNOWN_STATUSES: readonly string[] = Object.keys(STATUS_LABELS);
export const KNOWN_LINE_KINDS: readonly string[] = Object.keys(LINE_KIND_LABELS);

// "past_due" reads "Past due". Never throws.
export function codeToWords(code: string): string {
  const words = code.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!words) return "Not set";
  return words[0].toUpperCase() + words.slice(1);
}

export function statusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : codeToWords(status);
}

// A model call's status. Its row is reserved while the call is out, unlike a money action's, so
// there it reads "Being sent"; every other status reads as statusLabel says.
export function modelCallStatusLabel(status: string): string {
  return status === "reserved" ? "Being sent" : statusLabel(status);
}

export function lineKindLabel(kind: string): string {
  return Object.hasOwn(LINE_KIND_LABELS, kind) ? LINE_KIND_LABELS[kind] : codeToWords(kind);
}

const SOURCE_LABELS: Record<string, string> = {
  customers: "Customer",
  drivers: "Driver",
  loads: "Load",
  load_state_miles: "State miles",
  load_accessorials: "Extra charge",
  driver_days: "Driver day",
  fuel_purchases: "Fuel purchase",
  pay_configs: "Pay rules",
  pay_rule_changes: "Pay rule change",
  deduction_schedules: "Deduction schedule",
  pay_items: "Pay item",
  advances: "Advance",
  settlement_periods: "Pay period",
  settlements: "Settlement",
  settlement_lines: "Paystub line",
  invoices: "Invoice",
};

// What kind of record a source is, in words: "loads" reads "Load".
export function sourceLabel(table: string): string {
  return Object.hasOwn(SOURCE_LABELS, table) ? SOURCE_LABELS[table] : codeToWords(table);
}

// Records a person knows by name: the name alone is the label ("Monique Vasquez", never "Driver
// Monique Vasquez").
const NAMED_BY_REFERENCE = new Set(["drivers", "customers"]);

// An id longer than this is a generated one, which means nothing to a person.
const LONG_ID = 12;

type RecordRef = { table: string; id: string };

// A record's name for a link. With the record's own reference, the words a person uses: "Load
// BR-L10244", or a driver's or customer's name alone. Without one: "Load L-10421" for a short id,
// and the kind alone ("Load") for a long generated id.
export function recordLabel(ref: RecordRef, reference?: string | null): string {
  const kind = sourceLabel(ref.table);
  const named = reference?.trim();
  if (named) return NAMED_BY_REFERENCE.has(ref.table) ? named : `${kind} ${named}`;
  return ref.id.length > LONG_ID ? kind : `${kind} ${ref.id}`;
}

// Names for the records one block shows side by side (a card, a trace, one paystub line). A record
// named by its kind alone would read the same as another of its kind, so when the block holds two
// or more different ones, each also says its place among them ("Load 1 of 2", "Load 2 of 2"). The
// links can then be told apart without showing a database id, and one record keeps one name.
export function recordNamer(refs: readonly RecordRef[]): (ref: RecordRef) => string {
  const byKind = new Map<string, string[]>();
  const keyOf = (r: RecordRef) => `${r.table}:${r.id}`;
  for (const r of refs) {
    if (r.id.length <= LONG_ID) continue;
    const kind = sourceLabel(r.table);
    const keys = byKind.get(kind) ?? [];
    if (!keys.includes(keyOf(r))) keys.push(keyOf(r));
    byKind.set(kind, keys);
  }
  return (ref) => {
    const label = recordLabel(ref);
    if (ref.id.length <= LONG_ID) return label;
    const keys = byKind.get(sourceLabel(ref.table)) ?? [];
    const at = keys.indexOf(keyOf(ref));
    return keys.length > 1 && at >= 0 ? `${label} ${at + 1} of ${keys.length}` : label;
  };
}

// Step labels saved with a turn before the plain words, and the few fixed ones that still say an
// internal word, read in plain words wherever a step is shown. The saved label is never changed.
const STEP_LABEL_WORDS: Record<string, string> = {
  "Reading the pay ledger": "Reading the pay records",
  "Aging the receivables": "Sorting open invoices by how late they are",
  "Building the receivables aging report": "Building the report of open balances by how late they are",
  "Reading the proposal and its evidence": "Reading the card and its evidence",
  "Asking Muse Wonder to form the proposal": "Asking Muse Wonder to form the card",
  "Preparing a proposal card": "Preparing a card",
};

export function stepLabel(label: string): string {
  return Object.hasOwn(STEP_LABEL_WORDS, label) ? STEP_LABEL_WORDS[label] : label;
}

// How a customer pays (rules-engine paymentProfile): "repeat_late" reads "Often late".
const PAYMENT_HABIT_LABELS: Record<string, string> = {
  reliable: "Reliable",
  mixed: "Mixed",
  repeat_late: "Often late",
};

export function paymentHabitLabel(habit: string): string {
  return Object.hasOwn(PAYMENT_HABIT_LABELS, habit) ? PAYMENT_HABIT_LABELS[habit] : codeToWords(habit);
}
