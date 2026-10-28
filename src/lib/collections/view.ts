import { flags } from "../../config/flags";
import { readReceivablesInput, readTable, readTenant } from "../data/read";
import type { Queryable } from "../db";
import { planCollections, type ChaseCandidate, type CollectionStage, type CollectionTone } from "../rules-engine/collections";
import { sum } from "../rules-engine/money";
import { carrierToday } from "../tenant/shell";
import { parseFigures } from "./pack";

// What the collections page shows, read inside the caller's tenant transaction (RLS holds it to
// one carrier). The late invoices come from the rules engine on today's carrier date, the same
// planner drafting uses, so the page and a run always agree on what needs a reminder.

// A reminder left drafting longer than this was cut off mid-call (the route runs at most 30 s): the
// next run puts it back to waiting and drafts it again, so the page already lists it as waiting.
export const DRAFTING_LEASE_MS = 60_000;

export type ReminderCard = {
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  invoiceNumber: string;
  stage: CollectionStage;
  tone: CollectionTone;
  status: "drafting" | "drafted" | "refused" | "over_cap" | "approved" | "rejected";
  daysLate: number;
  balanceCents: number;
  dueOn: string;
  subject: string | null;
  body: string | null;
  refusalCategory: string | null;
  channel: string | null;
  sentAt: string | null;
};

export type LateInvoice = {
  invoiceId: string;
  customerId: string;
  customerName: string;
  invoiceNumber: string;
  daysLate: number;
  balanceCents: number;
  dueOn: string;
  stage: CollectionStage;
  tone: CollectionTone;
};

export type CollectionsView = {
  asOf: string;
  timezone: string;
  pastDueCount: number;
  pastDueCents: number;
  waiting: number;
  approvedLastWeek: number;
  // Late invoices with no reminder at their stage yet, or one waiting from an earlier run.
  toDraft: LateInvoice[];
  cards: ReminderCard[];
};

type DraftRow = {
  id: string;
  invoice_id: string;
  customer_id: string;
  stage: string;
  tone: string;
  status: string;
  figures: string;
  subject: string | null;
  body: string | null;
  refusal_category: string | null;
  channel: string | null;
  decided_at: string | null;
  sent_at: string | null;
  updated_at: string;
};

const STATUSES = new Set(["drafting", "drafted", "refused", "over_cap", "approved", "rejected"]);
const STAGES = new Set(["30", "60", "90"]);
const TONES = new Set(["friendly", "direct", "firm"]);
// Waiting for a person first: that is the page's next step.
const ORDER: Record<string, number> = { drafted: 0, drafting: 1, over_cap: 2, refused: 3, approved: 4, rejected: 5 };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function readCollectionsView(q: Queryable, now: Date): Promise<CollectionsView> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant row");
  const asOf = carrierToday(tenant.timezone, now);
  const input = await readReceivablesInput(q, asOf);
  const names = new Map((await readTable(q, "customers")).map((c) => [c.id, c.name]));
  const candidates = planCollections(input, null, flags.collectionsLimits.minDaysLate);
  const rows = await q.query<DraftRow>(
    `SELECT CAST(id AS text) AS id, CAST(invoice_id AS text) AS invoice_id, CAST(customer_id AS text) AS customer_id,
            stage, tone, status, CAST(figures AS text) AS figures, subject, body, refusal_category, channel,
            ${ISO("decided_at")} AS decided_at, ${ISO("sent_at")} AS sent_at, ${ISO("updated_at")} AS updated_at
       FROM collection_drafts WHERE tenant_id = current_tenant_id()`,
  );
  // Waiting for a run: not drafted yet, or cut off mid-draft past its lease (an unreadable time
  // counts as cut off, so the reminder is never stuck showing "Drafting").
  const leaseEnd = now.getTime() - DRAFTING_LEASE_MS;
  const waits = (r: DraftRow) =>
    r.status === "over_cap" || (r.status === "drafting" && !(Date.parse(r.updated_at) >= leaseEnd));

  const nameOf = (id: string) => names.get(id) ?? "Customer";
  const byKey = new Map(rows.map((r) => [`${r.invoice_id}:${r.stage}`, r]));
  const late = (c: ChaseCandidate): LateInvoice => ({
    invoiceId: c.invoiceId,
    customerId: c.customerId,
    customerName: nameOf(c.customerId),
    invoiceNumber: c.invoiceNumber,
    daysLate: c.daysLate,
    balanceCents: c.balanceCents,
    dueOn: c.dueOn,
    stage: c.stage,
    tone: c.tone,
  });
  const toDraft = candidates
    .filter((c) => {
      const row = byKey.get(`${c.invoiceId}:${c.stage}`);
      return !row || waits(row);
    })
    .map(late);

  const cards: ReminderCard[] = [];
  for (const r of rows) {
    // A row the page cannot read is left off rather than shown with guessed figures.
    const figures = parseFigures(r.figures);
    if (!figures || !STATUSES.has(r.status) || !STAGES.has(r.stage) || !TONES.has(r.tone)) continue;
    // A reminder still waiting from an earlier run shows in the "not drafted yet" list instead.
    if (waits(r)) continue;
    cards.push({
      id: r.id,
      invoiceId: r.invoice_id,
      customerId: r.customer_id,
      customerName: nameOf(r.customer_id),
      invoiceNumber: figures.invoiceNumber,
      stage: r.stage as CollectionStage,
      tone: r.tone as CollectionTone,
      status: r.status as ReminderCard["status"],
      daysLate: figures.daysLate,
      balanceCents: figures.balanceCents,
      dueOn: figures.dueOn,
      subject: r.subject,
      body: r.body,
      refusalCategory: r.refusal_category,
      channel: r.channel,
      sentAt: r.sent_at,
    });
  }
  cards.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      Number(b.stage) - Number(a.stage) ||
      b.daysLate - a.daysLate ||
      (a.invoiceNumber < b.invoiceNumber ? -1 : a.invoiceNumber > b.invoiceNumber ? 1 : 0),
  );

  const weekAgo = now.getTime() - WEEK_MS;
  return {
    asOf,
    timezone: tenant.timezone,
    pastDueCount: candidates.length,
    pastDueCents: sum(candidates.map((c) => c.balanceCents)),
    waiting: rows.filter((r) => r.status === "drafted").length,
    approvedLastWeek: rows.filter(
      (r) => r.status === "approved" && r.decided_at !== null && Date.parse(r.decided_at) >= weekAgo,
    ).length,
    toDraft,
    cards,
  };
}
