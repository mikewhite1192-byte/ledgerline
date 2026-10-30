import type { Queryable } from "../db";
import { readTable, readTenant, ReadLimitError, type Paging } from "../data/read";
import { isUuid } from "../uuid";
import { loadNumberOf, normCode, type RateConCandidates, type StoredRateCon } from "./check";
import type { RateConReading } from "./schema";

// The records a rate confirmation's reading is checked against, read inside the caller's tenant
// transaction (row-level security scopes every read). Reads only: the agent's get_proposal reaches
// this file to re-run the checks for the auditor. The load number is compared as a whole
// normalized value, never a part of a string. ownLoadId: the load the card would create, so the
// card's own row is never counted as another card for the number, and a load already holding that
// id (the executor's own write, read back) is never counted as another load.

export async function rateConCandidates(
  q: Queryable,
  reading: RateConReading,
  ownLoadId: string,
): Promise<RateConCandidates> {
  const tenant = await readTenant(q);
  if (!tenant || typeof tenant.timezone !== "string" || tenant.timezone === "") {
    throw new Error("no tenant for the transaction");
  }
  const customers = (await readTable(q, "customers")).map((c) => ({ id: c.id, code: c.code, name: c.name }));
  const number = loadNumberOf(reading.loadNumber);
  if (number === null) return { zone: tenant.timezone, customers, loadsWithNumber: 0, cardsWithNumber: 0 };

  const loadsWithNumber = await countLoadsWithNumber(q, number, ownLoadId);
  const cards = await q.query<{ subject_id: string; load_number: string | null }>(
    `SELECT CAST(subject_id AS text) AS subject_id, args ->> 'loadNumber' AS load_number FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = 'load_create'
        AND status IN ('proposed', 'approved', 'executing')`,
  );
  const cardsWithNumber = cards.filter(
    (c) => c.subject_id !== ownLoadId && normCode(c.load_number) === number,
  ).length;
  return { zone: tenant.timezone, customers, loadsWithNumber, cardsWithNumber };
}

// Rows per statement and statements per read for the loads count. A row is an id and a load
// number, so a page of 1,000 stays far under the Data API's 1 MiB response cap; the bound (200,000
// loads) stops a runaway read, and a read stopped there fails closed.
export const LOAD_PAGING: Paging = { pageSize: 1000, maxPages: 200 };

// The tenant's loads, other than ownLoadId, whose load number is this one, read in pages keyed on
// the uuid id (loads.id, so the order is the uuid's and not the text column's). Only the two columns
// compared: normCode (NFKC, every Unicode space, full upper case) has no identical SQL form, so the
// whole-value compare stays here and every load is seen once.
export async function countLoadsWithNumber(
  q: Queryable,
  number: string,
  ownLoadId: string,
  paging: Paging = LOAD_PAGING,
): Promise<number> {
  const { pageSize, maxPages } = paging;
  for (const n of [pageSize, maxPages]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("paging is not a positive count");
  }
  const select = "SELECT CAST(id AS text) AS id, load_number FROM loads WHERE tenant_id = current_tenant_id()";
  type Row = { id: string; load_number: string | null };
  let count = 0;
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const rows: Row[] =
      cursor === null
        ? await q.query<Row>(`${select} ORDER BY loads.id LIMIT ${pageSize}`)
        : await q.query<Row>(`${select} AND id > CAST($1 AS uuid) ORDER BY loads.id LIMIT ${pageSize}`, [cursor]);
    if (rows.length > pageSize) throw new Error("a page is larger than its page size");
    count += rows.filter((l) => l.id !== ownLoadId && normCode(l.load_number) === number).length;
    if (rows.length < pageSize) return count;
    const last: string = rows[rows.length - 1].id;
    if (!isUuid(last)) throw new Error("a page key is not a uuid");
    cursor = last;
  }
  throw new ReadLimitError();
}

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type StoredRow = {
  status: string;
  proposal_id: string | null;
  document_id: string;
  input_id: string | null;
  reading: string | null;
  document_created_at: string;
  body_text: string | null;
  content_hash: string | null;
};

// What the card for this load was made from: its ratecon_reads row, the document's created_at and
// the transcript the row names. Null when no row reserved the id.
export async function readStoredRateCon(q: Queryable, loadId: string): Promise<StoredRateCon | null> {
  const rows = await q.query<StoredRow>(
    `SELECT r.status, CAST(r.proposal_id AS text) AS proposal_id, CAST(r.document_id AS text) AS document_id,
            CAST(r.input_id AS text) AS input_id, CAST(r.reading AS text) AS reading,
            ${utc("d.created_at")} AS document_created_at, u.body_text, u.content_hash
       FROM ratecon_reads r
       JOIN documents d ON d.tenant_id = r.tenant_id AND d.id = r.document_id
       LEFT JOIN untrusted_inputs u ON u.tenant_id = r.tenant_id AND u.id = r.input_id AND u.kind = 'document'
      WHERE r.tenant_id = current_tenant_id() AND r.load_id = CAST($1 AS uuid)`,
    [loadId],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    status: r.status,
    proposalId: r.proposal_id,
    documentId: r.document_id,
    inputId: r.input_id,
    reading: r.reading,
    documentCreatedAt: r.document_created_at,
    transcript:
      r.body_text !== null && r.content_hash !== null ? { body: r.body_text, hash: r.content_hash } : null,
  };
}
