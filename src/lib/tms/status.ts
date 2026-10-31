// TMS-MIRROR: a dispatch system's statuses as fixed internal codes. Tenants relabel the built-in
// statuses and add their own, so a per-tenant label map (tms_connections.label_map, label lower
// cased and trimmed, whole) turns a label into a code; a label the map does not hold is `custom`
// and never moves anything. Only in_transit and delivered can move a load. Pure.

export const TMS_STATUS_CODES = [
  "new",
  "tendered",
  "booked",
  "in_transit",
  "delivered",
  "review",
  "pay_ready",
  "finalized",
  "invoice_hold",
  "invoiced",
  "paid",
  "on_hold",
  "breakdown",
  "claim",
  "board",
  "archived",
  "expired",
  "cancelled",
  "custom",
] as const;
export type TmsStatusCode = (typeof TMS_STATUS_CODES)[number];

// The synthetic feed's own labels, one per code but custom. The seed fills a tenant's map from them.
export const SYNTHETIC_LABELS: Record<Exclude<TmsStatusCode, "custom">, string> = {
  new: "New",
  tendered: "Tendered",
  booked: "Booked",
  in_transit: "In Transit",
  delivered: "Delivered",
  review: "Needs Review",
  pay_ready: "Pay Ready",
  finalized: "Finalized",
  invoice_hold: "Holding Invoice",
  invoiced: "Invoiced",
  paid: "Paid",
  on_hold: "On Hold",
  breakdown: "Breakdown",
  claim: "Damage Claim",
  board: "Load Board",
  archived: "Archived",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const MAX_LABEL = 60;

export function isTmsStatusCode(value: unknown): value is TmsStatusCode {
  return typeof value === "string" && (TMS_STATUS_CODES as readonly string[]).includes(value);
}

export function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

// The label map the synthetic feed needs: every synthetic label to its code.
export function syntheticLabelMap(): Record<string, TmsStatusCode> {
  const out: Record<string, TmsStatusCode> = {};
  for (const [code, label] of Object.entries(SYNTHETIC_LABELS)) out[labelKey(label)] = code as TmsStatusCode;
  return out;
}

// A stored map, read strictly: an object of bounded labels to known codes; anything else is empty
// (every label then reads custom, so nothing moves on a map that cannot be read).
export function readLabelMap(value: unknown): Record<string, TmsStatusCode> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, TmsStatusCode> = {};
  for (const [label, code] of Object.entries(value as Record<string, unknown>)) {
    if (label.length === 0 || label.length > MAX_LABEL || label !== labelKey(label) || !isTmsStatusCode(code)) return {};
    out[label] = code;
  }
  return out;
}

// A label to its code, by the whole lower-cased label; unmapped is custom.
export function codeOf(label: string | null, labelMap: Record<string, TmsStatusCode>): TmsStatusCode {
  if (label === null) return "custom";
  const key = labelKey(label);
  return Object.prototype.hasOwnProperty.call(labelMap, key) ? labelMap[key] : "custom";
}

// The move a code asks for, if any.
export function moveOf(code: TmsStatusCode): "in_transit" | "delivered" | null {
  return code === "in_transit" || code === "delivered" ? code : null;
}

// Withdrawn upstream: a load that never ran (or stopped running) on the dispatch side.
export function isWithdrawn(code: TmsStatusCode): boolean {
  return code === "cancelled" || code === "expired" || code === "archived";
}

// Past finalize: the cool-off and the edited-after-finalize flag apply.
export function isFinalized(code: TmsStatusCode): boolean {
  return code === "finalized" || code === "invoiced" || code === "paid";
}

export const DOC_KINDS = [
  "proof_of_pickup",
  "proof_of_delivery",
  "bill_of_lading",
  "leg_bol",
  "rate_confirmation",
  "invoice",
  "quote",
  "other",
] as const;
export type TmsDocKind = (typeof DOC_KINDS)[number];

const DOC_LABELS: Record<string, TmsDocKind> = {
  "proof of pickup": "proof_of_pickup",
  "proof of delivery": "proof_of_delivery",
  pod: "proof_of_delivery",
  "bill of lading": "bill_of_lading",
  bol: "bill_of_lading",
  "leg bol": "leg_bol",
  "rate confirmation": "rate_confirmation",
  "rate con": "rate_confirmation",
  invoice: "invoice",
  quote: "quote",
};

// A document's type label to our kind, whole; a tenant's own type is other.
export function docKindOf(typeLabel: string): TmsDocKind {
  const key = labelKey(typeLabel);
  return Object.prototype.hasOwnProperty.call(DOC_LABELS, key) ? DOC_LABELS[key] : "other";
}
