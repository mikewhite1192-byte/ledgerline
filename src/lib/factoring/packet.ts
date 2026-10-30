import type { Queryable } from "../db";
import { isCanonicalUuid } from "../money/keys";

// The papers a factoring partner asks for with each invoice (design 3.2): the invoice itself
// (always on file: it is the record being sold), the rate confirmation and the bill of lading the
// carrier uploaded for the invoice's load (documents read as that kind and matched to that load),
// and a proof of delivery the broker portal run found for the load (portal_evidence with a POD
// whose screen came back clean). Reads only. Ids only, never a file's contents or a name, so the
// packet can sit in a card, a tool answer and the request line's snapshot as it is.

export type FactoringPacket = {
  invoice: true;
  rateConfirmation: { onFile: boolean; documentId: string | null };
  billOfLading: { onFile: boolean; documentId: string | null };
  pod: { onFile: boolean; portalRunId: string | null };
};

export const EMPTY_PACKET: FactoringPacket = {
  invoice: true,
  rateConfirmation: { onFile: false, documentId: null },
  billOfLading: { onFile: false, documentId: null },
  pod: { onFile: false, portalRunId: null },
};

// Whether every paper is on file; requirePacket refuses a request that has a gap.
export function packetComplete(p: FactoringPacket): boolean {
  return p.rateConfirmation.onFile && p.billOfLading.onFile && p.pod.onFile;
}

// The names of the papers that are missing, in the page's order.
export function packetGaps(p: FactoringPacket): ("rate_confirmation" | "bill_of_lading" | "pod")[] {
  const out: ("rate_confirmation" | "bill_of_lading" | "pod")[] = [];
  if (!p.rateConfirmation.onFile) out.push("rate_confirmation");
  if (!p.billOfLading.onFile) out.push("bill_of_lading");
  if (!p.pod.onFile) out.push("pod");
  return out;
}

const idOrNull = (v: unknown): string | null => (isCanonicalUuid(v) ? v : null);

// A stored snapshot read back whole: anything that is not exactly the packet's shape reads as the
// empty packet (every paper missing), never as on file.
export function packetFromJson(v: unknown): FactoringPacket {
  if (typeof v !== "object" || v === null) return EMPTY_PACKET;
  const o = v as Record<string, unknown>;
  const part = (x: unknown, key: "documentId" | "portalRunId") => {
    if (typeof x !== "object" || x === null) return { onFile: false, id: null };
    const r = x as Record<string, unknown>;
    const id = idOrNull(r[key]);
    return { onFile: r.onFile === true && id !== null, id };
  };
  const rc = part(o.rateConfirmation, "documentId");
  const bol = part(o.billOfLading, "documentId");
  const pod = part(o.pod, "portalRunId");
  return {
    invoice: true,
    rateConfirmation: { onFile: rc.onFile, documentId: rc.onFile ? rc.id : null },
    billOfLading: { onFile: bol.onFile, documentId: bol.onFile ? bol.id : null },
    pod: { onFile: pod.onFile, portalRunId: pod.onFile ? pod.id : null },
  };
}

type DocRow = { load_id: string; document_kind: string; id: string };
type PodRow = { load_id: string; run_id: string };

// The packet's three reads, exported so a test's fake database can answer them by name.
export const PACKET_INVOICES_SQL = `SELECT CAST(id AS text) AS id, CAST(load_id AS text) AS load_id
       FROM invoices
      WHERE tenant_id = current_tenant_id()
        AND id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)`;

export const PACKET_DOCUMENTS_SQL = `SELECT match->>'loadId' AS load_id, document_kind, CAST(id AS text) AS id
         FROM documents
        WHERE tenant_id = current_tenant_id()
          AND document_kind IN ('rate_confirmation', 'bill_of_lading')
          AND match->>'loadId' IN (SELECT jsonb_array_elements_text(CAST($1 AS jsonb)))
        ORDER BY created_at DESC, id DESC`;

export const PACKET_PODS_SQL = `SELECT CAST(load_id AS text) AS load_id, CAST(run_id AS text) AS run_id
         FROM portal_evidence
        WHERE tenant_id = current_tenant_id()
          AND pod_content_hash IS NOT NULL
          AND screen_verdict = 'clean'
          AND load_id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)
        ORDER BY created_at DESC, id DESC`;

// The packet of each named invoice that exists here, keyed by invoice id. An invoice with no load
// (an opening balance) has only itself on file. The newest paper of each kind wins.
export async function packetsOf(q: Queryable, invoiceIds: readonly string[]): Promise<Map<string, FactoringPacket>> {
  const ids = invoiceIds.filter((id) => isCanonicalUuid(id));
  const out = new Map<string, FactoringPacket>();
  if (ids.length === 0) return out;
  const list = JSON.stringify(ids);
  const invoices = await q.query<{ id: string; load_id: string | null }>(PACKET_INVOICES_SQL, [list]);
  const loads = [...new Set(invoices.map((i) => i.load_id).filter((l): l is string => l !== null))];
  const docs = new Map<string, Map<string, string>>();
  const pods = new Map<string, string>();
  if (loads.length > 0) {
    const loadList = JSON.stringify(loads);
    const docRows = await q.query<DocRow>(PACKET_DOCUMENTS_SQL, [loadList]);
    for (const d of docRows) {
      const byKind = docs.get(d.load_id) ?? new Map<string, string>();
      if (!byKind.has(d.document_kind)) byKind.set(d.document_kind, d.id);
      docs.set(d.load_id, byKind);
    }
    const podRows = await q.query<PodRow>(PACKET_PODS_SQL, [loadList]);
    for (const p of podRows) if (!pods.has(p.load_id)) pods.set(p.load_id, p.run_id);
  }
  for (const inv of invoices) {
    const byKind = inv.load_id ? docs.get(inv.load_id) : undefined;
    const rc = idOrNull(byKind?.get("rate_confirmation"));
    const bol = idOrNull(byKind?.get("bill_of_lading"));
    const pod = idOrNull(inv.load_id ? pods.get(inv.load_id) : undefined);
    out.set(inv.id, {
      invoice: true,
      rateConfirmation: { onFile: rc !== null, documentId: rc },
      billOfLading: { onFile: bol !== null, documentId: bol },
      pod: { onFile: pod !== null, portalRunId: pod },
    });
  }
  return out;
}

export async function packetOf(q: Queryable, invoiceId: string): Promise<FactoringPacket | null> {
  return (await packetsOf(q, [invoiceId])).get(invoiceId) ?? null;
}
