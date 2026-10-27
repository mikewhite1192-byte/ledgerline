import type { Queryable } from "../../../db";
import { parseRead } from "../../../documents/schema";
import type { DocumentKind, DocumentRead, ReadStatus } from "../../../documents/types";

// The document behind an outside input, for the gateway's document tool and the rate fill limit.
// Inside the gateway's tenant transaction; the statement also names the tenant. Never the bytes.

export type StoredDocument = {
  id: string;
  readStatus: ReadStatus;
  kind: DocumentKind | null;
  // The stored reading, back through the strict schema; null unless read and well formed.
  read: DocumentRead | null;
};

export async function readDocumentForInput(q: Queryable, inputId: string): Promise<StoredDocument | null> {
  const rows = await q.query<{
    id: string;
    read_status: ReadStatus;
    document_kind: DocumentKind | null;
    reading: string | null;
  }>(
    "SELECT id, read_status, document_kind, CAST(reading AS text) AS reading FROM documents WHERE tenant_id = current_tenant_id() AND untrusted_input_id = CAST($1 AS uuid)",
    [inputId],
  );
  if (rows.length > 1) throw new Error("two documents share one input");
  const row = rows[0];
  if (!row) return null;
  const read = row.read_status === "read" && typeof row.reading === "string" ? parseRead(row.reading) : null;
  return { id: row.id, readStatus: row.read_status, kind: row.document_kind, read };
}
