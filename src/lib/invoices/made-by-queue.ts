import type { Queryable } from "../db";

// Which invoices LedgerLine posts to accounting: only one the invoice queue made, as only a
// payment recorded on the form posts. That is a load invoice that an approved invoice_post card
// wrote (the card moves to executing in the transaction that writes the invoice, then to done or
// failed). The card is the evidence, so the rule has no date: moving the invoices start date
// never turns a queue-made invoice into history. The queue offers only delivered loads with no
// invoice, so no card ever names a load whose invoice came from anywhere else. A seeded or
// imported invoice, or an opening balance carried in from before the app, is history: it never
// goes out from here, and a person records its send by hand. The post button, the review and the
// recorded send all ask this one rule.

export type QueueMadeFacts = { source: string; load_id: string | null };

// Everything but the card: a load invoice.
function couldBeQueueMade<T extends QueueMadeFacts>(row: T): row is T & { load_id: string } {
  return row.source === "load" && row.load_id !== null;
}

// The loads an approved engine invoice_post card wrote an invoice for: every one in the tenant
// when $1 is null, else only that load's. One statement, so the readers and the post agree.
export const QUEUE_CARD_LOADS_SQL = `SELECT DISTINCT CAST(subject_id AS text) AS load_id FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = 'invoice_post' AND origin = 'engine'
        AND subject_table = 'loads' AND status IN ('executing', 'done', 'failed')
        AND (CAST($1 AS uuid) IS NULL OR subject_id = CAST($1 AS uuid))`;

export async function readQueueCardLoads(q: Queryable, loadId: string | null): Promise<Set<string>> {
  const rows = await q.query<{ load_id: string }>(QUEUE_CARD_LOADS_SQL, [loadId]);
  return new Set(rows.map((r) => r.load_id));
}

// The card loads one invoice's answer needs: none, with no read, when it cannot be queue-made.
export async function readQueueCardLoadsFor(q: Queryable, row: QueueMadeFacts): Promise<Set<string>> {
  return couldBeQueueMade(row) ? readQueueCardLoads(q, row.load_id) : new Set();
}

// The rule, on card loads already read (one invoice's, or the whole tenant's).
export function madeByQueueOf(row: QueueMadeFacts, cardLoads: ReadonlySet<string>): boolean {
  return couldBeQueueMade(row) && cardLoads.has(row.load_id);
}

export async function madeByQueue(q: Queryable, row: QueueMadeFacts): Promise<boolean> {
  return madeByQueueOf(row, await readQueueCardLoadsFor(q, row));
}
