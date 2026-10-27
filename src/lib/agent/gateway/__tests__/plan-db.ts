import type { Param } from "../../../db";
import type { TenantRows } from "../../../data/rows";
import { buildCarrierPlan, type CarrierPlan } from "../../../seed/plan";
import { DEMO_CARRIERS } from "../../../seed/carriers";
import { FakeDb, TENANT, type Handler, type Row } from "./fake-db";

// A FakeDb that serves one synthetic carrier's seed plan through the record readers' own SQL, so
// the limits and tools run against the real readers and the real rules engine with no database.
// Each statement shape the readers send is matched whole; anything else goes to the extra
// handler or fails the test.

const FROM =
  /^SELECT .+? FROM (\w+) WHERE tenant_id = current_tenant_id\(\)(?: AND (.+))? ORDER BY \w+$/s;
const BY_COLUMN = /^(\w+) = CAST\(\$1 AS uuid\)$/;
const BY_DRIVER_LOADS =
  "load_id IN (SELECT id FROM loads WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid))";

export const PLAN_ANCHOR = "2026-11-02";

let cached: CarrierPlan | null = null;
export function blueRidgePlan(): CarrierPlan {
  cached ??= buildCarrierPlan(DEMO_CARRIERS[0], PLAN_ANCHOR);
  return cached;
}

export function planDb(plan: CarrierPlan, extra?: Handler): FakeDb {
  const rows = plan.rows as unknown as Record<string, Row[]>;
  const tables: Record<string, Row[]> = { ...rows };
  const handler: Handler = (sql, params) => {
    const custom = extra?.(sql, params);
    if (custom !== undefined) return custom;
    if (sql === "SELECT id, slug, name, timezone FROM tenants WHERE id = current_tenant_id()") {
      const c = plan.carrier;
      return [{ id: TENANT, slug: c.slug, name: c.name, timezone: c.timezone }];
    }
    const m = FROM.exec(sql);
    if (!m) return undefined;
    const all = tables[m[1]] ?? [];
    return filterRows(plan.rows, all, m[2], params).map((r) => ({ ...r }));
  };
  return new FakeDb(tables, handler);
}

function filterRows(rows: TenantRows, all: Row[], where: string | undefined, params: Param[]): Row[] {
  if (where === undefined) return all;
  const col = BY_COLUMN.exec(where);
  if (col) return all.filter((r) => r[col[1]] === params[0]);
  if (where === BY_DRIVER_LOADS) {
    const loadIds = new Set(rows.loads.filter((l) => l.driver_id === params[0]).map((l) => l.id));
    return all.filter((r) => loadIds.has(r.load_id as string));
  }
  if (where === "status = $1") return all.filter((r) => r.status === params[0]);
  throw new Error(`unexpected where clause: ${where.slice(0, 60)}`);
}
