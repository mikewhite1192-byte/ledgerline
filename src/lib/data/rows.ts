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

// One move of a load (0071, src/lib/loads/movement.ts). The seed writes one per status change
// in its history, source seed, naming no evidence.
export type LoadEventRow = {
  id: string;
  load_id: string;
  from_status: "planned" | "in_transit";
  to_status: "in_transit" | "delivered";
  source: "driver_photo" | "driver_text" | "driver_voice" | "staff" | "demo_feed" | "seed" | "tms";
  evidence_table: "documents" | "inbound_messages" | "voice_notes" | "tms_status_events" | null;
  evidence_id: string | null;
  at: string;
};

// The dispatch mirror (0075, src/lib/tms/sync.ts). The seed writes the snapshot the synthetic feed
// serves at the seeded instant (src/lib/seed/tms.ts); the sync's own bookkeeping columns (read
// attempts, the rest mark, the tombstone, the token cache, the last pass) are runtime only.
export type TmsConnectionRow = {
  id: string;
  system: "synthetic";
  label_map: Record<string, string>;
  lookback_hours: number;
  finalize_cooloff_minutes: number;
  demo_faults: Record<string, boolean>;
  feed_floor_at: string | null;
};

export type TmsPartyRow = {
  id: string;
  kind: "customer" | "driver" | "truck" | "trailer";
  external_id: string;
  name: string;
  unit: string | null;
  vin: string | null;
  customer_id: string | null;
  driver_id: string | null;
  received_at: string;
  seeded: boolean;
};

export type TmsLoadRow = {
  id: string;
  external_id: string;
  load_id: string | null;
  reference: string;
  status_code: string;
  status_label: string;
  customer_external_id: string | null;
  driver_external_id: string | null;
  truck_unit: string | null;
  trailer_unit: string | null;
  vin: string | null;
  stop_count: number;
  leg_count: number;
  picked_up_utc: string | null;
  picked_up_local: string | null;
  picked_up_at: string | null;
  picked_up_day: string | null;
  delivered_utc: string | null;
  delivered_local: string | null;
  delivered_at: string | null;
  delivered_day: string | null;
  last_completed_utc: string | null;
  last_completed_local: string | null;
  last_completed_at: string | null;
  last_completed_day: string | null;
  revenue_total_cents: number | null;
  driver_pay_total_cents: number | null;
  source_updated_at: string;
  finalized_at: string | null;
  received_at: string;
  recheck_after: string | null;
  finalized_seen_at: string | null;
  listed_at: string | null;
  flags: string[];
  seeded: boolean;
};

export type TmsStopRow = {
  id: string;
  tms_load_id: string;
  ordinal: number;
  stop_kind: "pickup" | "delivery";
  name: string;
  city: string;
  state: string;
  appt_from_local: string | null;
  appt_to_local: string | null;
  appt_from_at: string | null;
  appt_to_at: string | null;
  arrived_utc: string | null;
  arrived_local: string | null;
  arrived_at: string | null;
  completed_utc: string | null;
  completed_local: string | null;
  completed_at: string | null;
};

export type TmsStatusEventRow = {
  id: string;
  tms_load_id: string;
  external_event_id: string;
  field: string;
  new_value: string | null;
  previous_value: string | null;
  changed_by: string | null;
  at_utc: string | null;
  at_local: string;
  at: string;
  day: string;
  clock_flag: "clocks_disagree" | null;
  received_at: string;
  seeded: boolean;
};

export type TmsLineItemRow = {
  id: string;
  tms_load_id: string;
  external_id: string;
  item_group: "revenue" | "driver_pay" | "accessorial";
  type_label: string;
  description: string;
  amount_cents: number;
};

