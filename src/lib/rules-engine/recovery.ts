import type { LineDraft } from "./load-pay";
import { assertCents, cents, sub, sum } from "./money";
import {
  ADVANCE_SOURCES,
  ADVANCE_STATUSES,
  assertDate,
  DEFICIT_SOURCES,
  assertId,
  assertOneOf,
  compareText,
  InputError,
  instantMs,
  type AdvanceRecord,
  type Cents,
  type DeficitRecord,
  type PayConfig,
  type Period,
  type SettlementNote,
} from "./types";

// Step 7 of the pay math: take back paid advances, oldest first, within the tenant's cap and
// above the net pay floor, then the driver's named deficits the same way, within what the cap and
// the floor left. What is not taken stays outstanding on the advance or the deficit; that is the
// carry forward, so nothing else needs to remember it.

// Two approved or paid advances of the same amount this close together look like one request
// logged twice.
export const DUPLICATE_WINDOW_MS = 86_400_000;

export function checkAdvance(advance: AdvanceRecord, driverId?: string): AdvanceRecord {
  const id = assertId(advance?.id, "advance id");
  const where = `advance ${id}`;
  if (driverId !== undefined && advance.driverId !== driverId) {
    throw new InputError(`${where} is not this driver's`);
  }
  assertId(advance.driverId, `${where} driverId`);
  assertOneOf(advance.status, ADVANCE_STATUSES, `${where} status`);
  assertOneOf(advance.source, ADVANCE_SOURCES, `${where} source`);
  instantMs(advance.requestedAt, `${where} requestedAt`);
  assertDate(advance.requestedOn, `${where} requestedOn`);
  const owed = sum([
    assertCents(advance.amountCents, `${where} amountCents`),
    assertCents(advance.feeCents, `${where} feeCents`),
  ]);
  const recovered = assertCents(advance.recoveredCents, `${where} recoveredCents`);
  if (recovered > owed) {
    throw new InputError(`${where} recovered more than it lent`);
  }
  const takenBack = assertCents(advance.takenBackCents, `${where} takenBackCents`);
  if (takenBack > owed) {
    throw new InputError(`${where} took back more than it lent`);
  }
  // Together too: what settlements recovered and what a person took back never pass what was lent
  // (the take-back service bounds itself by what was still owed), so neither is counted twice.
  if (sum([recovered, takenBack]) > owed) {
    throw new InputError(`${where} recovered and took back more than it lent`);
  }
  if (advance.loadId !== null) assertId(advance.loadId, `${where} loadId`);
  return advance;
}

// Amount plus fee less what settlements recovered and what a person took back, never below 0,
// for an advance the driver owes on: approved (about to be paid) or paid. Requested, rejected and
// cancelled advances owe nothing.
export function outstandingCents(advance: AdvanceRecord): Cents {
  if (advance.status !== "approved" && advance.status !== "paid") return cents(0);
  const owed = sub(
    sum([advance.amountCents, advance.feeCents]),
    sum([advance.recoveredCents, advance.takenBackCents]),
  );
  return cents(Math.max(0, owed));
}

export function byOldest(a: AdvanceRecord, b: AdvanceRecord): number {
  return (
    instantMs(a.requestedAt, "requestedAt") - instantMs(b.requestedAt, "requestedAt") ||
    compareText(a.requestRef, b.requestRef) ||
    compareText(a.id, b.id)
  );
}

// recovered = min(outstanding, cap, room), spread over paid advances requested on or before the
// period's last day, oldest first, one line per advance touched. A shortfall leaves a note naming
// the limit that applied (the tenant's cap, or the floor) and citing the advances still owing.
export function recoverAdvances(
  config: PayConfig,
  advances: readonly AdvanceRecord[],
  period: Period,
  roomCents: Cents,
): {
  lines: LineDraft[];
  recoveries: { advanceId: string; cents: Cents }[];
  note: SettlementNote | null;
  recoveredCents: Cents;
} {
  const open = advances
    .filter((a) => a.status === "paid" && a.requestedOn <= period.end)
    .filter((a) => outstandingCents(a) > 0)
    .sort(byOldest);
  const owed = sum(open.map(outstandingCents));
  const cap = config.advanceRecoveryCapCents;
  const recovered = cents(Math.min(owed, cap ?? owed, Math.max(0, roomCents)));
  const lines: LineDraft[] = [];
  const recoveries: { advanceId: string; cents: Cents }[] = [];
  const taken = new Map<AdvanceRecord, Cents>();
  let left: number = recovered;
  for (const advance of open) {
    if (left === 0) break;
    const take = cents(Math.min(outstandingCents(advance), left));
    left = sub(left, take);
    lines.push({
      kind: "advance_recovery",
      label: `Advance recovery (${advance.requestedOn})`,
      amountCents: sub(0, take),
      sources: [{ table: "advances", id: advance.id }],
    });
    recoveries.push({ advanceId: advance.id, cents: take });
    taken.set(advance, take);
  }
  const stillOwing = open.filter((a) => sub(outstandingCents(a), taken.get(a) ?? 0) > 0);
  const note: SettlementNote | null =
    recovered < owed
      ? {
          kind: "advance_recovery",
          category: cap !== null && cap <= roomCents && recovered === cap ? "cap" : "floor",
          sources: stillOwing.map((a) => ({ table: "advances" as const, id: a.id })),
          amountCents: sub(owed, recovered),
        }
      : null;
  return { lines, recoveries, note, recoveredCents: recovered };
}

