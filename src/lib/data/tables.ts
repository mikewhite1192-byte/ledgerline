// The tenant tables the seed writes and its replace mode clears: the seventeen of migrations 0004
// and 0005, then the outside text and its screenings from 0008, in an order where every table
// comes after the tables it references (insert in this order, delete in reverse). Each column says how
// it travels: the Data API sends strings as text, so uuid, date, timestamptz and jsonb columns
// need a CAST on the way in, and reads turn timestamptz into one ISO form and jsonb into text so
// both drivers return the same values. tenant_id and created_at are never listed: tenant_id is
// always current_tenant_id() and created_at is the database's own.

export type ColumnKind = "uuid" | "text" | "int" | "bool" | "date" | "timestamptz" | "jsonb";

export type TableSpec = {
  table: TenantTable;
  columns: readonly (readonly [string, ColumnKind])[];
};

export const TENANT_TABLES = [
  "customers",
  "drivers",
  "loads",
  "load_state_miles",
  "load_accessorials",
  "driver_days",
  "fuel_purchases",
  "pay_configs",
  "deduction_schedules",
  "settlement_periods",
  "settlements",
  "settlement_lines",
  "pay_items",
  "advances",
  "invoices",
  "customer_payments",
  "payment_applications",
  "untrusted_inputs",
  "screenings",
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

export const TABLE_SPECS: Record<TenantTable, TableSpec> = {
  customers: {
    table: "customers",
    columns: [
      ["id", "uuid"],
      ["code", "text"],
      ["name", "text"],
      ["terms_days", "int"],
      ["city", "text"],
      ["state", "text"],
      ["detention_free_minutes", "int"],
      ["detention_hourly_cents", "int"],
    ],
  },
  drivers: {
    table: "drivers",
    columns: [
      ["id", "uuid"],
      ["code", "text"],
      ["first_name", "text"],
      ["last_name", "text"],
      ["email", "text"],
      ["worker_type", "text"],
      ["pay_basis", "text"],
      ["per_mile_cents", "int"],
      ["percent_bps", "int"],
      ["flat_per_load_cents", "int"],
      ["advance_limit_cents", "int"],
      ["escrow_balance_cents", "int"],
      ["truck_unit", "text"],
      ["tank_gallons", "int"],
      ["active_from", "date"],
      ["active_to", "date"],
    ],
  },
  loads: {
    table: "loads",
    columns: [
      ["id", "uuid"],
      ["load_number", "text"],
      ["customer_id", "uuid"],
      ["driver_id", "uuid"],
      ["status", "text"],
      ["origin_city", "text"],
      ["origin_state", "text"],
      ["dest_city", "text"],
      ["dest_state", "text"],
      ["pickup_on", "date"],
      ["delivered_on", "date"],
      ["delivered_at", "timestamptz"],
      ["loaded_miles", "int"],
      ["empty_miles", "int"],
      ["linehaul_cents", "int"],
      ["fuel_surcharge_cents", "int"],
      ["pickup_arrived_at", "timestamptz"],
      ["pickup_departed_at", "timestamptz"],
      ["delivery_arrived_at", "timestamptz"],
      ["delivery_departed_at", "timestamptz"],
    ],
  },
  load_state_miles: {
    table: "load_state_miles",
    columns: [
      ["id", "uuid"],
      ["load_id", "uuid"],
      ["state", "text"],
      ["miles", "int"],
    ],
  },
  load_accessorials: {
    table: "load_accessorials",
    columns: [
      ["id", "uuid"],
      ["load_id", "uuid"],
      ["kind", "text"],
      ["seq", "int"],
      ["amount_cents", "int"],
      ["paid_by_driver", "bool"],
      ["description", "text"],
    ],
  },
  driver_days: {
    table: "driver_days",
    columns: [
      ["id", "uuid"],
      ["driver_id", "uuid"],
      ["day", "date"],
      ["source", "text"],
      ["load_id", "uuid"],
    ],
  },
  fuel_purchases: {
    table: "fuel_purchases",
    columns: [
      ["id", "uuid"],
      ["driver_id", "uuid"],
      ["load_id", "uuid"],
      ["purchased_at", "timestamptz"],
      ["purchased_on", "date"],
      ["state", "text"],
      ["gallons_milli", "int"],
      ["amount_cents", "int"],
      ["paid_with", "text"],
      ["purchase_ref", "text"],
    ],
  },
  pay_configs: {
    table: "pay_configs",
    columns: [
      ["id", "uuid"],
      ["effective_from", "date"],
      ["note", "text"],
      ["source", "text"],
      ["week_start_dow", "int"],
      ["percent_base", "text"],
      ["empty_miles_paid_bps", "int"],
      ["accessorial_driver_share_bps", "int"],
      ["insurance_applies_to", "text"],
      ["insurance_per_day_cents", "int"],
      ["escrow_target_cents", "int"],
      ["escrow_per_settlement_cents", "int"],
      ["net_pay_floor_cents", "int"],
      ["advance_recovery_cap_cents", "int"],
      ["advance_fee_cents", "int"],
      ["advance_limit_default_cents", "int"],
      ["advance_max_bps_of_earned", "int"],
      ["advance_min_cents", "int"],
    ],
  },
  deduction_schedules: {
    table: "deduction_schedules",
    columns: [
      ["id", "uuid"],
      ["driver_id", "uuid"],
      ["kind", "text"],
      ["amount_cents", "int"],
      ["target_cents", "int"],
      ["description", "text"],
      ["active_from", "date"],
      ["active_to", "date"],
    ],
  },
  settlement_periods: {
    table: "settlement_periods",
    columns: [
      ["id", "uuid"],
      ["period_start", "date"],
      ["period_end", "date"],
      ["status", "text"],
    ],
  },
  settlements: {
    table: "settlements",
    columns: [
      ["id", "uuid"],
      ["period_id", "uuid"],
      ["driver_id", "uuid"],
      ["pay_config_id", "uuid"],
      ["status", "text"],
      ["gross_cents", "int"],
      ["deductions_cents", "int"],
      ["net_cents", "int"],
      ["carry_forward_cents", "int"],
      ["exception_count", "int"],
      ["paid_at", "timestamptz"],
    ],
  },
  settlement_lines: {
    table: "settlement_lines",
    columns: [
      ["id", "uuid"],
      ["settlement_id", "uuid"],
      ["seq", "int"],
      ["kind", "text"],
      ["label", "text"],
      ["amount_cents", "int"],
      ["sources", "jsonb"],
      ["meta", "jsonb"],
    ],
  },
  pay_items: {
    table: "pay_items",
    columns: [
      ["id", "uuid"],
      ["driver_id", "uuid"],
      ["kind", "text"],
      ["subkind", "text"],
      ["amount_cents", "int"],
      ["item_date", "date"],
      ["ref_table", "text"],
      ["ref_id", "uuid"],
      ["item_ref", "text"],
      ["description", "text"],
      ["settlement_id", "uuid"],
    ],
  },
  advances: {
    table: "advances",
    columns: [
      ["id", "uuid"],
      ["driver_id", "uuid"],
      ["request_ref", "text"],
      ["requested_at", "timestamptz"],
      ["requested_on", "date"],
      ["amount_cents", "int"],
      ["fee_cents", "int"],
      ["status", "text"],
      ["recovered_cents", "int"],
      ["source", "text"],
      ["reason_category", "text"],
      ["paid_at", "timestamptz"],
    ],
  },
  invoices: {
    table: "invoices",
    columns: [
      ["id", "uuid"],
      ["source", "text"],
      ["load_id", "uuid"],
      ["customer_id", "uuid"],
      ["invoice_number", "text"],
      ["amount_cents", "int"],
      ["issued_on", "date"],
      ["due_on", "date"],
      ["status", "text"],
      ["paid_on", "date"],
      ["qbo_id", "text"],
    ],
  },
  customer_payments: {
    table: "customer_payments",
    columns: [
      ["id", "uuid"],
      ["customer_id", "uuid"],
      ["received_on", "date"],
      ["amount_cents", "int"],
      ["method", "text"],
      ["payment_ref", "text"],
      ["source", "text"],
      ["memo", "text"],
      ["qbo_id", "text"],
    ],
  },
  payment_applications: {
    table: "payment_applications",
    columns: [
      ["id", "uuid"],
      ["payment_id", "uuid"],
      ["invoice_id", "uuid"],
      ["amount_cents", "int"],
    ],
  },
  untrusted_inputs: {
    table: "untrusted_inputs",
    columns: [
      ["id", "uuid"],
      ["kind", "text"],
      ["source", "text"],
      ["driver_id", "uuid"],
      ["from_address", "text"],
      ["subject", "text"],
      ["body_text", "text"],
      ["content_hash", "text"],
      ["received_at", "timestamptz"],
      ["seed_key", "text"],
    ],
  },
  screenings: {
    table: "screenings",
    columns: [
      ["id", "uuid"],
      ["input_id", "uuid"],
      ["content_hash", "text"],
      ["screener_version", "int"],
      ["verdict", "text"],
      ["categories", "jsonb"],
      ["confidence_milli", "int"],
      ["via", "text"],
      ["model_call_id", "uuid"],
      ["latency_ms", "int"],
      ["expires_at", "timestamptz"],
    ],
  },
};

// Table and column names are spliced into SQL text, so each is checked against this whole
// pattern before use; values always travel as parameters.
const IDENTIFIER = /^[a-z][a-z_]*$/;

export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error("not a plain identifier");
  return name;
}
