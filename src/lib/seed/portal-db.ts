import type { Db } from "../db/types";
import type { PortalPlan } from "./portal";
import { renderPortalPod } from "./portal-pdf";

// Writes the fictional portal's rows for one tenant through the admin login. The app role has no
// DELETE on the portal tables and no INSERT on the portal's own records (a run only reads them),
// so the seed uses the admin login, which skips row security: every statement names the tenant.

// Children first. A run and its session point at each other, so the runs let go of their
// sessions before the sessions go. Must run before the replace, which deletes the loads and the
// untrusted inputs these rows point at. Returns the rows deleted.
const PORTAL_CLEAR = [
  "DELETE FROM portal_evidence WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM portal_run_checks WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM portal_run_steps WHERE tenant_id = CAST($1 AS uuid)",
  "UPDATE portal_runs SET session_id = NULL WHERE tenant_id = CAST($1 AS uuid) AND session_id IS NOT NULL",
  "DELETE FROM portal_sessions WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM portal_runs WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM portal_loads WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM portal_accounts WHERE tenant_id = CAST($1 AS uuid)",
] as const;

export async function clearTenantPortal(admin: Db, tenantId: string): Promise<number> {
  return admin.withTenant(tenantId, async (q) => {
    let deleted = 0;
    for (const sql of PORTAL_CLEAR) {
      const n = await q.execute(sql, [tenantId]);
      if (sql.startsWith("DELETE")) deleted += n;
    }
    return deleted;
  });
}

// After the replace: the account and one row per delivered load, PODs rendered first so a
// render failure writes nothing. Returns the portal loads written.
export async function seedTenantPortal(admin: Db, tenantId: string, plan: PortalPlan): Promise<number> {
  const pods = new Map<string, { data: string; bytes: number; hash: string }>();
  for (const l of plan.loads) {
    if (l.podStatus !== "available") continue;
    const pod = await renderPortalPod(l, plan.carrierName);
    pods.set(l.id, { data: pod.bytes.toString("base64"), bytes: pod.bytes.length, hash: pod.hash });
  }
  return admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO portal_accounts (tenant_id, carrier_number, carrier_name) VALUES (CAST($1 AS uuid), $2, $3)",
      [tenantId, plan.carrierNumber, plan.carrierName],
    );
    let written = 0;
    for (const l of plan.loads) {
      const pod = pods.get(l.id) ?? null;
      written += await q.execute(
        "INSERT INTO portal_loads (id, tenant_id, load_id, reference, shipper_name, consignee_name, consignee_city," +
          " consignee_state, scheduled_from, scheduled_to, delivery_checked_in_at, delivery_checked_out_at," +
          " facility_time_zone, pod_status, pod_signed_by, pod_signed_at, pod_pdf, pod_byte_length, pod_content_hash," +
          " notes, seed_key) VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, $6, $7, $8," +
          " CAST($9 AS timestamptz), CAST($10 AS timestamptz), CAST($11 AS timestamptz), CAST($12 AS timestamptz)," +
          " $13, $14, $15, CAST($16 AS timestamptz), decode($17, 'base64'), $18, $19, $20, $21)",
        [
          l.id,
          tenantId,
          l.loadId,
          l.reference,
          l.shipperName,
          l.consigneeName,
          l.consigneeCity,
          l.consigneeState,
          l.scheduledFrom,
          l.scheduledTo,
          l.checkedIn,
          l.checkedOut,
          l.facilityTimeZone,
          l.podStatus,
          l.podSignedBy,
          l.podSignedAt,
          pod?.data ?? null,
          pod?.bytes ?? null,
          pod?.hash ?? null,
          l.notes,
          l.seedKey,
        ],
      );
    }
    if (written !== plan.loads.length) throw new Error("the portal rows written differ from the plan");
    return written;
  });
}