// ---- Deficits (0080) ----

// The longest part of a deficit's note a paystub line repeats.
export const DEFICIT_LABEL_NOTE_CHARS = 40;

export function checkDeficit(deficit: DeficitRecord, driverId?: string): DeficitRecord {
  const id = assertId(deficit?.id, "deficit id");
  const where = `deficit ${id}`;
  if (driverId !== undefined && deficit.driverId !== driverId) {
    throw new InputError(`${where} is not this driver's`);
  }
  assertId(deficit.driverId, `${where} driverId`);
  assertOneOf(deficit.sourceKind, DEFICIT_SOURCES, `${where} sourceKind`);
  instantMs(deficit.createdAt, `${where} createdAt`);
  assertDate(deficit.createdOn, `${where} createdOn`);
  const amount = assertCents(deficit.amountCents, `${where} amountCents`);
  if (amount === 0) throw new InputError(`${where} owes nothing`);
  const recovered = assertCents(deficit.recoveredCents, `${where} recoveredCents`);
  if (recovered > amount) {
    throw new InputError(`${where} recovered more than it owed`);
  }
  if (typeof deficit.note !== "string" || deficit.note.length === 0) {
    throw new InputError(`${where} has no note`);
  }
  return deficit;
}

// What is still owed on a deficit: amount less what settlements recovered.
export function deficitOwedCents(deficit: DeficitRecord): Cents {
  return sub(deficit.amountCents, deficit.recoveredCents);
}

function byOldestDeficit(a: DeficitRecord, b: DeficitRecord): number {
  return instantMs(a.createdAt, "createdAt") - instantMs(b.createdAt, "createdAt") || compareText(a.id, b.id);
}

// recovered = min(owed, cap left, room), spread over deficits still owed that were booked on or
// before the period's last day (the tenant's date), oldest first by when they were booked, then id.
// The cap is one cap on everything recovered from a stub (the tenant's advanceRecoveryCapCents): what
// the advances took this period comes off it first, and room is what the floor left after them.
// One line per deficit touched, citing it; a shortfall leaves a note naming the limit that applied
// (the cap or the floor) and citing the deficits still owing.
export function recoverDeficits(
  config: PayConfig,
  deficits: readonly DeficitRecord[],
  period: Period,
  roomCents: Cents,
  advancesTakenCents: Cents,
): {
  lines: LineDraft[];
  recoveries: { deficitId: string; cents: Cents }[];
  note: SettlementNote | null;
  recoveredCents: Cents;
} {
  const open = deficits
    .filter((d) => d.createdOn <= period.end && deficitOwedCents(d) > 0)
    .sort(byOldestDeficit);
  const owed = sum(open.map(deficitOwedCents));
  const cap = config.advanceRecoveryCapCents;
  const capLeft = cap === null ? null : cents(Math.max(0, sub(cap, advancesTakenCents)));
  const room = cents(Math.max(0, roomCents));
  const recovered = cents(Math.min(owed, capLeft ?? owed, room));
  const lines: LineDraft[] = [];
  const recoveries: { deficitId: string; cents: Cents }[] = [];
  const taken = new Map<DeficitRecord, Cents>();
  let left: number = recovered;
  for (const deficit of open) {
    if (left === 0) break;
    const take = cents(Math.min(deficitOwedCents(deficit), left));
    left = sub(left, take);
    lines.push({
      kind: "deficit_recovery",
      label: `Owed: ${[...deficit.note].slice(0, DEFICIT_LABEL_NOTE_CHARS).join("")}`,
      amountCents: sub(0, take),
      sources: [{ table: "driver_deficits", id: deficit.id }],
    });
    recoveries.push({ deficitId: deficit.id, cents: take });
    taken.set(deficit, take);
  }
  const stillOwing = open.filter((d) => sub(deficitOwedCents(d), taken.get(d) ?? 0) > 0);
  const note: SettlementNote | null =
    recovered < owed
      ? {
          kind: "deficit_recovery",
          category: capLeft !== null && capLeft <= room && recovered === capLeft ? "cap" : "floor",
          sources: stillOwing.map((d) => ({ table: "driver_deficits" as const, id: d.id })),
          amountCents: sub(owed, recovered),
        }
      : null;
  return { lines, recoveries, note, recoveredCents: recovered };
}
