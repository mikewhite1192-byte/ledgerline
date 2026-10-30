import type { Queryable } from "../db";
import { applicationOf, cashSettingsOf, factoredInvoiceIds, invoiceOf } from "../data/records";
import { readTable } from "../data/read";
import { isCanonicalUuid } from "../money/keys";
import type { FactoringInput } from "../rules-engine/factoring";
import { packetFromJson, type FactoringPacket } from "./packet";

// Reads for factoring (design 4.4): the rules engine's input for one request, and the request list
// and detail the Factoring pages and the agent's read tools show. SELECT only, row security on.

// The engine's input: every invoice of this carrier (an invoice on a live factoring line marked
// factored), its payment applications, the factoring rates from the cash settings, and the week
// the card is for. More than one cash settings row is not a state the engine guesses at.
export async function readFactoringInput(q: Queryable, periodId: string): Promise<FactoringInput> {
  const settings = await readTable(q, "cash_settings");
  if (settings.length > 1) throw new Error("more than one cash settings row");
  const factored = factoredInvoiceIds(await readTable(q, "factoring_request_invoices"));
  const rates = settings.length === 1 ? cashSettingsOf(settings[0]) : null;
  return {
    invoices: (await readTable(q, "invoices")).map((r) =>
      factored.has(r.id) ? { ...invoiceOf(r), factored: true } : invoiceOf(r),
    ),
    applications: (await readTable(q, "payment_applications")).map(applicationOf),
    rates: rates ? { factoringAdvanceBps: rates.factoringAdvanceBps, factoringFeeBps: rates.factoringFeeBps } : null,
    period: { id: periodId },
  };
}

export type RequestSummary = {
  id: string;
  createdAt: string;
  invoiceCount: number;
  balanceCents: number;
  advanceCents: number;
  feeCents: number;
  netCents: number;
  reserveCents: number;
  // The sum of the funded invoices' own net: what came in. netCents, feeCents and reserveCents are
  // what was planned (they still count a declined or unconfirmed invoice).
  cameInCents: number;
  status: string;
  fundedAt: string | null;
  proposalId: string | null;
  advanceBps: number;
  feeBps: number;
};

type SummaryRow = {
  id: string;
  created_at: string;
  invoice_count: number | string;
  balance_cents: number | string;
  advance_cents: number | string;
  fee_cents: number | string;
  net_cents: number | string;
  reserve_cents: number | string;
  came_in_cents: number | string;
  status: string;
  funded_at: string | null;
  proposal_id: string | null;
  advance_bps: number | string;
  fee_bps: number | string;
};

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function whole(v: number | string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("a factoring amount is not whole cents");
  return n;
}

function summaryOf(r: SummaryRow): RequestSummary {
  return {
    id: r.id,
    createdAt: r.created_at,
    invoiceCount: whole(r.invoice_count),
    balanceCents: whole(r.balance_cents),
    advanceCents: whole(r.advance_cents),
    feeCents: whole(r.fee_cents),
    netCents: whole(r.net_cents),
    reserveCents: whole(r.reserve_cents),
    cameInCents: whole(r.came_in_cents),
    status: r.status,
    fundedAt: r.funded_at,
    proposalId: r.proposal_id,
    advanceBps: whole(r.advance_bps),
    feeBps: whole(r.fee_bps),
  };
}

// Exported so a test's fake database can answer the list by name. The request's own amounts are
// the planned totals (the roll-up changes its status, never its totals); came_in_cents adds up only
// the funded invoices' stored net, so a declined, failed or unconfirmed invoice is never in it.
export const SUMMARY_SQL = `
  SELECT CAST(r.id AS text) AS id, ${ISO("r.created_at")} AS created_at,
         (SELECT count(*) FROM factoring_request_invoices l
           WHERE l.tenant_id = r.tenant_id AND l.request_id = r.id) AS invoice_count,
         r.balance_cents, r.advance_cents, r.fee_cents, r.net_cents, r.reserve_cents,
         (SELECT COALESCE(sum(l.net_cents), 0) FROM factoring_request_invoices l
           WHERE l.tenant_id = r.tenant_id AND l.request_id = r.id AND l.status = 'funded') AS came_in_cents,
         r.status,
         ${ISO("r.funded_at")} AS funded_at, CAST(r.proposal_id AS text) AS proposal_id,
         r.advance_bps, r.fee_bps
    FROM factoring_requests r
   WHERE r.tenant_id = current_tenant_id()`;

