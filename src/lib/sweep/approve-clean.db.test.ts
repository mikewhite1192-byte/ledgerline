import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { AuditResult } from "../agent/auditor/run";
import type { Explained } from "../agent/sweep/explain";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { executeProposal, type ExecuteDeps } from "../proposals/execute";
import { CORRECTION_SUBKIND } from "../proposals/executors/pay-correction";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { approveClean } from "./approve-clean";
import { advanceSweep, startSweep, type SweepDeps } from "./run";

// "Approve all clean" against the real database, as the app's role: the list and total the
// person saw are re-checked under lock, any difference refuses the whole batch, the admin line
// applies to the batch total, and a replayed batch id never executes twice. The proposals come
// from a real sweep of the seeded open week (the explanation and the auditor are stand-ins, the
// auditor storing a pass). One tenant under its own slug, removed after.

const ANCHOR = "2026-11-02";
const NOW = new Date("2026-11-02T16:00:00.000Z");
const clock = () => NOW;
const CARRIER = { ...DEMO_CARRIERS[0], slug: "sweep-batch-test", name: "Sweep Batch Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@sweep-batch-test.example", tenantId: T };
const OTHER: Session = { sub: `other-${T}`, email: "ap@sweep-batch-test.example", tenantId: T };
const saved = { ...flags };

let admin: Db;
let app: Db;

const explain = vi.fn(
  async (): Promise<Explained> => ({ ok: true, text: "The engine found this.", callId: randomUUID(), costNanocents: 0 }),
);
// The auditor passes every fix, except the one audit a test names (counted from 1), which it
// stores as concerns. A verdict never changes once stored, so this is the only way one fix ends
// the sweep not clean.
const audits = { n: 0, concernsAt: 0 };
const runAudit = vi.fn(async (_s: Session, id: string): Promise<AuditResult> => {
  audits.n += 1;
  const pass = audits.n !== audits.concernsAt;
  await admin.withTenant(T, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = $3, auditor_agrees = $4, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [id, NOW.toISOString(), pass ? "pass" : "concerns", pass],
    ),
  );
  return { state: "done", verdict: pass ? "pass" : "concerns", concerns: [], checkedAt: NOW.toISOString() };
});

type P = { id: string; subject_id: string; amount_cents: string };

// A sweep of the open week, run to the end: its id, and its fixes in id order with their total.
async function sweep() {
  const d: SweepDeps = { db: app, clock, explain, runAudit };
  const s = await startSweep(SESSION, { runId: randomUUID(), trigger: "button" }, d);
  if (!s.ok) throw new Error(`start refused: ${s.category}`);
  for (let i = 0; i < 30; i++) {
    const a = await advanceSweep(SESSION, s.runId, NOW.getTime() + 20_000, d);
    if (!a.ok) throw new Error(`advance refused: ${a.category}`);
    if (a.status !== "running") break;
  }
  const fixes = await admin.withTenant(T, (q) =>
    q.query<P>(
      `SELECT CAST(id AS text) AS id, CAST(subject_id AS text) AS subject_id, CAST(amount_cents AS text) AS amount_cents
         FROM proposals WHERE kind = 'pay_correction' ORDER BY id`,
    ),
  );
  const ids = fixes.map((f) => f.id);
  const total = fixes.reduce((n, f) => n + Number(f.amount_cents), 0);
  return { runId: s.runId, fixes, ids, total };
}

async function statuses() {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ status: string }>("SELECT status FROM proposals WHERE kind = 'pay_correction' ORDER BY id"),
  );
  return rows.map((r) => r.status);
}

async function correctionCount() {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ n: string }>("SELECT CAST(count(*) AS text) AS n FROM pay_items WHERE subkind = $1", [CORRECTION_SUBKIND]),
  );
  return Number(rows[0].n);
}

async function batch(id: string) {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ status: string; total_cents: string; result: string | null }>(
      "SELECT status, CAST(total_cents AS text) AS total_cents, CAST(result AS text) AS result FROM approval_batches WHERE id = CAST($1 AS uuid)",
      [id],
    ),
  );
  return rows[0];
}

