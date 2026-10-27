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
  // money actions (ledger)
  reserved: "Reserved",
  sent: "Sent",
  confirmed: "Confirmed",
  unknown: "Outcome unknown",
  failed: "Failed",
  // proposals
  proposed: "Waiting for approval",
  executing: "In progress",
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
  incomplete: "Cut short",
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

// A record's name for a link: "Load L-10421", or "Load ending 7c41e2" for a long generated id.
export function recordLabel(ref: { table: string; id: string }): string {
  const kind = sourceLabel(ref.table);
  return ref.id.length > 12 ? `${kind} ending ${ref.id.slice(-6)}` : `${kind} ${ref.id}`;
}
