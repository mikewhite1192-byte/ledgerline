import type { TenantTable } from "./tables";

// One tenant table row as the seed writes it and the readers return it: the columns of
// TABLE_SPECS, snake_case, without tenant_id and created_at. Money is integer cents, dates are
// tenant-local YYYY-MM-DD strings, instants are ISO strings in UTC ending in Z.

export type CustomerRow = {
  id: string;
  code: string;
  name: string;
  terms_days: number;
  city: string;
  state: string;
  detention_free_minutes: number;
  detention_hourly_cents: number;
  // Whether the customer wants a signed delivery document with each invoice.
  pod_required: boolean;
  // Where the accounting system would email the invoice: a synthetic .example address, or none.
  billing_email: string | null;
};

export type DriverRow = {
  id: string;
  code: string;
  first_name: string;
  last_name: string;
  email: string;
  worker_type: "company" | "owner_operator";
  pay_basis: "per_mile" | "percent" | "flat";
  per_mile_cents: number | null;
  percent_bps: number | null;
  flat_per_load_cents: number | null;
  advance_limit_cents: number | null;
  escrow_balance_cents: number;
  truck_unit: string | null;
  tank_gallons: number;
  active_from: string;
  active_to: string | null;
  // The language the driver's pay note is written in (migration 0019).
  preferred_language: "en" | "es";
  // Armed to receive money, separate from the card (0027). Off until a person arms the driver.
  money_armed: boolean;
  money_armed_at: string | null;
  // The driver carries their own insurance, so no daily insurance charge applies (0032).
  own_insurance: boolean;
};

// A fuel card on file (0017): the provider's own token and the last four digits only. A driver
// may hold several (0027); the one active default is the card paid. A generic card's portal name
// is a placeholder the provider's portal shows, never a person's name.
export type DriverCardRow = {
  id: string;
  driver_id: string;
  rail: "fuel_card";
  provider: "fuel_card_sim";
  provider_token: string;
  last4: string;
  status: "active" | "closed";
  sim_behavior: "ok" | "declined" | "slow" | "offline";
  source: "seed" | "ui" | "recon";
  closed_at: string | null;
  is_default: boolean;
  holder_kind: "named" | "generic";
  portal_name: string | null;
};

// The id another system knows a driver by (0027).
export type DriverIdentityRow = {
  id: string;
  driver_id: string;
  system: "tms";
  external_id: string;
  source: "seed" | "ui" | "recon";
};

// One arm or disarm, append-only (0027). The seed's rows name no member.
export type DriverArmEventRow = {
  id: string;
  driver_id: string;
  armed: boolean;
  note: string | null;
  membership_id: string | null;
  source: "seed" | "ui";
};

export type LoadRow = {
  id: string;
  load_number: string;
  customer_id: string;
  driver_id: string | null;
  status: "planned" | "in_transit" | "delivered" | "invoiced" | "cancelled";
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  pickup_on: string;
  delivered_on: string | null;
  delivered_at: string | null;
  loaded_miles: number;
  empty_miles: number;
  linehaul_cents: number | null;
  fuel_surcharge_cents: number;
  pickup_arrived_at: string | null;
  pickup_departed_at: string | null;
  delivery_arrived_at: string | null;
  delivery_departed_at: string | null;
};

export type LoadStateMilesRow = { id: string; load_id: string; state: string; miles: number };

export type LoadAccessorialRow = {
  id: string;
  load_id: string;
  kind: "detention" | "layover" | "stop" | "lumper";
  seq: number;
  amount_cents: number;
  paid_by_driver: boolean;
  description: string;
};

export type DriverDayRow = {
  id: string;
  driver_id: string;
  day: string;
  source: "load" | "dispatch";
  load_id: string | null;
};

export type FuelPurchaseRow = {
  id: string;
  driver_id: string;
  load_id: string | null;
  purchased_at: string;
  purchased_on: string;
  state: string;
  gallons_milli: number;
  amount_cents: number;
  paid_with: "company_card" | "driver_own";
  purchase_ref: string;
};

// The knobs of one pay rules version, without its key and date.
export type PayConfigKnobs = {
  week_start_dow: number;
  percent_base: "linehaul" | "linehaul_fsc" | "linehaul_fsc_accessorials";
  empty_miles_paid_bps: number;
  accessorial_driver_share_bps: number;
  insurance_applies_to: "owner_operator" | "all";
  insurance_per_day_cents: number;
  escrow_target_cents: number;
  escrow_per_settlement_cents: number;
  net_pay_floor_cents: number;
  advance_recovery_cap_cents: number | null;
  advance_fee_cents: number;
  advance_limit_default_cents: number;
  advance_max_bps_of_earned: number;
  advance_min_cents: number;
  // Advances on one load capped at this share of the driver's pay for it; null is no cap (0027).
  advance_per_load_bps_of_pay: number | null;
};

