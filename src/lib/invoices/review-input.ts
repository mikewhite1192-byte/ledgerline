import type { CustomerRow, InvoiceRow } from "../data/rows";
import {
  cents,
  invoiceAmount,
  POSTING_STATES,
  type Cents,
  type DocumentFact,
  type InvoiceReviewInput,
  type LoadRecord,
  type PostingState,
} from "../rules-engine";

// The review's inputs, put together from rows already read. Pure: the page readers and the seed's
// own check build the same input from the same rows, so a seeded plant and a page read back agree.

// The latest invoice post for one invoice, from the ledger.
export type PostingFact = { state: PostingState; failureCategory: string | null };

export type ReviewFacts = {
  customers: ReadonlyMap<string, Pick<CustomerRow, "id" | "pod_required">>;
  loads: ReadonlyMap<string, LoadRecord>;
  documents: readonly DocumentFact[];
  // Every invoice of each customer, the one under review included (the rules skip it).
  invoicesByCustomer: ReadonlyMap<string, readonly InvoiceRow[]>;
  postings: ReadonlyMap<string, PostingFact>;
};

export function reviewFactsOf(rows: {
  invoices: readonly InvoiceRow[];
  customers: readonly Pick<CustomerRow, "id" | "pod_required">[];
  loads: readonly LoadRecord[];
  documents: readonly DocumentFact[];
  postings: ReadonlyMap<string, PostingFact>;
}): ReviewFacts {
  const byCustomer = new Map<string, InvoiceRow[]>();
  for (const i of rows.invoices) byCustomer.set(i.customer_id, [...(byCustomer.get(i.customer_id) ?? []), i]);
  return {
    customers: new Map(rows.customers.map((c) => [c.id, c])),
    loads: new Map(rows.loads.map((l) => [l.id, l])),
    documents: rows.documents,
    invoicesByCustomer: byCustomer,
    postings: rows.postings,
  };
}

// The latest post per invoice: the highest attempt, as the post button counts them. Rows of any
// other kind are skipped; a state outside the ledger's list is unknown, never guessed.
export function latestPostings(
  actions: readonly { kind: string; subjectId: string; attempt: number; state: string; failureCategory: string | null }[],
): Map<string, PostingFact> {
  const top = new Map<string, { attempt: number; fact: PostingFact }>();
  for (const a of actions) {
    if (a.kind !== "invoice") continue;
    const seen = top.get(a.subjectId);
    if (seen && seen.attempt >= a.attempt) continue;
    const state = (POSTING_STATES as readonly string[]).includes(a.state) ? (a.state as PostingState) : "unknown";
    top.set(a.subjectId, { attempt: a.attempt, fact: { state, failureCategory: a.failureCategory } });
  }
  return new Map([...top].map(([id, v]) => [id, v.fact]));
}

// Stored amounts are whole cents; one that is not is refused by cents(), never rounded.
const num = (v: number | string, what: string): Cents => cents(Number(v), what);
const numOrNull = (v: number | string | null, what: string): Cents | null =>
  v === null ? null : num(v, what);

export function reviewInputOf(inv: InvoiceRow, facts: ReviewFacts): InvoiceReviewInput {
  const customer = facts.customers.get(inv.customer_id);
  // A customer that cannot be read is an error, never "no rule".
  if (!customer) throw new Error(`invoice ${inv.id} has no customer row`);
  const load = inv.load_id === null ? undefined : facts.loads.get(inv.load_id);
  let engineTotalCents: Cents | null = null;
  if (load) {
    const engine = invoiceAmount(load);
    if (engine.ok) engineTotalCents = engine.amountCents;
  }
  return {
    invoice: {
      id: inv.id,
      amountCents: num(inv.amount_cents, `invoice ${inv.id} amount`),
      customerId: inv.customer_id,
      loadId: inv.load_id,
      issuedOn: inv.issued_on,
      status: inv.status,
      reviewedAt: inv.reviewed_at,
      sentOn: inv.sent_on,
      qboId: inv.qbo_id,
      qboAmountCents: numOrNull(inv.qbo_amount_cents, `invoice ${inv.id} posted amount`),
    },
    engineTotalCents,
    engineLinehaulCents: load?.linehaulCents ?? null,
    customer: { podRequired: customer.pod_required },
    documents: inv.load_id === null ? [] : facts.documents.filter((d) => d.loadId === inv.load_id),
    siblings: (facts.invoicesByCustomer.get(inv.customer_id) ?? [])
      .filter((s) => s.id !== inv.id)
      .map((s) => ({
        id: s.id,
        amountCents: num(s.amount_cents, `invoice ${s.id} amount`),
        issuedOn: s.issued_on,
        status: s.status,
      })),
    posting: facts.postings.get(inv.id) ?? null,
  };
}
