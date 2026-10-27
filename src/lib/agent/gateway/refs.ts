import type { Queryable } from "../../db";
import { assertIdentifier } from "../../data/tables";
import { isUuid } from "../../uuid";
import { REF_TABLES, type GatewayRef } from "./types";

// Every id a tool's args name must be a row of the caller's own tenant. Table names come from the
// allowlist, never from the args; the id travels as a parameter. Row-level security already hides
// other tenants' rows, and each statement names the tenant as well, so a login that bypasses
// row-level security still sees one tenant only.

const ALLOWED = new Set<string>(REF_TABLES);

export const MAX_REFS = 16;

// Each distinct ref once, in first-seen order.
export function distinctRefs(refs: readonly GatewayRef[]): GatewayRef[] {
  const seen = new Set<string>();
  const out: GatewayRef[] = [];
  for (const r of refs) {
    const key = `${r.table}:${r.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// True when every ref names an allowed table and an existing row in the current tenant.
export async function assertRefsExist(q: Queryable, refs: readonly GatewayRef[]): Promise<boolean> {
  const list = distinctRefs(refs);
  if (list.length > MAX_REFS) return false;
  for (const ref of list) {
    if (!ALLOWED.has(ref.table) || !isUuid(ref.id)) return false;
    const table = assertIdentifier(ref.table);
    const rows = await q.query<{ ok: number }>(
      `SELECT 1 AS ok FROM ${table} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [ref.id],
    );
    if (rows.length !== 1) return false;
  }
  return true;
}