export type PayConfigRow = PayConfigKnobs & {
  id: string;
  effective_from: string;
  note: string | null;
  // "proposal": written by a person's approval of a pay rule change (migration 0030).
  source: "seed" | "ui" | "proposal";
};

// One executed pay rule change (migration 0030): the diff a person approved, beside the version
// it created or edited. Not a TenantRows table: the seed never writes it. The demo reset clears it
// (demo_reset_clear, re-created in 0036), and npm run seed's replace through the pay_configs
// cascade.
export type PayRuleChangeRow = {
  id: string;
  pay_config_id: string;
  proposal_id: string | null;
  rule_key: string;
  old_value: string;
  new_value: string;
  asked_from: string;
  effective_from: string;
  applied: "new_version" | "edited_version";
  decided_by: string;
  created_at: string;
};

export type DeductionScheduleRow = {
  id: string;
  driver_id: string;
  kind: "escrow" | "lease" | "other";
  amount_cents: number;
  target_cents: number | null;
  description: string;
  active_from: string;
  active_to: string | null;
};

export type SettlementPeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
  status: "open" | "approved" | "paid";
};

export type SettlementRow = {
  id: string;
  period_id: string;
  driver_id: string;
  pay_config_id: string;
  status: "draft" | "approved" | "paid";
  gross_cents: number;
  deductions_cents: number;
  net_cents: number;
  carry_forward_cents: number;
  exception_count: number;
  paid_at: string | null;
  // What the paid settlement did to escrow (0032): closing = opening - charges + withheld. A draft
  // keeps zeros until it is booked.
  escrow_opening_cents: number;
  escrow_charges_cents: number;
  escrow_withheld_cents: number;
  escrow_closing_cents: number;
  // A draft whose lines no longer matched their sources at approval (0032); both null otherwise.
  parked_reason: string | null;
  parked_at: string | null;
};

export type SettlementLineRow = {
  id: string;
  settlement_id: string;
  seq: number;
  kind: string;
  label: string;
  amount_cents: number;
  sources: { table: string; id: string }[];
  meta: Record<string, string | number | boolean | null> | null;
};

export type PayItemRow = {
  id: string;
  driver_id: string;
  kind: "fuel" | "reimbursement" | "other_deduction" | "carried_shortfall";
  subkind: string;
  amount_cents: number;
  item_date: string;
  // "proposals": a pay correction a person approved (item_ref correction:<proposal id>).
  ref_table: "fuel_purchases" | "load_accessorials" | "loads" | "settlements" | "proposals" | null;
  ref_id: string | null;
  item_ref: string;
  description: string;
  settlement_id: string | null;
};

export type AdvanceRow = {
  id: string;
  driver_id: string;
  request_ref: string;
  requested_at: string;
  requested_on: string;
  amount_cents: number;
  fee_cents: number;
  status: "requested" | "approved" | "paid" | "rejected" | "cancelled";
  recovered_cents: number;
  source: "ui" | "email" | "seed";
  reason_category: string | null;
  paid_at: string | null;
  proposal_id: string | null;
  source_input_id: string | null;
  decided_at: string | null;
  decided_by_membership_id: string | null;
  // The load the advance is for, and a take-back (0027).
  load_id: string | null;
  taken_back_cents: number;
  taken_back_at: string | null;
  taken_back_by_membership_id: string | null;
  takeback_reason: string | null;
};

export type InvoiceRow = {
  id: string;
  source: "load" | "opening";
  load_id: string | null;
  customer_id: string;
  invoice_number: string;
  amount_cents: number;
  issued_on: string;
  due_on: string;
  status: "open" | "partially_paid" | "paid" | "void";
  paid_on: string | null;
  qbo_id: string | null;
  // Review facts (0028). The review status is computed from these, never stored.
  reviewed_at: string | null;
  reviewed_by_membership_id: string | null;
  review_note: string | null;
  sent_on: string | null;
  sent_by_membership_id: string | null;
  qbo_email_status: "not_set" | "need_to_send" | "email_sent" | null;
  qbo_amount_cents: number | null;
};

