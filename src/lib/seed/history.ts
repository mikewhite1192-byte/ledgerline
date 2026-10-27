import { configFor } from "../data/config-version";
import {
  advanceOf,
  dayOf,
  driverOf,
  loadsOf,
  payConfigOf,
  payItemOf,
  scheduleOf,
} from "../data/records";
import type { PayItemRow, SettlementLineRow, SettlementRow, TenantRows } from "../data/rows";
import { settleDriver, sum } from "../rules-engine";
import { paidWritesOf } from "../settlements/paid";
import { addDays, type LocalDate } from "../time/local-date";
import { instantAt } from "./calendar";

// The settled weeks. For each paid period, oldest first, every driver is settled by the engine
// (settleDriver, the same call the pay run makes), and the result is written back the way the
// pay run will write it: a paid settlement with its lines, the escrow delta on the driver, each
// recovery on its advance, every pay item the lines cite stamped with the settlement, and a
// shortfall carried into the next week as a carried_shortfall item. Those writes come from
// paidWritesOf, the same function the live booking (bookPaidSettlement) uses, and are checked
// against the engine's own escrow delta and recoveries. So the open week starts from
// balances the engine itself produced (design D5). Each period runs under the pay rules version
// in force at its start (rows.pay_configs), and its settlements name that version.

export type HistoryArgs = {
  slug: string;
  zone: string;
  rows: TenantRows;
  newId: () => string;
};

export function applyHistory({ slug, zone, rows, newId }: HistoryArgs): void {
  const paid = rows.settlement_periods.filter((p) => p.status === "paid");
  const open = rows.settlement_periods.filter((p) => p.status === "open");
  if (open.length !== 1) throw new Error("history needs exactly one open period");
  const byDriver = <T extends { driver_id: string | null }>(list: readonly T[]) => {
    const out = new Map<string, T[]>();
    for (const x of list) {
      if (x.driver_id === null) continue;
      out.set(x.driver_id, [...(out.get(x.driver_id) ?? []), x]);
    }
    return out;
  };
  const loads = byDriver(rows.loads);
  const days = byDriver(rows.driver_days);
  const schedules = byDriver(rows.deduction_schedules);
  const advances = byDriver(rows.advances);
  const drivers = [...rows.drivers].sort((a, b) => (a.code < b.code ? -1 : 1));
  const itemsById = new Map(rows.pay_items.map((i) => [i.id, i]));
  const carried: PayItemRow[] = [];
  let carryN = 0;

  paid.forEach((p, index) => {
    const nextStart: LocalDate =
      index + 1 < paid.length ? paid[index + 1].period_start : open[0].period_start;
    const period = { start: p.period_start, end: p.period_end };
    const version = configFor(rows.pay_configs, p.period_start);
    const config = payConfigOf(version);
    for (const d of drivers) {
      const driverLoads = loads.get(d.id) ?? [];
      const loadIds = new Set(driverLoads.map((l) => l.id));
      const result = settleDriver({
        config,
        driver: driverOf(d),
        period,
        loads: loadsOf(
          driverLoads,
          rows.load_state_miles.filter((m) => loadIds.has(m.load_id)),
          rows.load_accessorials.filter((a) => loadIds.has(a.load_id)),
        ),
        days: (days.get(d.id) ?? []).map(dayOf),
        items: [...rows.pay_items, ...carried].filter((i) => i.driver_id === d.id).map(payItemOf),
        schedules: (schedules.get(d.id) ?? []).map(scheduleOf),
        advances: (advances.get(d.id) ?? []).map(advanceOf),
        escrowBalanceCents: driverOf(d).escrowBalanceCents,
      });
      const settlementId = newId();
      const writes = paidWritesOf({
        settlementId,
        lines: result.lines,
        carryForwardCents: result.carryForwardCents,
        openingCents: d.escrow_balance_cents,
        periodEnd: p.period_end,
      });
      if (writes.escrowDeltaCents !== result.escrowDeltaCents) {
        throw new Error("the escrow line and the engine's escrow delta disagree");
      }
      if (
        writes.recoveries.length !== result.recoveries.length ||
        writes.recoveries.some(
          (r, i) =>
            r.advanceId !== result.recoveries[i].advanceId || r.cents !== result.recoveries[i].cents,
        )
      ) {
        throw new Error("the recovery lines and the engine's recoveries disagree");
      }
      if (writes.carried && writes.carried.itemDate !== nextStart) {
        throw new Error("pay periods are not back to back");
      }
      const settlement: SettlementRow = {
        id: settlementId,
        period_id: p.id,
        driver_id: d.id,
        pay_config_id: version.id,
        status: "paid",
        gross_cents: result.grossCents,
        deductions_cents: result.deductionsCents,
        net_cents: result.netCents,
        carry_forward_cents: result.carryForwardCents,
        exception_count: result.exceptions.length,
        paid_at: instantAt(addDays(p.period_end, 2), 10, 0, zone),
        escrow_opening_cents: writes.escrow.openingCents,
        escrow_charges_cents: writes.escrow.chargesCents,
        escrow_withheld_cents: writes.escrow.withheldCents,
        escrow_closing_cents: writes.escrow.closingCents,
        parked_reason: null,
        parked_at: null,
      };
      rows.settlements.push(settlement);
      for (const line of result.lines) {
        const row: SettlementLineRow = {
          id: newId(),
          settlement_id: settlement.id,
          seq: line.seq,
          kind: line.kind,
          label: line.label,
          amount_cents: line.amountCents,
          sources: line.sources.map((s) => ({ table: s.table, id: s.id })),
          meta: line.meta ? { ...line.meta } : null,
        };
        rows.settlement_lines.push(row);
      }
      for (const id of writes.stampItemIds) {
        const item = itemsById.get(id) ?? carried.find((x) => x.id === id);
        if (!item) throw new Error("a settlement line cites an unknown pay item");
        item.settlement_id = settlement.id;
      }
      d.escrow_balance_cents = writes.escrow.closingCents;
      for (const r of writes.recoveries) {
        const advance = rows.advances.find((a) => a.id === r.advanceId);
        if (!advance) throw new Error("a recovery names an unknown advance");
        advance.recovered_cents = sum([advance.recovered_cents, r.cents]);
      }
      if (writes.carried) {
        carried.push({
          id: newId(),
          driver_id: d.id,
          kind: writes.carried.kind,
          subkind: writes.carried.subkind,
          amount_cents: writes.carried.amountCents,
          item_date: writes.carried.itemDate,
          ref_table: writes.carried.refTable,
          ref_id: writes.carried.refId,
          item_ref: `${slug}-carry-${++carryN}`,
          description: writes.carried.description,
          settlement_id: null,
        });
      }
    }
  });
  rows.pay_items.push(...carried);
}
