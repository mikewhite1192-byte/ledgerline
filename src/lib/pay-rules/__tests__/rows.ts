import type { PayConfigRow } from "../../data/rows";
import { carrierBySlug } from "../../seed/carriers";
import { buildCarrierPlan } from "../../seed/plan";
import type { RuleChangeRows } from "../change";

// Test-only: the rows a change is sized from, built by the seed's own plan for one demo carrier
// at the golden anchor (Blue Ridge's paid weeks Oct 5 to 25 with versions from Oct 5 and Oct 19,
// open week Oct 26; Prairie Wind's weeks start on Sundays, in Chicago). No database, no clock.

export const ANCHOR = "2026-11-02";
export const TENANT_ID = "99999999-9999-4999-8999-999999999999";

const cache = new Map<string, RuleChangeRows>();

export function rowsFor(slug: "blue-ridge" | "prairie-wind"): RuleChangeRows {
  let rows = cache.get(slug);
  if (!rows) {
    const carrier = carrierBySlug(slug);
    if (!carrier) throw new Error("no such demo carrier");
    const r = buildCarrierPlan(carrier, ANCHOR).rows;
    rows = {
      tenant: { id: TENANT_ID, slug, name: carrier.name, timezone: carrier.timezone },
      pay_configs: r.pay_configs,
      settlement_periods: r.settlement_periods,
      settlements: r.settlements,
      settlement_lines: r.settlement_lines,
      drivers: r.drivers,
      loads: r.loads,
      load_state_miles: r.load_state_miles,
      load_accessorials: r.load_accessorials,
      driver_days: r.driver_days,
      pay_items: r.pay_items,
      deduction_schedules: r.deduction_schedules,
      advances: r.advances,
    };
    cache.set(slug, rows);
  }
  // A fresh copy of the arrays a test may change; the rows inside are never mutated.
  return {
    ...rows,
    pay_configs: [...rows.pay_configs],
    settlement_periods: [...rows.settlement_periods],
    settlements: [...rows.settlements],
    settlement_lines: [...rows.settlement_lines],
  };
}

// A version that starts on `from`, copied from the newest one with some knobs replaced.
export function versionFrom(rows: RuleChangeRows, id: string, from: string, over: Partial<PayConfigRow> = {}): PayConfigRow {
  const newest = [...rows.pay_configs].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  return { ...newest, id, effective_from: from, note: null, source: "proposal", ...over };
}
