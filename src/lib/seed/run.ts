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
//
// A ledger row that names an advance an approval created (one with a proposal_id) makes a clear
// refuse too. money_actions has no foreign key to advances, and the agent clear deletes those
// advances before the replace, so nothing else would stop it leaving such a row naming an advance
// that no longer exists. clearTenantAgent refuses on any such row. clearTenantLedger refuses on
// the booking rows among them (it removes the settled payout rows itself), so npm run seed refuses
// before its first delete rather than after the payout rows are gone. clearTenantBookings does
// not check: a person who has reviewed such a booking row may remove it that way.
const FLOW_ADVANCE_ROWS = `SELECT count(*) AS n FROM money_actions m
   WHERE m.tenant_id = CAST($1 AS uuid) AND m.subject_table = 'advances'
     AND EXISTS (SELECT 1 FROM advances a
                  WHERE a.tenant_id = CAST($1 AS uuid) AND a.id = m.subject_id
                    AND a.proposal_id IS NOT NULL)`;

async function countFlowAdvanceRows(
  q: Queryable,
  tenantId: string,
  bookingsOnly: boolean,
): Promise<number> {
  const scope = bookingsOnly ? " AND m.channel = 'accounting'" : "";
  const rows = await q.query<{ n: unknown }>(`${FLOW_ADVANCE_ROWS}${scope}`, [tenantId]);
  const n = rows.length === 1 ? Number(rows[0].n) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("could not count the tenant's ledger rows; nothing was cleared");
  }
  return n;
}

const flowAdvanceBlock = (n: number) =>
  `${n} ledger row(s) name an advance an approval created; a person must review them before ` +
  "a reseed";

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
    if (channel === "payment") {
      const flow = await countFlowAdvanceRows(q, tenantId, true);
      if (flow > 0) blocked.push(flowAdvanceBlock(flow));
    }
    if (blocked.length > 0) throw new Error(`${blocked.join("; ")} (nothing was cleared)`);
    // An escrow release names its payout row (a foreign key with no delete action), so the
    // releases go first; the app role cannot delete them.
    if (channel === "payment") {
      await q.execute("DELETE FROM escrow_releases WHERE tenant_id = CAST($1 AS uuid)", [tenantId]);
    }
    return q.execute(
      `DELETE FROM money_actions
        WHERE tenant_id = CAST($1 AS uuid) AND channel = $2 AND state IN ('confirmed', 'failed')
          AND failure_category IS DISTINCT FROM 'amount_mismatch'`,
      [tenantId, channel],
    );
  });
}

// The agent's records go after the payout rows and before the replace, and once more after the
// booking rows. A money action names the proposal it carried out (a foreign key with no delete
// action), and a proposal names the untrusted input the replace deletes. The app role has no
// DELETE on these tables (they are the record of what the agent did), so the admin login removes
// them, naming the tenant in every statement. Children first, in one transaction.
//
// A proposal a ledger row still names is kept, with its turn, that turn's steps and its
// conversation. Before the replace those are the proposals behind settled booking rows, which
// stay until the replace lands (see clearTenantBookings); the second call, after the booking
// clear, removes them. A kept proposal flagged by an outside message would make the replace fail
// (it deletes every untrusted input of the tenant), so the clear refuses up front, deleting
// nothing, while one exists: a person must review it. A ledger row that comes to name a proposal
// after the check still makes the delete fail and the transaction roll back, so nothing is half
// cleared. Driver notes (0019) go first: each names a settlement and a driver the replace
// deletes, they name no proposal, and the app role has no DELETE on them either. An advance born
// from an approval names its proposal, so those advances go before the proposals; the seeded ones
// are replaced after. While a ledger row names one of those advances, the clear also refuses up
// front, deleting nothing (see FLOW_ADVANCE_ROWS). It locks them before it counts, and reserve()
// locks its advance before it writes a row, so a payout or post reserved for one either lands
// before the count or finds its advance gone after the delete. Voice notes (0012) go first of
// all: each names a conversation and an input, and nothing names a voice note. Returns the rows
// deleted.
const NAMED_BY_LEDGER = `SELECT 1 FROM money_actions m
   WHERE m.tenant_id = CAST($1 AS uuid) AND m.proposal_id = p.id`;

