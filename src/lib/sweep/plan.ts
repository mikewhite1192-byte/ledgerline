import { formatCents } from "../format/money";
import type { CheckInput, Finding, ReceivablesInput, SourceRef } from "../rules-engine";
import { isWithin, type Period } from "../time/local-date";

// What the sweep does with each engine finding (design 3.4). Pure: the same finding and rows
// always give the same legs, the same args and the same source order, so the gateway's proposal
// dedupe key never changes between runs. The engine computed every number; a leg only carries it.
//
// A fix leg becomes one propose_pay_correction call; a needs_person leg is a fixed line for a
// person, built here from record fields (codes, numbers, refs), never from model text.

export type PayCorrectionReason =
  | "duplicate_charge"
  | "wrong_driver"
  | "charge_not_owed"
  | "missing_reimbursement";

export type FixLeg = {
  kind: "fix";
  leg: number;
  driverId: string;
  // Signed: positive adds to the driver's pay, negative takes it away.
  expectedCents: number;
  verdict: "owed_to_driver" | "owed_by_driver";
  reasonCategories: [PayCorrectionReason];
  payItemId?: string;
  sourceRefs: SourceRef[];
};

export type PersonLeg = {
  kind: "needs_person";
  leg: number;
  driverId?: string;
  text: string;
  sourceRefs: SourceRef[];
};

export type PlanLeg = FixLeg | PersonLeg;

// A settlement exception the pay run stored (SETTLEMENTS' settlement_approve proposal): only the
// two engine categories the checks do not already cover.
export type SettlementException = {
  category: "load_rate_missing" | "net_below_zero";
  settlementId: string;
  driverId: string;
};

// The sweep item's dedupe key: the check, the category, the record at fault and the leg.
export function findingKey(finding: Pick<Finding, "check" | "category" | "sources">, leg: number): string {
  const at = finding.sources[0];
  if (!at) throw new Error("a finding needs the record at fault");
  return `${finding.check}:${finding.category}:${at.table}:${at.id}:${leg}`;
}

const fix = (
  leg: number,
  driverId: string,
  expectedCents: number,
  reason: PayCorrectionReason,
  sourceRefs: SourceRef[],
  payItemId?: string,
): FixLeg => ({
  kind: "fix",
  leg,
  driverId,
  expectedCents,
  verdict: expectedCents > 0 ? "owed_to_driver" : "owed_by_driver",
  reasonCategories: [reason],
  ...(payItemId ? { payItemId } : {}),
  sourceRefs,
});

const person = (text: string, sourceRefs: SourceRef[], driverId?: string): PersonLeg => ({
  kind: "needs_person",
  leg: 1,
  ...(driverId ? { driverId } : {}),
  text,
  sourceRefs,
});

const refOf = (finding: Finding, table: string): SourceRef | undefined =>
  finding.sources.find((s) => s.table === table);

// A whole positive amount, or null: a fix is never planned on an amount the engine did not give.
function amountOf(finding: Finding): number | null {
  const a = finding.amountCents;
  return typeof a === "number" && Number.isSafeInteger(a) && a > 0 ? a : null;
}

