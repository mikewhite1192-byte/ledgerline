import {
  settleDriver,
  sub,
  sum,
  type Cents,
  type PayConfig,
  type SettlementInput,
  type WorkerType,
} from "../rules-engine";
import type { LocalDate } from "../time/local-date";
import type { RuleSpec } from "./rules";

// What a pay rule change would have meant on the newest settled week: every driver's settlement
// for that week computed twice by the engine, under the version in force and under the candidate,
// over the same loads, days, items and schedules, and the difference in net pay summed. Both nets
// come from settleDriver, so a driver at the net pay floor shows the floor's effect, never a hand
// subtraction. Integer cents. Pure: the caller reads the rows.

export type ImpactDriver = {
  driverId: string;
  code: string;
  workerType: WorkerType;
  // The settlement the driver was paid that week (the paystub a figure links to).
  settlementId: string;
  input: SettlementInput;
};

export type ComparedPeriod = { id: string; start: LocalDate; end: LocalDate };

export type ImpactTop = { driverId: string; code: string; deltaCents: Cents; settlementId: string };

export type RuleImpact = {
  basis: "settled_week" | "no_settled_week" | "advances_only";
  periodId: string | null;
  periodStart: LocalDate | null;
  periodEnd: LocalDate | null;
  driversCompared: number;
  driversChanged: number;
  // Sum over drivers of (candidate net - base net); positive means drivers are paid more.
  netDeltaCents: Cents;
  // Every driver whose pay changed is an owner-operator (the card says "owner-operators").
  ownerOperatorsOnly: boolean;
  // Up to 5, largest |delta| first, then by driver code.
  top: ImpactTop[];
};

export const TOP_DRIVERS = 5;

function none(basis: "no_settled_week" | "advances_only"): RuleImpact {
  return {
    basis,
    periodId: null,
    periodStart: null,
    periodEnd: null,
    driversCompared: 0,
    driversChanged: 0,
    netDeltaCents: 0 as Cents,
    ownerOperatorsOnly: false,
    top: [],
  };
}

export function ruleImpact(
  spec: RuleSpec,
  period: ComparedPeriod | null,
  drivers: readonly ImpactDriver[],
  candidate: PayConfig,
  base: PayConfig,
): RuleImpact {
  if (spec.affects === "advances") return none("advances_only");
  if (!period) return none("no_settled_week");
  const deltas = drivers.map((d) => {
    const before = settleDriver({ ...d.input, config: base });
    const after = settleDriver({ ...d.input, config: candidate });
    return { d, delta: sub(after.netCents, before.netCents) };
  });
  const changed = deltas.filter((x) => x.delta !== 0);
  const top = [...changed]
    .sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) ||
        (a.d.code < b.d.code ? -1 : a.d.code > b.d.code ? 1 : 0),
    )
    .slice(0, TOP_DRIVERS)
    .map((x) => ({
      driverId: x.d.driverId,
      code: x.d.code,
      deltaCents: x.delta,
      settlementId: x.d.settlementId,
    }));
  return {
    basis: "settled_week",
    periodId: period.id,
    periodStart: period.start,
    periodEnd: period.end,
    driversCompared: drivers.length,
    driversChanged: changed.length,
    netDeltaCents: sum(deltas.map((x) => x.delta)),
    ownerOperatorsOnly:
      changed.length > 0 && changed.every((x) => x.d.workerType === "owner_operator"),
    top,
  };
}