const approveAll = (runId: string, input: { batchId?: string; proposalIds: string[]; totalCents: number }, s = SESSION) =>
  approveClean(s, runId, { batchId: input.batchId ?? randomUUID(), ...input }, { db: app, clock });

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  await admin.withTenant(T, (q) =>
    q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      CARRIER.slug,
      CARRIER.name,
      CARRIER.timezone,
    ]),
  );
  await replaceTenantData(admin, T, plan);
  await admin.withTenant(T, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
         (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@sweep-batch-test.invalid', 'staff'),
         (current_tenant_id(), $1, $2, 'staff'),
         (current_tenant_id(), $3, $4, 'staff')`,
      [SESSION.sub, SESSION.email, OTHER.sub, OTHER.email],
    ),
  );
});

beforeEach(async () => {
  flags.sweepEnabled = true;
  audits.n = 0;
  audits.concernsAt = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
  await admin.withTenant(T, (q) => q.execute("DELETE FROM pay_items WHERE subkind = $1", [CORRECTION_SUBKIND]));
  await clearTenantAgent(admin, T);
});

afterEach(async () => {
  Object.assign(flags, saved);
  vi.restoreAllMocks();
  await admin.withTenant(T, (q) => q.execute("UPDATE memberships SET role = 'staff' WHERE cognito_sub = $1", [SESSION.sub]));
});

afterAll(async () => {
  Object.assign(flags, saved);
  if (admin) {
    await clearTenantAgent(admin, T).catch(() => undefined);
    await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
  }
  await app?.close();
  await admin?.close();
});

describe("approve all clean", () => {
  it("executes every clean fix once, and a replayed batch answers the stored result", async () => {
    const { runId, ids, total } = await sweep();
    expect(ids).toHaveLength(5);
    const batchId = randomUUID();

    const first = await approveAll(runId, { batchId, proposalIds: ids, totalCents: total });
    expect(first).toEqual({ ok: true, batchId, done: 5, refused: [], replay: false });
    expect(await statuses()).toEqual(Array(5).fill("done"));
    expect(await correctionCount()).toBe(5);
    expect(await batch(batchId)).toMatchObject({ status: "done", total_cents: String(total) });

    const again = await approveAll(runId, { batchId, proposalIds: ids, totalCents: total });
    expect(again).toEqual({ ok: true, batchId, done: 5, refused: [], replay: true });
    expect(await correctionCount()).toBe(5);
    // Another person can never replay this person's batch.
    expect(await approveAll(runId, { batchId, proposalIds: ids, totalCents: total }, OTHER)).toEqual({
      ok: false,
      category: "batch_taken",
    });
  });

  it("finishes a batch left reserved by a request that stopped part way, and runs no fix twice", async () => {
    const { runId, ids, total } = await sweep();
    const batchId = randomUUID();
    // The request stops on the third fix, after the first two ran.
    let calls = 0;
    const stopping = async (s: Session, id: string, d: ExecuteDeps) => {
      calls += 1;
      if (calls === 3) throw new Error("stopped");
      return executeProposal(s, id, { confirmed: false }, d);
    };
    await expect(
      approveClean(SESSION, runId, { batchId, proposalIds: ids, totalCents: total }, { db: app, clock, execute: stopping }),
    ).rejects.toThrow("stopped");
    expect(await batch(batchId)).toMatchObject({ status: "reserved", result: null });
    expect((await statuses()).filter((st) => st === "done")).toHaveLength(2);
    expect(await correctionCount()).toBe(2);

    // The same batch id again carries on with its own list: the two already done are counted, not
    // run again, and the other three run once each.
    expect(await approveAll(runId, { batchId, proposalIds: ids, totalCents: total })).toEqual({
      ok: true,
      batchId,
      done: 5,
      refused: [],
      replay: false,
    });
    expect(await statuses()).toEqual(Array(5).fill("done"));
    expect(await correctionCount()).toBe(5);
    expect(await batch(batchId)).toMatchObject({ status: "done", total_cents: String(total) });
    // A third try replays the stored answer.
    expect(await approveAll(runId, { batchId, proposalIds: ids, totalCents: total })).toMatchObject({
      ok: true,
      done: 5,
      replay: true,
    });
    expect(await correctionCount()).toBe(5);
  });

  it("refuses the whole batch on a different total, answering what is clean now", async () => {
    const { runId, ids, total } = await sweep();
    const batchId = randomUUID();
    const res = await approveAll(runId, { batchId, proposalIds: ids, totalCents: total + 1 });
    expect(res).toEqual({ ok: false, category: "changed", clean: [...ids].sort(), totalCents: total });
    expect(await statuses()).toEqual(Array(5).fill("proposed"));
    expect(await correctionCount()).toBe(0);
    expect(await batch(batchId)).toMatchObject({ status: "refused" });
    // The same batch id with the same list and total answers the same refusal.
    expect(await approveAll(runId, { batchId, proposalIds: ids, totalCents: total + 1 })).toMatchObject({
      ok: false,
      category: "changed",
    });
    // The same id with the corrected total is not a replay: it is refused, never approved.
    expect(await approveAll(runId, { batchId, proposalIds: ids, totalCents: total })).toEqual({
      ok: false,
      category: "batch_reused",
    });
    expect(await statuses()).toEqual(Array(5).fill("proposed"));
    expect(await correctionCount()).toBe(0);
  });

  it("refuses a batch id used again for a different list, and replays it for its own list", async () => {
    const { runId, fixes, ids, total } = await sweep();
    const two = fixes.slice(0, 2);
    const twoIds = two.map((f) => f.id);
    const twoTotal = two.reduce((n, f) => n + Number(f.amount_cents), 0);
    const batchId = randomUUID();
    expect(await approveAll(runId, { batchId, proposalIds: twoIds, totalCents: twoTotal })).toMatchObject({
      ok: true,
      done: 2,
      replay: false,
    });
    // The stored answer for two fixes is never given for all five: the five stay waiting.
    expect(await approveAll(runId, { batchId, proposalIds: ids, totalCents: total })).toEqual({
      ok: false,
      category: "batch_reused",
    });
    expect((await statuses()).filter((st) => st === "proposed")).toHaveLength(3);
    expect(await correctionCount()).toBe(2);
    expect(await batch(batchId)).toMatchObject({ status: "done", total_cents: String(twoTotal) });
    // Its own list, in any order, still replays.
    expect(await approveAll(runId, { batchId, proposalIds: [...twoIds].reverse(), totalCents: twoTotal })).toEqual({
      ok: true,
      batchId,
      done: 2,
      refused: [],
      replay: true,
    });
    expect(await correctionCount()).toBe(2);
  });

  it("refuses the whole batch when one fix is no longer clean, or one was never in the run", async () => {
    audits.concernsAt = 3;
    const { runId, fixes, ids, total } = await sweep();
    const [{ id: flaggedId }] = await admin.withTenant(T, (q) =>
      q.query<{ id: string }>("SELECT CAST(id AS text) AS id FROM proposals WHERE auditor_verdict = 'concerns'"),
    );
    const flagged = fixes.find((f) => f.id === flaggedId)!;
    // The person saw five before the auditor finished: the list and the total they confirm.
    const res = await approveAll(runId, { proposalIds: ids, totalCents: total });
    const rest = ids.filter((id) => id !== flagged.id);
    expect(res).toEqual({ ok: false, category: "changed", clean: rest, totalCents: total - Number(flagged.amount_cents) });
    // An id outside the run, even with the right total, refuses too.
    const stranger = await approveAll(runId, {
      proposalIds: [...rest, randomUUID()],
      totalCents: total - Number(flagged.amount_cents),
    });
    expect(stranger).toMatchObject({ ok: false, category: "changed" });
    expect(await statuses()).toEqual(Array(5).fill("proposed"));
    expect(await correctionCount()).toBe(0);
  });

  it("needs an admin when the batch total is over the admin line, even with each fix under it", async () => {
    const { runId, fixes, ids, total } = await sweep();
    flags.approverRole = { adminAboveCents: total - 1 };
    expect(fixes.every((f) => Number(f.amount_cents) <= total - 1)).toBe(true);
    expect(await approveAll(runId, { proposalIds: ids, totalCents: total })).toEqual({ ok: false, category: "role" });
    expect(await statuses()).toEqual(Array(5).fill("proposed"));

    await admin.withTenant(T, (q) => q.execute("UPDATE memberships SET role = 'admin' WHERE cognito_sub = $1", [SESSION.sub]));
    expect(await approveAll(runId, { proposalIds: ids, totalCents: total })).toMatchObject({ ok: true, done: 5 });
    expect(await correctionCount()).toBe(5);
  });

  it("carries on past one fix that has gone stale, and undoes none of the others", async () => {
    const { runId, fixes, ids, total } = await sweep();
    const target = fixes[0];
    const period = plan.rows.settlement_periods.find((p) => p.period_start === plan.periods[3].start)!;
    const settlement = randomUUID();
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
                                  deductions_cents, net_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid),
                 (SELECT id FROM pay_configs ORDER BY effective_from LIMIT 1), 'approved', 0, 0, 0)`,
        [settlement, period.id, target.subject_id],
      ),
    );
    try {
      const res = await approveAll(runId, { proposalIds: ids, totalCents: total });
      const sameDriver = fixes.filter((f) => f.subject_id === target.subject_id).length;
      expect(res).toMatchObject({ ok: true, done: 5 - sameDriver });
      expect(res.ok && res.refused).toEqual(
        fixes.filter((f) => f.subject_id === target.subject_id).map((f) => ({ proposalId: f.id, ok: false, category: "stale" })),
      );
      expect(await correctionCount()).toBe(5 - sameDriver);
      // The stale ones were refused before their approval: they still wait for a person.
      expect((await statuses()).filter((s) => s === "proposed")).toHaveLength(sameDriver);
      expect((await statuses()).filter((s) => s === "done")).toHaveLength(5 - sameDriver);
    } finally {
      await admin.withTenant(T, (q) => q.execute("DELETE FROM settlements WHERE id = CAST($1 AS uuid)", [settlement]));
    }
  });
});