export type TmsDocumentRow = {
  id: string;
  tms_load_id: string;
  external_id: string;
  file_name: string;
  type_label: string;
  doc_kind: string;
  shared: boolean;
  uploader_kind: "driver_app" | "office" | "unknown";
  byte_length: number;
  source_updated_at: string;
  review_state: "unreviewed" | "fetched" | "read" | "rejected";
  first_seen_at: string;
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
  // When a load's pay first counts toward an advance: delivered, or picked up (0073).
  advance_unlock_stage: "delivered" | "picked_up";
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

// A pay card (0052) as the tables read it: never its image bytes, which only the one checked
// card's file route reads.
export type PayCardRow = {
  id: string;
  settlement_id: string;
  attempt: number;
  status: "checking" | "checked" | "mismatch" | "unavailable";
  art: string;
  spec: Record<string, unknown>;
  check_read: Record<string, unknown> | null;
  category: string | null;
  mime: string | null;
  byte_length: number | null;
  content_hash: string | null;
  check_call_id: string | null;
  trace_id: string;
  created_by: string;
  checked_at: string | null;
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

// A money code (0048). The seed plans none; the table is seeded so the demo reset empties it with
// the pay items and load charges it names. The code itself is never a column.
export type MoneyCodeRow = {
  id: string;
  driver_id: string;
  load_id: string;
  purpose: "lumper" | "repair" | "other";
  amount_cents: number;
  source_kind: "document" | "voice_note" | "chat" | "form";
  document_id: string | null;
  voice_note_id: string | null;
  receipt_total_cents: number | null;
  proposal_id: string | null;
  money_action_id: string | null;
  membership_id: string;
  status: "issuing" | "issued" | "failed" | "unknown" | "voided";
  provider_ref: string | null;
  code_last4: string | null;
  accessorial_id: string | null;
  charge_item_id: string | null;
  reimbursement_item_id: string | null;
  issued_at: string | null;
  expires_at: string | null;
};

export type AdvanceRow = {
  id: string;
  driver_id: string;
  request_ref: string;
  requested_at: string;
  requested_on: string;
  amount_cents: number;
  fee_cents: number;
  status: "requested" | "approved" | "paid" | "rejected" | "cancelled" | "parked";
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

// The card provider's statement (0046): Test mode, seeded; the simulated provider appends nothing.
export type CardTransactionRow = {
  id: string;
  provider: "fuel_card_sim";
  provider_ref: string;
  kind: "fuel" | "load";
  card_token: string;
  card_last4: string;
  portal_name: string;
  posted_at: string;
  posted_on: string;
  amount_cents: number;
  state: string | null;
  gallons_milli: number | null;
  merchant: string | null;
  source: "seed";
};

// One card check (0046). The seed writes none.
export type CardReconRunRow = {
  id: string;
  membership_id: string;
  status: "running" | "done" | "failed";
  phase: "read" | "explain" | "match" | "done";
  todo: string[];
  lease_token: string | null;
  lease_until: string | null;
  fail_category: string | null;
  window_from: string;
  window_to: string;
  counts: Record<string, unknown>;
  unchecked: unknown[];
  model_cents: number;
  started_at: string;
  finished_at: string | null;
};

// One difference a card check found (0046). The seed writes none.
export type CardReconBreakRow = {
  id: string;
  fingerprint: string;
  category: string;
  severity: "high" | "medium" | "low";
  outside_system: string | null;
  card_transaction_id: string | null;
  money_action_id: string | null;
  fuel_purchase_id: string | null;
  driver_id: string | null;
  our_cents: number | null;
  outside_cents: number | null;
  explanation: string | null;
  explain_category: string | null;
  fix_kind: string;
  proposal_id: string | null;
  status: "open" | "resolved" | "dismissed";
  dismiss_category: string | null;
  first_seen_run_id: string;
  last_seen_run_id: string;
  resolved_at: string | null;
  updated_at: string;
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

export type VendorBillRow = {
  id: string;
  bill_ref: string;
  vendor_name: string;
  category: "fuel_supplier" | "insurance" | "maintenance" | "tolls" | "software" | "lease" | "other";
  amount_cents: number;
  due_on: string;
  urgency: "fixed" | "flexible";
  status: "open" | "deferred" | "paid";
  deferred_to: string | null;
  paid_on: string | null;
  proposal_id: string | null;
};

export type CashSettingsRow = {
  id: string;
  bank_balance_cents: number;
  balance_as_of: string;
  pay_day_dow: number;
  factoring_advance_bps: number;
  factoring_fee_bps: number;
};

// One Cash Friday check as stored: figures, lines and options are the engine's own output (cents,
// dates, ids), explanation the verified paragraph or null with explain_category saying why.
export type CashCheckRow = {
  id: string;
  period_id: string;
  as_of: string;
  pay_day: string;
  figures: Record<string, unknown>;
  lines: unknown[];
  options: unknown[];
  gap_cents: number;
  pay_run_source: "stored" | "preview";
  explanation: string | null;
  explain_call_id: string | null;
  explain_category: string | null;
  created_by: string;
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

// One approved "Factor these invoices" card as submitted to the test-mode partner (0060): the
// engine's totals in cents and the request's rolled-up status. proposal_id is null only for a
// row a test writes by hand.
export type FactoringRequestRow = {
  id: string;
  period_id: string;
  proposal_id: string | null;
  membership_id: string;
  provider: "factoring_sim";
  advance_bps: number;
  fee_bps: number;
  balance_cents: number;
  advance_cents: number;
  fee_cents: number;
  net_cents: number;
  reserve_cents: number;
  status: "submitted" | "funded" | "partly_funded" | "declined" | "unknown" | "failed";
  funded_at: string | null;
};

// One invoice of a factoring request: its own numbers, the ledger try (attempt), the packet
// snapshot and the partner's reference once funded.
export type FactoringRequestInvoiceRow = {
  id: string;
  request_id: string;
  invoice_id: string;
  attempt: number;
  balance_cents: number;
  advance_cents: number;
  fee_cents: number;
  net_cents: number;
  reserve_cents: number;
  money_action_id: string | null;
  provider_ref: string | null;
  status: "submitted" | "funded" | "declined" | "unknown" | "failed";
  packet: Record<string, unknown>;
  settled_at: string | null;
};

// A fuel or tax rate (0053): a lookup's suggestion, or a pin an admin chose. Thousandths of a cent
// per gallon ($3.657 is 365700); null on an unconfirmed suggestion.
export type PinnedRateRow = {
  id: string;
  kind: "diesel_index" | "ifta_rate";
  state: string | null;
  status: "suggested" | "unconfirmed" | "pinned";
  value_mcents: number | null;
  source: "lookup" | "typed";
  source_url: string;
  source_title: string | null;
  quote: string | null;
  as_of: string | null;
  effective_from: string | null;
  lookup_call_id: string | null;
  trace_id: string | null;
  created_by: string;
  pinned_by: string | null;
  pinned_at: string | null;
  retired_at: string | null;
};

// The phone line (0068). The seed plans none; the replace empties them through their drivers.
export type CallRow = {
  id: string;
  driver_id: string;
  trace_id: string;
  created_by: string;
  status: "open" | "ended";
  segments: number;
  hand_offs: number;
  started_at: string;
  last_segment_at: string | null;
  ended_at: string | null;
};

export type CallSegmentRow = {
  id: string;
  call_id: string;
  seq: number;
  status: "received" | "transcribed" | "blocked" | "done" | "empty" | "failed";
  fail_category: string | null;
  attempts: number;
  offset_ms: number;
  duration_ms: number;
  input_id: string | null;
  transcript_call_id: string | null;
  update_call_id: string | null;
  updated_at: string;
};

export type CallTurnRow = {
  id: string;
  segment_id: string;
  turn_key: string;
  upstream_turn_id: string | null;
  start_ms: number;
  end_ms: number;
  text: string;
  update_kind: "advance_request" | "pay_question" | "dispute" | "promise" | "note" | "none" | null;
  english_text: string | null;
  amount_cents: number | null;
  summary: string | null;
  voice_note_id: string | null;
  conversation_id: string | null;
};

export type TenantRows = {
  customers: CustomerRow[];
  drivers: DriverRow[];
  driver_cards: DriverCardRow[];
  driver_identities: DriverIdentityRow[];
  driver_arm_events: DriverArmEventRow[];
  loads: LoadRow[];
  load_events: LoadEventRow[];
  tms_connections: TmsConnectionRow[];
  tms_parties: TmsPartyRow[];
  tms_loads: TmsLoadRow[];
  tms_stops: TmsStopRow[];
  tms_status_events: TmsStatusEventRow[];
  tms_line_items: TmsLineItemRow[];
  tms_documents: TmsDocumentRow[];
  load_state_miles: LoadStateMilesRow[];
  load_accessorials: LoadAccessorialRow[];
  driver_days: DriverDayRow[];
  fuel_purchases: FuelPurchaseRow[];
  card_transactions: CardTransactionRow[];
  pay_configs: PayConfigRow[];
  deduction_schedules: DeductionScheduleRow[];
  settlement_periods: SettlementPeriodRow[];
  settlements: SettlementRow[];
  settlement_lines: SettlementLineRow[];
  pay_cards: PayCardRow[];
  pay_items: PayItemRow[];
  money_codes: MoneyCodeRow[];
  advances: AdvanceRow[];
  invoices: InvoiceRow[];
  customer_payments: CustomerPaymentRow[];
  payment_applications: PaymentApplicationRow[];
  untrusted_inputs: UntrustedInputRow[];
  screenings: ScreeningRow[];
  calls: CallRow[];
  call_segments: CallSegmentRow[];
  call_turns: CallTurnRow[];
  card_recon_runs: CardReconRunRow[];
  card_recon_breaks: CardReconBreakRow[];
  collection_drafts: CollectionDraftRow[];
  briefs: BriefRow[];
  vendor_bills: VendorBillRow[];
  cash_settings: CashSettingsRow[];
  cash_checks: CashCheckRow[];
  factoring_requests: FactoringRequestRow[];
  factoring_request_invoices: FactoringRequestInvoiceRow[];
  carrier_notes: CarrierNoteRow[];
  pinned_rates: PinnedRateRow[];
};

// Compile-time proof that TenantRows has exactly one key per table.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const ROWS_COVER_TABLES: Exact<keyof TenantRows, TenantTable> = true;
