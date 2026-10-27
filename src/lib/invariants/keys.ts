import { InvariantReadError, flag, readAll, resultOf, tally, unreadable, whole, type InvariantResult, type ReadQuery } from "./types";
import type { Db } from "../db/types";

// I2: no duplicate idempotency or dedupe keys. Each key's unique index still exists by name, with
// the exact definition the migrations gave it, valid and in use; and, belt and braces, a GROUP BY
// over each key's rows (with the index's own predicate) finds no two rows that share it. Model
// calls have no unique index on the provider's id, so two rows with the same one (a call logged
// twice, a double charge) are counted from the rows alone.

export type GuardedKey = {
  // A short, stable name for the key in the output.
  key: string;
  index: string;
  table: string;
  columns: string[];
  // The index's partial predicate as the GROUP BY must honor it, or null.
  where: string | null;
  definition: string;
};

const def = (index: string, table: string, columns: string, where?: string) =>
  `CREATE UNIQUE INDEX ${index} ON public.${table} USING btree (${columns})${where ? ` WHERE ${where}` : ""}`;

export const GUARDED_KEYS: GuardedKey[] = [
  {
    key: "money_actions_idempotency",
    index: "money_actions_tenant_id_idempotency_key_key",
    table: "money_actions",
    columns: ["tenant_id", "idempotency_key"],
    where: null,
    definition: def("money_actions_tenant_id_idempotency_key_key", "money_actions", "tenant_id, idempotency_key"),
  },
  {
    key: "money_actions_request",
    index: "money_actions_tenant_id_request_id_key",
    table: "money_actions",
    columns: ["tenant_id", "request_id"],
    where: null,
    definition: def("money_actions_tenant_id_request_id_key", "money_actions", "tenant_id, request_id"),
  },
  {
    key: "money_actions_live_subject",
    index: "money_actions_one_live_per_subject",
    table: "money_actions",
    columns: ["tenant_id", "kind", "subject_id"],
    where: "state <> 'failed'",
    definition: def(
      "money_actions_one_live_per_subject",
      "money_actions",
      "tenant_id, kind, subject_id",
      "(state <> 'failed'::text)",
    ),
  },
  {
    key: "proposals_dedupe",
    index: "proposals_tenant_id_dedupe_key_key",
    table: "proposals",
    columns: ["tenant_id", "dedupe_key"],
    where: null,
    definition: def("proposals_tenant_id_dedupe_key_key", "proposals", "tenant_id, dedupe_key"),
  },
  {
    key: "proposals_live_subject",
    index: "proposals_one_live_per_subject",
    table: "proposals",
    columns: ["tenant_id", "kind", "subject_id"],
    where: "status IN ('proposed', 'approved', 'executing')",
    definition: def(
      "proposals_one_live_per_subject",
      "proposals",
      "tenant_id, kind, subject_id",
      "(status = ANY (ARRAY['proposed'::text, 'approved'::text, 'executing'::text]))",
    ),
  },
  {
    key: "advances_request",
    index: "advances_tenant_id_request_ref_key",
    table: "advances",
    columns: ["tenant_id", "request_ref"],
    where: null,
    definition: def("advances_tenant_id_request_ref_key", "advances", "tenant_id, request_ref"),
  },
  {
    key: "advances_proposal",
    index: "advances_proposal_uq",
    table: "advances",
    columns: ["tenant_id", "proposal_id"],
    where: "proposal_id IS NOT NULL",
    definition: def("advances_proposal_uq", "advances", "tenant_id, proposal_id", "(proposal_id IS NOT NULL)"),
  },
  {
    key: "load_accessorials_proposal",
    index: "load_accessorials_one_per_proposal",
    table: "load_accessorials",
    columns: ["tenant_id", "proposal_id"],
    where: "proposal_id IS NOT NULL",
    definition: def(
      "load_accessorials_one_per_proposal",
      "load_accessorials",
      "tenant_id, proposal_id",
      "(proposal_id IS NOT NULL)",
    ),
  },
  {
    key: "invoices_load",
    index: "invoices_tenant_id_load_id_key",
    table: "invoices",
    columns: ["tenant_id", "load_id"],
    // A unique index lets any number of NULLs through; opening balances carry no load.
    where: "load_id IS NOT NULL",
    definition: def("invoices_tenant_id_load_id_key", "invoices", "tenant_id, load_id"),
  },
  {
    key: "customer_payments_ref",
    index: "customer_payments_tenant_id_payment_ref_key",
    table: "customer_payments",
    columns: ["tenant_id", "payment_ref"],
    where: null,
    definition: def("customer_payments_tenant_id_payment_ref_key", "customer_payments", "tenant_id, payment_ref"),
  },
];

export const INDEXES_SQL = `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
       i.indisunique AS is_unique, i.indisvalid AS is_valid, i.indisready AS is_ready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'`;

function duplicatesOf(k: GuardedKey): string {
  const cols = k.columns.join(", ");
  return `(SELECT count(*) FROM (SELECT 1 FROM ${k.table}${k.where ? ` WHERE ${k.where}` : ""}
      GROUP BY ${cols} HAVING count(*) > 1) AS d) AS ${k.key}`;
}

// One statement, one snapshot: every key's count of duplicated values.
export const DUPLICATES_SQL = `SELECT ${GUARDED_KEYS.map(duplicatesOf).join(",\n       ")},
       (SELECT count(*) FROM (SELECT 1 FROM model_calls WHERE upstream_id IS NOT NULL
          GROUP BY provider, upstream_id HAVING count(*) > 1) AS d) AS model_calls_upstream`;

export type IndexRow = {
  name: unknown;
  definition: unknown;
  is_unique: unknown;
  is_valid: unknown;
  is_ready: unknown;
};

export type KeyRows = { indexes: IndexRow[]; duplicates: Record<string, unknown>[] };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function judgeKeys(rows: KeyRows): InvariantResult {
  const v: Record<string, number> = {};
  const byName = new Map<string, IndexRow>();
  for (const r of rows.indexes) if (typeof r.name === "string") byName.set(r.name, r);

  for (const k of GUARDED_KEYS) {
    const found = byName.get(k.index);
    if (!found) {
      tally(v, `index_missing:${k.index}`);
      continue;
    }
    const same = typeof found.definition === "string" && squash(found.definition) === squash(k.definition);
    if (!same || !flag(found.is_unique) || !flag(found.is_valid) || !flag(found.is_ready)) {
      tally(v, `index_changed:${k.index}`);
    }
  }

  if (rows.duplicates.length !== 1) throw new InvariantReadError("duplicates_unread");
  const [counts] = rows.duplicates;
  for (const k of GUARDED_KEYS) tally(v, `duplicate:${k.key}`, whole(counts[k.key]));
  tally(v, "duplicate:model_calls_upstream", whole(counts.model_calls_upstream));

  return resultOf("I2", { keys: GUARDED_KEYS.length + 1, indexes: GUARDED_KEYS.length }, v);
}

export async function readKeys(q: ReadQuery): Promise<KeyRows> {
  return {
    indexes: await q.query<IndexRow>(INDEXES_SQL),
    duplicates: await q.query<Record<string, unknown>>(DUPLICATES_SQL),
  };
}

export async function checkKeys(admin: Db): Promise<InvariantResult> {
  try {
    return judgeKeys(await readAll(admin, readKeys));
  } catch (err) {
    return unreadable("I2", err);
  }
}
