import { loadsOf } from "../data/records";
import type {
  CustomerRow,
  DriverRow,
  InvoiceRow,
  LoadAccessorialRow,
  LoadRow,
  LoadStateMilesRow,
  PaymentApplicationRow,
} from "../data/rows";
import { compareText, DUPLICATE_WINDOW_DAYS, invoiceAmount } from "../rules-engine";
import { addDays, daysBetween, type LocalDate, type Period } from "../time/local-date";
import { Rng } from "./prng";

// The invoice review plants. Seeded history is reviewed and sent by construction (ar-plan sets
// both on every invoice); this picks the few recent invoices that are not, so each review status
// the seed can show is shown once per carrier:
//   missing documents: a recent invoice of a customer that requires a signed delivery document;
//   duplicate warning: two recent invoices of one customer at the same amount, a few days apart;
//   rate mismatch:     a recent invoice 150.00 under the engine's total for its load;
//   ready to send:     a recent invoice reviewed, not posted, not sent;
//   needs review:      the rest of the recent batch, unreviewed and unsent.
// An accounting sync error is never seeded: the seed writes no ledger rows. The picks come from
// their own stream, so no other row of the plan changes but the ones named here.

export const RATE_MISMATCH_SHORT_CENTS = 15_000;
// How many recent invoices stay unsent for the review queue, the plants included.
export const REVIEW_BATCH = 8;
// The recent window the plants are drawn from, in days before the anchor.
const RECENT_DAYS = 21;
// The gap the duplicate pair aims for, in days.
const DUPLICATE_GAP_DAYS = 3;

export type ReviewPlant = {
  podCustomerIds: [string, string];
  missingDocumentsInvoiceId: string;
  duplicateInvoiceIds: [string, string];
  rateMismatchInvoiceId: string;
  readyInvoiceId: string;
  needsReviewInvoiceIds: string[];
};

export type ReviewPlanArgs = {
  seed: string;
  anchor: LocalDate;
  openWeek: Period;
  customers: CustomerRow[];
  invoices: InvoiceRow[];
  loads: LoadRow[];
  stateMiles: readonly LoadStateMilesRow[];
  accessorials: readonly LoadAccessorialRow[];
  drivers: readonly DriverRow[];
  heroId: string | null;
  // Loads and invoices other plants already use; none of them is picked here.
  takenLoadIds: ReadonlySet<string>;
  takenInvoiceIds: ReadonlySet<string>;
  applications: readonly PaymentApplicationRow[];
};

const unsent = (inv: InvoiceRow, reviewed: boolean) => {
  inv.reviewed_at = reviewed ? `${inv.issued_on}T12:00:00.000Z` : null;
  inv.sent_on = null;
};