export type CustomerPaymentRow = {
  id: string;
  customer_id: string;
  received_on: string;
  amount_cents: number;
  method: "check" | "ach" | "wire";
  payment_ref: string;
  source: "ui" | "email" | "seed";
  memo: string | null;
  qbo_id: string | null;
};

export type PaymentApplicationRow = {
  id: string;
  payment_id: string;
  invoice_id: string;
  amount_cents: number;
};

export type UntrustedInputRow = {
  id: string;
  kind: "email" | "transcript" | "document" | "portal";
  source: "inbound" | "upload" | "voice" | "seed_benign" | "seed_injection" | "portal_run";
  driver_id: string | null;
  from_address: string | null;
  subject: string | null;
  body_text: string;
  content_hash: string;
  received_at: string;
  seed_key: string | null;
};

export type ScreeningRow = {
  id: string;
  input_id: string;
  content_hash: string;
  screener_version: number;
  verdict: "clean" | "flagged";
  categories: string[];
  confidence_milli: number | null;
  via: "model" | "cache" | "pattern" | "error";
  model_call_id: string | null;
  latency_ms: number;
  expires_at: string | null;
};

// A reminder for a late invoice (0041). The seed plants none: the demo presses Draft reminders.
export type CollectionDraftRow = {
  id: string;
  invoice_id: string;
  customer_id: string;
  stage: "30" | "60" | "90";
  tone: "friendly" | "direct" | "firm";
  status: "drafting" | "drafted" | "refused" | "over_cap" | "approved" | "rejected";
  figures: Record<string, unknown>;
  subject: string | null;
  body: string | null;
  refusal_category: string | null;
  verification: Record<string, unknown> | null;
  trace_id: string;
  model_call_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  channel: "logged" | "email" | null;
  sent_at: string | null;
  updated_at: string;
};

// One brief (0042). figures, body and verification are jsonb whose shape each kind defines
// (src/lib/briefs); the seed plants none.
export type BriefRow = {
  id: string;
  kind: "profit_week" | "quarter";
  period_start: string;
  period_end: string;
  as_of: string;
  status: "drafting" | "drafted" | "refused" | "over_cap" | "superseded";
  figures: unknown[];
  body: Record<string, unknown> | null;
  refusal_category: string | null;
  verification: Record<string, unknown> | null;
  model: "spark" | "wonder" | null;
  trace_id: string | null;
  model_call_id: string | null;
  created_by: string;
  updated_at: string;
};

// A carrier note (0040): a short line of context the office keeps about a customer, a driver or
// the carrier as a whole. subject_id is null for the whole carrier. Only an active note reaches
// the agent. created_at and updated_at are the database's own, so they are not listed.
export type CarrierNoteRow = {
  id: string;
  subject_kind: "customer" | "driver" | "carrier";
  subject_id: string | null;
  text: string;
  status: "suggested" | "active";
  source_kind: "chat" | "record" | "person" | "seed";
  source_turn_id: string | null;
  source_table: string | null;
  source_id: string | null;
  created_by_kind: "person" | "agent" | "seed";
  created_by_sub: string | null;
  created_by_model_call_id: string | null;
  updated_by_sub: string | null;
};

export type TenantRows = {
  customers: CustomerRow[];
  drivers: DriverRow[];
  driver_cards: DriverCardRow[];
  driver_identities: DriverIdentityRow[];
  driver_arm_events: DriverArmEventRow[];
  loads: LoadRow[];
  load_state_miles: LoadStateMilesRow[];
  load_accessorials: LoadAccessorialRow[];
  driver_days: DriverDayRow[];
  fuel_purchases: FuelPurchaseRow[];
  pay_configs: PayConfigRow[];
  deduction_schedules: DeductionScheduleRow[];
  settlement_periods: SettlementPeriodRow[];
  settlements: SettlementRow[];
  settlement_lines: SettlementLineRow[];
  pay_items: PayItemRow[];
  advances: AdvanceRow[];
  invoices: InvoiceRow[];
  customer_payments: CustomerPaymentRow[];
  payment_applications: PaymentApplicationRow[];
  untrusted_inputs: UntrustedInputRow[];
  screenings: ScreeningRow[];
  collection_drafts: CollectionDraftRow[];
  briefs: BriefRow[];
  carrier_notes: CarrierNoteRow[];
};

// Compile-time proof that TenantRows has exactly one key per table.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const ROWS_COVER_TABLES: Exact<keyof TenantRows, TenantTable> = true;