// The sweep's records go right after the driver notes (an item names its proposal and its run; a
// run names its conversation and its week), and its approval batches last (a proposal names its batch), each
// unlinked from any proposal that is kept.
const AGENT_CLEAR = [
  // Uploaded documents first: each points at its transcription in untrusted_inputs, and no
  // proposal or ledger row names a document, so none is kept.
  "DELETE FROM documents WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM voice_notes WHERE tenant_id = CAST($1 AS uuid)",
  // The phone line's turns, segments and calls (0068): a segment names an input the replace
  // deletes. The app role has no DELETE on them; a row written after this goes with its driver.
  "DELETE FROM call_turns WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM call_segments WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM calls WHERE tenant_id = CAST($1 AS uuid)",
  // Inbox messages (0037) too: each names an input the replace deletes and a conversation, and
  // nothing names one, so a reseed starts with an empty Inbox, as the demo reset does.
  "DELETE FROM inbound_messages WHERE tenant_id = CAST($1 AS uuid)",
  // Dock clips first too: each names a load the replace deletes. The app role has no DELETE on
  // them (a redacted clip is evidence), so only this reseed path removes them.
  "DELETE FROM evidence_clips WHERE tenant_id = CAST($1 AS uuid)",
  "DELETE FROM driver_notes WHERE tenant_id = CAST($1 AS uuid)",
  // A run's second opinion names its turns and drivers, so it goes before both.
  `DELETE FROM sweep_fanout_checks WHERE tenant_id = CAST($1 AS uuid)`,
  `DELETE FROM sweep_fanout WHERE tenant_id = CAST($1 AS uuid)`,
  `DELETE FROM sweep_items WHERE tenant_id = CAST($1 AS uuid)`,
  `DELETE FROM sweep_runs WHERE tenant_id = CAST($1 AS uuid)`,
  // The fuel checks' findings name a fill-up, a load and a pay line the replace deletes, and the
  // card they drafted; their runs go after them (0031).
  `DELETE FROM fuel_findings WHERE tenant_id = CAST($1 AS uuid)`,
  `DELETE FROM fuel_check_runs WHERE tenant_id = CAST($1 AS uuid)`,
  `DELETE FROM turn_steps s
    WHERE s.tenant_id = CAST($1 AS uuid)
      AND NOT EXISTS (SELECT 1 FROM proposals p
                       WHERE p.tenant_id = CAST($1 AS uuid) AND p.turn_id = s.turn_id
                         AND EXISTS (${NAMED_BY_LEDGER}))`,
  "DELETE FROM advances WHERE tenant_id = CAST($1 AS uuid) AND proposal_id IS NOT NULL",
  `DELETE FROM proposals p
    WHERE p.tenant_id = CAST($1 AS uuid) AND NOT EXISTS (${NAMED_BY_LEDGER})`,
  `DELETE FROM turns t
    WHERE t.tenant_id = CAST($1 AS uuid)
      AND NOT EXISTS (SELECT 1 FROM proposals p
                       WHERE p.tenant_id = CAST($1 AS uuid) AND p.turn_id = t.id)`,
  `DELETE FROM conversations c
    WHERE c.tenant_id = CAST($1 AS uuid)
      AND NOT EXISTS (SELECT 1 FROM turns t
                       WHERE t.tenant_id = CAST($1 AS uuid) AND t.conversation_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM proposals p
                       WHERE p.tenant_id = CAST($1 AS uuid) AND p.conversation_id = c.id)`,
  `UPDATE proposals SET batch_id = NULL
    WHERE tenant_id = CAST($1 AS uuid) AND batch_id IS NOT NULL
      AND batch_id IN (SELECT b.id FROM approval_batches b
                        WHERE b.tenant_id = CAST($1 AS uuid) AND b.scope = 'proposals')`,
  `DELETE FROM approval_batches WHERE tenant_id = CAST($1 AS uuid) AND scope = 'proposals'`,
] as const;

export async function clearTenantAgent(admin: Db, tenantId: string): Promise<number> {
  if (!isUuid(tenantId)) throw new Error("not a tenant id; nothing was cleared");
  return admin.withTenant(tenantId, async (q) => {
    await q.query(
      `SELECT 1 FROM advances
        WHERE tenant_id = CAST($1 AS uuid) AND proposal_id IS NOT NULL FOR UPDATE`,
      [tenantId],
    );
    const rows = await q.query<{ flagged: unknown }>(
      `SELECT count(*) AS flagged FROM proposals p
        WHERE p.tenant_id = CAST($1 AS uuid) AND p.flagged_input_id IS NOT NULL
          AND EXISTS (${NAMED_BY_LEDGER})`,
      [tenantId],
    );
    const flagged = rows.length === 1 ? Number(rows[0].flagged) : NaN;
    if (!Number.isSafeInteger(flagged) || flagged < 0) {
      throw new Error("could not count the tenant's proposals; nothing was cleared");
    }
    const flow = await countFlowAdvanceRows(q, tenantId, false);
    const blocked: string[] = [];
    if (flagged > 0) {
      blocked.push(
        `${flagged} proposal(s) a ledger row still names carry a flag from an outside message ` +
          "the replace deletes; a person must review them before a reseed",
      );
    }
    if (flow > 0) blocked.push(flowAdvanceBlock(flow));
    if (blocked.length > 0) throw new Error(`${blocked.join("; ")} (nothing was cleared)`);
    let deleted = 0;
    for (const sql of AGENT_CLEAR) deleted += await q.execute(sql, [tenantId]);
    return deleted;
  });
}

// The arming log (0027) is append-only for the app role, which has no DELETE on it, so the admin
// login clears the tenant's log before the replace, naming the tenant in the statement because
// that login skips row-level security. The replace then writes the plan's log again. A row written
// between this clear and the replace goes with its driver when the replace deletes the drivers
// (the foreign key cascades). Returns the rows deleted.
export async function clearTenantArmLog(admin: Db, tenantId: string): Promise<number> {
  if (!isUuid(tenantId)) throw new Error("not a tenant id; nothing was cleared");
  return admin.withTenant(tenantId, (q) =>
    q.execute("DELETE FROM driver_arm_events WHERE tenant_id = CAST($1 AS uuid)", [tenantId]),
  );
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
  return app.withTenant(tenantId, (q) => replaceInTransaction(q, plan));
}

// The replace itself, inside a tenant transaction the caller opened (the demo reset runs it after
// its clear, in the same transaction). Any difference throws, and the caller's transaction rolls
// back.
export async function replaceInTransaction(q: Queryable, plan: CarrierPlan): Promise<SeedReport> {
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
}
