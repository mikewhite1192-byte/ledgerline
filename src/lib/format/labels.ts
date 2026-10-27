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
  accessorial_pay: "Accessorial pay",
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
  load_accessorials: "Accessorial",
  driver_days: "Driver day",
  fuel_purchases: "Fuel purchase",
  pay_configs: "Pay rules",
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

// A record's name for a link. With the record's own reference, the words a person uses: "Load
// BR-L10244", or a driver's or customer's name alone. Without one: "Load L-10421", or "Load ending
// 7c41e2" for a long generated id.
export function recordLabel(ref: { table: string; id: string }, reference?: string | null): string {
  const kind = sourceLabel(ref.table);
  const named = reference?.trim();
  if (named) return NAMED_BY_REFERENCE.has(ref.table) ? named : `${kind} ${named}`;
  return ref.id.length > 12 ? `${kind} ending ${ref.id.slice(-6)}` : `${kind} ${ref.id}`;
}