// The newest requests first.
export async function listRequests(q: Queryable, limit: number): Promise<RequestSummary[]> {
  const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const rows = await q.query<SummaryRow>(`${SUMMARY_SQL} ORDER BY r.created_at DESC, r.id DESC LIMIT ${n}`);
  return rows.map(summaryOf);
}

export type RequestLine = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  attempt: number;
  balanceCents: number;
  advanceCents: number;
  feeCents: number;
  netCents: number;
  reserveCents: number;
  status: string;
  providerRef: string | null;
  moneyActionId: string | null;
  settledAt: string | null;
  // The papers as they were when the request was made.
  packet: FactoringPacket;
};

export type RequestDetail = RequestSummary & { lines: RequestLine[] };

type LineRow = {
  id: string;
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  customer_name: string;
  attempt: number | string;
  balance_cents: number | string;
  advance_cents: number | string;
  fee_cents: number | string;
  net_cents: number | string;
  reserve_cents: number | string;
  status: string;
  provider_ref: string | null;
  money_action_id: string | null;
  settled_at: string | null;
  packet: unknown;
};

function lineOf(r: LineRow): RequestLine {
  let packet: unknown = r.packet;
  if (typeof packet === "string") {
    try {
      packet = JSON.parse(packet);
    } catch {
      packet = null;
    }
  }
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    customerId: r.customer_id,
    customerName: r.customer_name,
    attempt: whole(r.attempt),
    balanceCents: whole(r.balance_cents),
    advanceCents: whole(r.advance_cents),
    feeCents: whole(r.fee_cents),
    netCents: whole(r.net_cents),
    reserveCents: whole(r.reserve_cents),
    status: r.status,
    providerRef: r.provider_ref,
    moneyActionId: r.money_action_id,
    settledAt: r.settled_at,
    packet: packetFromJson(packet),
  };
}

// One request with its invoices in invoice-number order, or null when it is not here.
export async function readRequest(q: Queryable, id: string): Promise<RequestDetail | null> {
  if (!isCanonicalUuid(id)) return null;
  const rows = await q.query<SummaryRow>(`${SUMMARY_SQL} AND r.id = CAST($1 AS uuid)`, [id]);
  if (rows.length !== 1) return null;
  const lines = await q.query<LineRow>(
    `SELECT CAST(l.id AS text) AS id, CAST(l.invoice_id AS text) AS invoice_id, i.invoice_number,
            CAST(i.customer_id AS text) AS customer_id, c.name AS customer_name, l.attempt,
            l.balance_cents, l.advance_cents, l.fee_cents, l.net_cents, l.reserve_cents, l.status,
            l.provider_ref, CAST(l.money_action_id AS text) AS money_action_id,
            ${ISO("l.settled_at")} AS settled_at, CAST(l.packet AS text) AS packet
       FROM factoring_request_invoices l
       JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
       JOIN customers c ON c.tenant_id = i.tenant_id AND c.id = i.customer_id
      WHERE l.tenant_id = current_tenant_id() AND l.request_id = CAST($1 AS uuid)
      ORDER BY i.invoice_number, l.attempt, l.id`,
    [id],
  );
  return { ...summaryOf(rows[0]), lines: lines.map(lineOf) };
}

// The live factoring line an invoice is on (any status but declined or failed), for the invoice's
// own page: "Factored (Test mode) on <date>, request <ref>". Null when it is not factored.
export async function readFactoredLine(
  q: Queryable,
  invoiceId: string,
): Promise<{ requestId: string; status: string; at: string } | null> {
  if (!isCanonicalUuid(invoiceId)) return null;
  const rows = await q.query<{ request_id: string; status: string; at: string }>(
    `SELECT CAST(request_id AS text) AS request_id, status, ${ISO("COALESCE(settled_at, created_at)")} AS at
       FROM factoring_request_invoices
      WHERE tenant_id = current_tenant_id() AND invoice_id = CAST($1 AS uuid)
        AND status NOT IN ('declined', 'failed')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [invoiceId],
  );
  return rows[0] ? { requestId: rows[0].request_id, status: rows[0].status, at: rows[0].at } : null;
}