export function planInvoiceReview(args: ReviewPlanArgs): ReviewPlant {
  const rng = new Rng(`${args.seed}:review`);
  const loadById = new Map(args.loads.map((l) => [l.id, l]));
  const driverById = new Map(args.drivers.map((d) => [d.id, d]));
  const engineTotal = (loadId: string): number => {
    const row = loadById.get(loadId);
    if (!row) throw new Error("an invoice names a load the plan does not have");
    const [load] = loadsOf(
      [row],
      args.stateMiles.filter((m) => m.load_id === loadId),
      args.accessorials.filter((a) => a.load_id === loadId),
    );
    const out = invoiceAmount(load);
    if (!out.ok) throw new Error("a recent invoice's load has no engine total");
    return out.amountCents;
  };

  // Candidates: recent, open, untouched by payments, from loads no other plant uses, never the
  // hero's (the hero's own story stays about pay).
  // Another live invoice of the same customer at this amount near this date: the engine would warn.
  const sameAmountNear = (i: InvoiceRow, amountCents: number, except: ReadonlySet<string>) =>
    args.invoices.some(
      (s) =>
        !except.has(s.id) &&
        s.id !== i.id &&
        s.customer_id === i.customer_id &&
        s.status !== "void" &&
        s.amount_cents === amountCents &&
        Math.abs(daysBetween(s.issued_on, i.issued_on)) <= DUPLICATE_WINDOW_DAYS,
    );
  const applied = new Set(args.applications.map((a) => a.invoice_id));
  const from = addDays(args.anchor, -RECENT_DAYS);
  const candidates = args.invoices
    .filter(
      (i) =>
        i.source === "load" &&
        i.load_id !== null &&
        i.status === "open" &&
        i.issued_on >= from &&
        !applied.has(i.id) &&
        !args.takenInvoiceIds.has(i.id) &&
        !args.takenLoadIds.has(i.load_id) &&
        loadById.get(i.load_id)?.driver_id !== args.heroId,
    )
    .sort((a, b) => compareText(b.issued_on, a.issued_on) || compareText(a.id, b.id));

  // The hero's main customer never gets the document rule or a plant.
  const heroCount = new Map<string, number>();
  for (const l of args.loads) {
    if (args.heroId !== null && l.driver_id === args.heroId) {
      heroCount.set(l.customer_id, (heroCount.get(l.customer_id) ?? 0) + 1);
    }
  }
  const heroMain = [...heroCount].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]?.[0] ?? null;
  const usable = candidates.filter((i) => i.customer_id !== heroMain);

  // Duplicate warning: the pair of one customer closest to three days apart. The later one's load
  // gets a linehaul that makes its engine total equal the earlier one's amount, so the pair shows
  // a duplicate and nothing else. Its driver is never paid a percentage, so no pay moves with it.
  type Pair = { a: InvoiceRow; b: InvoiceRow; gap: number };
  const pairs: Pair[] = [];
  for (const a of usable) {
    for (const b of usable) {
      if (a.customer_id !== b.customer_id || a.id === b.id) continue;
      const gap = daysBetween(a.issued_on, b.issued_on);
      if (gap < 1 || gap > DUPLICATE_WINDOW_DAYS) continue;
      const driver = driverById.get(loadById.get(b.load_id!)?.driver_id ?? "");
      if (!driver || driver.pay_basis === "percent") continue;
      // No third invoice may match the pair's amount, so each warns of the other only.
      const pairIds = new Set([a.id, b.id]);
      if (sameAmountNear(a, a.amount_cents, pairIds) || sameAmountNear(b, a.amount_cents, pairIds)) continue;
      pairs.push({ a, b, gap });
    }
  }
  pairs.sort(
    (x, y) =>
      Math.abs(x.gap - DUPLICATE_GAP_DAYS) - Math.abs(y.gap - DUPLICATE_GAP_DAYS) ||
      compareText(y.b.issued_on, x.b.issued_on) ||
      compareText(x.a.id, y.a.id) ||
      compareText(x.b.id, y.b.id),
  );
  const pair = pairs[0];
  if (!pair) throw new Error("no two recent invoices of one customer for the duplicate plant");
  const loadB = loadById.get(pair.b.load_id!)!;
  if (loadB.linehaul_cents === null) throw new Error("the duplicate plant's load has no rate");
  const extrasB = engineTotal(loadB.id) - loadB.linehaul_cents;
  const linehaulB = pair.a.amount_cents - extrasB;
  if (!Number.isSafeInteger(linehaulB) || linehaulB <= 0) throw new Error("the duplicate plant cannot match");
  loadB.linehaul_cents = linehaulB;
  pair.b.amount_cents = pair.a.amount_cents;
  unsent(pair.a, false);
  unsent(pair.b, false);

  // The customers that require a signed delivery document: two with the most open-week loads,
  // never the hero's main customer or the duplicate pair's, the first one with a recent invoice
  // for the missing documents plant.
  const openCount = new Map<string, number>();
  for (const l of args.loads) {
    if (l.pickup_on < args.openWeek.start || l.pickup_on > args.openWeek.end) continue;
    openCount.set(l.customer_id, (openCount.get(l.customer_id) ?? 0) + 1);
  }
  const ranked = args.customers
    .filter((c) => c.id !== heroMain && c.id !== pair.a.customer_id)
    .sort((a, b) => (openCount.get(b.id) ?? 0) - (openCount.get(a.id) ?? 0) || compareText(a.code, b.code));
  const first = ranked.find((c) => usable.some((i) => i.customer_id === c.id));
  const second = ranked.find((c) => c !== first);
  if (!first || !second) throw new Error("the review plan needs two customers for the document rule");
  const pod = [first, second];
  for (const c of pod) c.pod_required = true;
  const podIds = new Set(pod.map((c) => c.id));

  // Missing documents: one recent invoice of the first document customer, picked from the stream.
  const missing = rng.pick(usable.filter((i) => i.customer_id === first.id));
  unsent(missing, false);

  const rest = usable.filter((i) => !podIds.has(i.customer_id) && i !== pair.a && i !== pair.b);
  // Rate mismatch and ready to send: the newest two others.
  const [rate, ready, ...others] = rest;
  if (!rate || !ready) throw new Error("not enough recent invoices for the review plants");
  rate.amount_cents = engineTotal(rate.load_id!) - RATE_MISMATCH_SHORT_CENTS;
  if (rate.amount_cents <= 0) throw new Error("the rate plant's load is too small");
  unsent(rate, false);
  unsent(ready, true);

  // Needs review: the newest others that no other invoice matches, so each shows needs review and
  // nothing else, and the batch of unsent invoices is REVIEW_BATCH long.
  const none = new Set<string>();
  const needs = others.filter((i) => !sameAmountNear(i, i.amount_cents, none)).slice(0, REVIEW_BATCH - 5);
  if (needs.length !== REVIEW_BATCH - 5) throw new Error("not enough recent invoices for the needs review plants");
  for (const i of needs) unsent(i, false);

  return {
    podCustomerIds: [pod[0].id, pod[1].id],
    missingDocumentsInvoiceId: missing.id,
    duplicateInvoiceIds: [pair.a.id, pair.b.id],
    rateMismatchInvoiceId: rate.id,
    readyInvoiceId: ready.id,
    needsReviewInvoiceIds: needs.map((i) => i.id),
  };
}
