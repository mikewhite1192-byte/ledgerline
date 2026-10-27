import { countTenantRows, readTenant } from "../data/read";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import { deleteTenantRows, insertTenantRows } from "../data/writer";
import type { Db, Queryable, TenantDb } from "../db/types";
import { isUuid } from "../uuid";
import type { DemoCarrier } from "./carriers";
import type { CarrierPlan } from "./plan";
import { countRows } from "./summary";

// Writing a plan (design 4.6). Replace is the only mode: in one tenant transaction, delete every
// row of the seeded tables (TENANT_TABLES) for that tenant, insert the plan, read the counts back,
// and roll back on any difference. The seed never creates tenants or memberships.
//
// Two logins. The admin looks the tenant up by slug (one SELECT on tenants) and clears its money
// ledger rows, which the app role cannot delete. Every data write runs as the app role inside
// withTenant, so row-level security bounds it too, and every statement still names its tenant,
// so the writes stay on one tenant even under a login that bypasses row-level security.

export type SeedReport = {
  deleted: Record<TenantTable, number>;
  inserted: Record<TenantTable, number>;
};

// The demo tenant's id. Its name and time zone must equal the constants, or this is the wrong
// database and nothing is written.
export async function findDemoTenant(admin: Db, carrier: DemoCarrier): Promise<string> {
  const rows = await admin.withoutTenant((q) =>
    q.query<{ id: string; name: string; timezone: string }>(
      "SELECT id, name, timezone FROM tenants WHERE slug = $1",
      [carrier.slug],
    ),
  );
  if (rows.length !== 1) throw new Error(`no tenant ${carrier.slug}: run npm run demo:users first`);
  const [t] = rows;
  if (!isUuid(t.id) || t.name !== carrier.name || t.timezone !== carrier.timezone) {
    throw new Error(`tenant ${carrier.slug} does not match the demo carrier`);
  }
  return t.id;
}

// A replace re-creates every subject with the same id, so the tenant's old ledger rows (keyed
// kind:subject:attempt) would replay their old outcome, or block the subject for good, against
// the new rows. The app role has no DELETE on money_actions, so the admin login removes them. That
// login ignores row-level security, so each statement names the tenant itself, as a bound
// parameter. Two kinds of row make a clear refuse and delete nothing, in the same transaction
// as the delete: a row still reserved, sent or unknown, which may have reached the outside system
// (the reconcile pass needs its keys to read the outcome back); and a row failed as
// amount_mismatch, whatever its state, which is the permanent block reserve() keeps on that
// subject because money may have moved for another amount, so only a person may lift it. The
// refusal names the counts only. Otherwise it removes settled rows (confirmed or failed), and the
// delete itself skips amount_mismatch rows too, so one that appears after the count stays.
//
// The clear runs in two halves around the replace, because the admin and the app logins cannot
// share a transaction and the replace can fail after the clear committed:
//   clearTenantLedger, before the replace: refuses on any open or amount_mismatch row of either
//     channel, and removes settled PAYMENT rows only. A payout's subject (an advance or a
//     settlement) still refuses a second payout by its own status if the replace then fails.
//   clearTenantBookings, after the replace committed: removes settled ACCOUNTING rows. A booking
//     has no subject status to fall back on (a customer payment has none, and the old rows stay
//     until the replace lands), so its ledger row is the only thing that stops a second post.
//     If the replace fails, those rows stay and a new approval replays them instead of posting
//     again; if this clear fails, the same holds until the seed runs again.
// Each returns the rows deleted.
export async function clearTenantLedger(admin: Db, tenantId: string): Promise<number> {
  return clearSettled(admin, tenantId, "payment");
}

export async function clearTenantBookings(admin: Db, tenantId: string): Promise<number> {
  return clearSettled(admin, tenantId, "accounting");
}