// The legs for one pay finding. The period is the week the corrections land in: a fuel pay item
// is named as the item being corrected only while it is unsettled and inside that week (the
// gateway refuses any other), and is still cited in the sources either way.
export function fixPlanFor(finding: Finding, input: CheckInput, period: Period): PlanLeg[] {
  const drivers = new Map(input.drivers.map((d) => [d.id, d]));
  const codeOf = (id: string | undefined) => (id ? (drivers.get(id)?.code ?? "a driver") : "a driver");
  const amount = amountOf(finding);
  const refs = finding.sources.map((s) => ({ table: s.table, id: s.id }));
  const driverId = finding.driverId && drivers.has(finding.driverId) ? finding.driverId : undefined;

  switch (finding.category) {
    case "newer_is_duplicate":
      if (!driverId || amount === null) break;
      return [fix(1, driverId, amount, "duplicate_charge", refs)];

    case "purchase_on_other_driver":
    case "load_on_other_driver": {
      if (!driverId || amount === null) break;
      const itemRef = refOf(finding, "pay_items");
      const item = itemRef ? input.items.find((i) => i.id === itemRef.id) : undefined;
      const purchaseRef = refOf(finding, "fuel_purchases");
      const purchase = purchaseRef ? input.fuelPurchases.find((p) => p.id === purchaseRef.id) : undefined;
      const loadRef = refOf(finding, "loads");
      const load = loadRef ? input.loads.find((l) => l.id === loadRef.id) : undefined;
      // The driver who bought the fuel or drove the load, read from the finding's own records.
      const other = finding.category === "purchase_on_other_driver" ? purchase?.driverId : load?.driverId;
      const correctable =
        item !== undefined && item.settlementId === null && isWithin(item.itemDate, period);
      const legs: PlanLeg[] = [
        fix(1, driverId, amount, "wrong_driver", refs, correctable ? item.id : undefined),
      ];
      if (other && other !== driverId && drivers.has(other)) {
        legs.push(fix(2, other, -amount, "wrong_driver", refs));
      } else {
        legs.push({
          ...person(`Find who should carry the fuel charge moved off ${codeOf(driverId)}.`, refs),
          leg: 2,
        });
      }
      return legs;
    }

    case "purchase_not_found": {
      const item = input.items.find((i) => i.id === finding.sources[0]?.id);
      const when = item ? ` on ${item.itemDate}` : "";
      return [person(`Fuel charge for ${codeOf(driverId)}${when} has no matching card purchase.`, refs, driverId)];
    }

    case "no_load_that_day":
      if (!driverId || amount === null) break;
      return [fix(1, driverId, amount, "charge_not_owed", refs)];

    case "no_reimbursement": {
      if (amount === null) break;
      if (driverId) return [fix(1, driverId, amount, "missing_reimbursement", refs)];
      const load = input.loads.find((l) => l.id === refOf(finding, "loads")?.id);
      return [person(`Load ${load?.loadNumber ?? "?"} has a driver-paid charge but no driver to reimburse.`, refs)];
    }

    case "rate_missing": {
      const load = input.loads.find((l) => l.id === finding.sources[0]?.id);
      return [person(`Load ${load?.loadNumber ?? "?"} delivered with no rate: enter the rate on the load.`, refs, driverId)];
    }

    case "over_limit":
      if (amount === null) break;
      return [person(`Advances for ${codeOf(driverId)} are ${formatCents(amount)} over the driver's limit.`, refs, driverId)];

    default:
      break;
  }
  // Anything the table does not plan (or a finding missing what its fix needs) goes to a person.
  return [person(`A ${finding.check.replace(/_/g, " ")} problem needs a look.`, refs, driverId)];
}

// The receivables findings: always a person's job here (INVOICES owns the fix).
export function receivablesPlanFor(finding: Finding, input: ReceivablesInput): PlanLeg[] {
  const refs = finding.sources.map((s) => ({ table: s.table, id: s.id }));
  const payment = input.payments.find((p) => p.id === refOf(finding, "customer_payments")?.id);
  const invoices = finding.sources
    .filter((s) => s.table === "invoices")
    .map((s) => input.invoices.find((i) => i.id === s.id)?.invoiceNumber ?? "?");
  const ref = payment?.paymentRef ?? "?";
  if (finding.category === "payment_on_wrong_invoice") {
    return [person(`Payment ${ref} was applied to invoice ${invoices[0] ?? "?"}; it matches invoice ${invoices[1] ?? "?"}.`, refs)];
  }
  return [person(`Payment ${ref} puts more on invoice ${invoices[0] ?? "?"} than the invoice is for.`, refs)];
}

export function settlementPlanFor(e: SettlementException, input: CheckInput): PlanLeg[] {
  const code = input.drivers.find((d) => d.id === e.driverId)?.code ?? "a driver";
  const refs: SourceRef[] = [{ table: "settlements", id: e.settlementId }];
  const text =
    e.category === "load_rate_missing"
      ? `The pay run for ${code} has a delivered load with no rate.`
      : `The pay run for ${code} comes out below zero.`;
  return [person(text, refs, e.driverId)];
}