async function clearSettled(
  admin: Db,
  tenantId: string,
  channel: "payment" | "accounting",
): Promise<number> {
  if (!isUuid(tenantId)) throw new Error("not a tenant id; nothing was cleared");
  return admin.withTenant(tenantId, async (q) => {
    // Before the replace both channels must be settled; after it only the bookings are left.
    const scope = channel === "payment" ? "" : " AND channel = 'accounting'";
    const rows = await q.query<{ open: unknown; mismatch: unknown }>(
      `SELECT count(*) FILTER (WHERE state IN ('reserved', 'sent', 'unknown')) AS open,
              count(*) FILTER (WHERE failure_category = 'amount_mismatch') AS mismatch
         FROM money_actions WHERE tenant_id = CAST($1 AS uuid)${scope}`,
      [tenantId],
    );
    const open = rows.length === 1 ? Number(rows[0].open) : NaN;
    const mismatch = rows.length === 1 ? Number(rows[0].mismatch) : NaN;
    const counted = (n: number) => Number.isSafeInteger(n) && n >= 0;
    if (!counted(open) || !counted(mismatch)) {
      throw new Error("could not count the tenant's ledger rows; nothing was cleared");
    }
    const blocked: string[] = [];
    if (open > 0) {
      blocked.push(
        `${open} ledger row(s) still reserved, sent or unknown; settle them before a reseed`,
      );
    }
    if (mismatch > 0) {
      blocked.push(
        `${mismatch} ledger row(s) failed as amount_mismatch; a person must review them ` +
          "before a reseed",
      );
    }
    if (blocked.length > 0) throw new Error(`${blocked.join("; ")} (nothing was cleared)`);
    return q.execute(
      `DELETE FROM money_actions
        WHERE tenant_id = CAST($1 AS uuid) AND channel = $2 AND state IN ('confirmed', 'failed')
          AND failure_category IS DISTINCT FROM 'amount_mismatch'`,
      [tenantId, channel],
    );
  });
}

// The agent's records go next, after the ledger and before the replace: a settled money action
// names its proposal, and a proposal names the untrusted input the replace deletes. The app role
// has no DELETE on these tables (they are the record of what the agent did), so the admin login
// removes them, naming the tenant in every statement. Children first, in one transaction. A
// proposal a ledger row still references (one the ledger clear kept) makes the delete fail and
// the transaction roll back, so nothing is half cleared. Returns the rows deleted.
const AGENT_CLEAR = [
  "DELETE FROM turn_steps WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM proposals WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM turns WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM conversations WHERE tenant_id = CAST($1 AS uuid)",
] as const;

export async function clearTenantAgent(admin: Db, tenantId: string): Promise<number> {
  return admin.withTenant(tenantId, async (q) => {
    let deleted = 0;
    for (const sql of AGENT_CLEAR) deleted += await q.execute(sql, [tenantId]);
    return deleted;
  });
}

// Inside the tenant transaction: the current tenant is the carrier the plan was built for.
export async function verifyTenant(q: Queryable, carrier: DemoCarrier): Promise<void> {
  const tenant = await readTenant(q);
  if (
    !tenant ||
    tenant.slug !== carrier.slug ||
    tenant.name !== carrier.name ||
    tenant.timezone !== carrier.timezone
  ) {
    throw new Error(`the current tenant is not ${carrier.slug}`);
  }
}

export async function replaceTenantData(
  app: TenantDb,
  tenantId: string,
  plan: CarrierPlan,
): Promise<SeedReport> {
  return app.withTenant(tenantId, async (q) => {
    await verifyTenant(q, plan.carrier);
    const deleted = await deleteTenantRows(q);
    const inserted = await insertTenantRows(q, plan.rows);
    const counts = await countTenantRows(q);
    const expected = countRows(plan.rows);
    for (const table of TENANT_TABLES) {
      if (inserted[table] !== expected[table] || counts[table] !== expected[table]) {
        throw new Error(`${table}: the rows read back differ from the plan`);
      }
    }
    return { deleted, inserted };
  });
}
