import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import type { AuditResult } from "../../agent/auditor/run";
import type { Explained } from "../../agent/sweep/explain";
import type { Session } from "../../auth/claims";
import { readTenantRows } from "../../data/read";
import { checkInputOf, settlementInputOf } from "../../data/records";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db } from "../../db/types";
import { runAllChecks, settleDriver } from "../../rules-engine";
import { DEMO_CARRIERS, type DemoCarrier } from "../../seed/carriers";
import { buildCarrierPlan } from "../../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../../seed/run";
import { fixPlanFor, type FixLeg } from "../../sweep/plan";
import { advanceSweep, startSweep, type SweepDeps } from "../../sweep/run";
import type { Queryable, TenantDb } from "../../db/types";
import { executeProposal, type Executor, type ProposalRow } from "../execute";
import { CORRECTION_SUBKIND, correctionItemRef, payCorrectionExecutor, precheckPayCorrection } from "./pay-correction";

// The pay correction executor against the real database, as the app's role. The proposals come
// from a real sweep of the seeded open week (only the explanation and the auditor are stand-ins,
// the auditor storing a pass); a person's approval then runs the executor, which writes one pay
// item for the next pay run and nothing else. One tenant under its own slug, removed after.

const ANCHOR = "2026-11-02";
const NOW = new Date("2026-11-02T16:00:00.000Z");
const clock = () => NOW;
const CARRIER = { ...DEMO_CARRIERS[0], slug: "sweep-exec-test", name: "Sweep Exec Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const openWeek = plan.periods[3];
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@sweep-exec-test.example", tenantId: T };
const saved = { ...flags };
const input = checkInputOf(plan.rows);
const findings = runAllChecks(input);
// The engine's fix leg for a check (the seed places each plant by the carrier's slug, so the
// drivers are looked up from the engine, never by code).
function legOf(check: string, leg = 1): FixLeg {
  const f = findings.find((x) => x.check === check);
  const found = f && fixPlanFor(f, input, openWeek).find((l) => l.leg === leg);
  if (!found || found.kind !== "fix") throw new Error(`no fix leg for ${check}`);
  return found;
}

let admin: Db;
let app: Db;

const explain = vi.fn(
  async (): Promise<Explained> => ({ ok: true, text: "The engine found this.", callId: randomUUID(), costNanocents: 0 }),
);
const runAudit = vi.fn(async (_s: Session, id: string): Promise<AuditResult> => {
  await admin.withTenant(T, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [id, NOW.toISOString()],
    ),
  );
  return { state: "done", verdict: "pass", concerns: [], checkedAt: NOW.toISOString() };
});
type P = { id: string; subject_id: string; amount_cents: string; direction: string; status: string };

// A sweep of the open week, run to the end; its drafted proposals by driver id.
async function sweep(): Promise<Map<string, P[]>> {
  const d: SweepDeps = { db: app, clock, explain, runAudit };
  const s = await startSweep(SESSION, { runId: randomUUID(), trigger: "button" }, d);
  if (!s.ok) throw new Error(`start refused: ${s.category}`);
  for (let i = 0; i < 30; i++) {
    const a = await advanceSweep(SESSION, s.runId, NOW.getTime() + 20_000, d);
    if (!a.ok) throw new Error(`advance refused: ${a.category}`);
    if (a.status !== "running") break;
  }
  const rows = await admin.withTenant(T, (q) =>
    q.query<P>(
      `SELECT CAST(id AS text) AS id, CAST(subject_id AS text) AS subject_id,
              CAST(amount_cents AS text) AS amount_cents, direction, status
         FROM proposals WHERE kind = 'pay_correction'`,
    ),
  );
  const by = new Map<string, P[]>();
  for (const r of rows) by.set(r.subject_id, [...(by.get(r.subject_id) ?? []), r]);
  return by;
}

async function corrections(proposalId?: string) {
  return admin.withTenant(T, (q) =>
    q.query<{ id: string; driver_id: string; kind: string; amount_cents: string; item_date: string; ref_id: string; settlement_id: string | null }>(
      `SELECT CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, kind, CAST(amount_cents AS text) AS amount_cents,
              to_char(item_date, 'YYYY-MM-DD') AS item_date, CAST(ref_id AS text) AS ref_id,
              CAST(settlement_id AS text) AS settlement_id
         FROM pay_items
        WHERE subkind = $1 AND ($2 = '' OR item_ref = $2)`,
      [CORRECTION_SUBKIND, proposalId ? correctionItemRef(proposalId) : ""],
    ),
  );
}

async function proposal(id: string) {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ status: string; decision_note: string | null; decided_by: string | null }>(
      "SELECT status, decision_note, decided_by FROM proposals WHERE id = CAST($1 AS uuid)",
      [id],
    ),
  );
  return rows[0];
}

const approve = (id: string) => executeProposal(SESSION, id, { confirmed: false }, { db: app, clock });

async function settleOpenWeek(driverId: string) {
  const rows = await app.withTenant(T, readTenantRows);
  return settleDriver(settlementInputOf(rows, driverId, openWeek));
}

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
         (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@sweep-exec-test.invalid', 'staff'),
         (current_tenant_id(), $1, $2, 'staff')`,
      [SESSION.sub, SESSION.email],
    ),
  );
});

beforeEach(async () => {
  flags.sweepEnabled = true;
  flags.payCorrectionsEnabled = true;
  vi.spyOn(console, "info").mockImplementation(() => {});
  await admin.withTenant(T, (q) => q.execute("DELETE FROM pay_items WHERE subkind = $1", [CORRECTION_SUBKIND]));
  await clearTenantAgent(admin, T);
});

afterEach(() => {
  Object.assign(flags, saved);
  vi.restoreAllMocks();
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

describe("approving a sweep's pay correction", () => {
  it("writes exactly one pay item for the next pay run, the engine's amount to the cent", async () => {
    const by = await sweep();
    const leg = legOf("duplicate_advance");
    expect(leg.expectedCents).toBe(34000);
    const [owed] = by.get(leg.driverId)!;
    const before = await settleOpenWeek(leg.driverId);

    expect(await approve(owed.id)).toEqual({ ok: true, proposalId: owed.id, status: "done", moneyActionId: null });
    expect(await proposal(owed.id)).toMatchObject({ status: "done", decided_by: SESSION.sub });
    const items = await corrections(owed.id);
    expect(items).toEqual([
      {
        id: expect.any(String),
        driver_id: leg.driverId,
        kind: "reimbursement",
        amount_cents: "34000",
        // Today in the carrier's zone (Nov 2) is past the week, so the item sits on its last day.
        item_date: openWeek.end,
        ref_id: owed.id,
        settlement_id: null,
      },
    ]);
    // The second click finds it decided and writes nothing more.
    expect(await approve(owed.id)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await corrections()).toHaveLength(1);

    // The engine's pay run picks the line up: one more line, gross up by the correction.
    const after = await settleOpenWeek(leg.driverId);
    const line = after.lines.find((l) => l.sources.some((s) => s.table === "pay_items" && s.id === items[0].id));
    expect(line).toMatchObject({ kind: "reimbursement", amountCents: 34000 });
    expect(after.lines).toHaveLength(before.lines.length + 1);
    expect(after.grossCents - before.grossCents).toBe(34000);
  });

  it("books an amount owed by the driver as a deduction", async () => {
    const by = await sweep();
    const leg = legOf("fuel_on_wrong_driver", 2);
    expect(leg.expectedCents).toBe(-28640);
    const [owes] = by.get(leg.driverId)!;
    expect(owes).toMatchObject({ amount_cents: "28640", direction: "in" });
    expect(await approve(owes.id)).toMatchObject({ ok: true, status: "done" });
    const [item] = await corrections(owes.id);
    expect(item).toMatchObject({ kind: "other_deduction", amount_cents: "28640", driver_id: leg.driverId });
    const line = (await settleOpenWeek(leg.driverId)).lines.find((l) => l.sources.some((s) => s.id === item.id));
    expect(line?.amountCents).toBe(-28640);
  });

  it("on a resume after the item landed, finishes the status and writes nothing; with none, writes one", async () => {
    const by = await sweep();
    const insurance = legOf("insurance_day_not_driven");
    const [landed] = by.get(insurance.driverId)!;
    const [missing] = by.get(legOf("missing_reimbursement").driverId)!;
    // As if an earlier approval stopped inside the executor: both rows executing, and the first
    // one's pay item already written.
    await admin.withTenant(T, async (q) => {
      for (const id of [landed.id, missing.id]) {
        await q.execute(
          `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz)
            WHERE id = CAST($1 AS uuid)`,
          [id, SESSION.sub, NOW.toISOString()],
        );
        await q.execute("UPDATE proposals SET status = 'executing' WHERE id = CAST($1 AS uuid)", [id]);
      }
      await q.execute(
        `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, ref_table, ref_id,
                                item_ref, description)
         VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'reimbursement', $2, 1100,
                 CAST($3 AS date), 'proposals', CAST($4 AS uuid), $5, 'Correction: written before the stop')`,
        [insurance.driverId, CORRECTION_SUBKIND, openWeek.end, landed.id, correctionItemRef(landed.id)],
      );
    });
    const [first] = await corrections(landed.id);

    expect(await approve(landed.id)).toMatchObject({ ok: true, status: "done" });
    expect(await proposal(landed.id)).toMatchObject({ status: "done" });
    expect(await corrections(landed.id)).toEqual([first]);

    expect(await approve(missing.id)).toMatchObject({ ok: true, status: "done" });
    expect(await corrections(missing.id)).toMatchObject([{ kind: "reimbursement", amount_cents: "17500" }]);
    expect(await corrections()).toHaveLength(2);
  });

  it("refuses as stale before the approval once the week is no longer open, leaving it waiting", async () => {
    const by = await sweep();
    const [owed] = by.get(legOf("missing_reimbursement").driverId)!;
    const period = plan.rows.settlement_periods.find((p) => p.period_start === openWeek.start)!;
    await admin.withTenant(T, (q) =>
      q.execute("UPDATE settlement_periods SET status = 'approved' WHERE id = CAST($1 AS uuid)", [period.id]),
    );
    try {
      expect(await approve(owed.id)).toEqual({ ok: false, category: "stale", retryable: false });
      // The precheck refused it while it was still proposed: never approved, never failed, and a
      // person can still reject it.
      expect(await proposal(owed.id)).toEqual({ status: "proposed", decision_note: null, decided_by: null });
      expect(await corrections()).toEqual([]);
    } finally {
      await admin.withTenant(T, (q) =>
        q.execute("UPDATE settlement_periods SET status = 'open' WHERE id = CAST($1 AS uuid)", [period.id]),
      );
    }
  });

  it("refuses as stale when the driver's pay run is approved, or the item it moves was settled", async () => {
    const by = await sweep();
    const fuelLeg = legOf("fuel_on_wrong_driver", 1);
    const insuranceLeg = legOf("insurance_day_not_driven");
    const fuel = by.get(fuelLeg.driverId)!;
    expect(fuel).toHaveLength(1);
    const insurance = by.get(insuranceLeg.driverId)!;
    const period = plan.rows.settlement_periods.find((p) => p.period_start === openWeek.start)!;
    // The pay item the fuel fix names (the charge on the wrong driver).
    const fuelItem = fuelLeg.payItemId;
    if (!fuelItem) throw new Error("the fuel fix names no pay item");
    const settlementFor = async (driverId: string, status: "draft" | "approved") => {
      const id = randomUUID();
      await admin.withTenant(T, (q) =>
        q.execute(
          `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
                                    deductions_cents, net_cents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid),
                   (SELECT id FROM pay_configs ORDER BY effective_from LIMIT 1), $4, 0, 0, 0)`,
          [id, period.id, driverId, status],
        ),
      );
      return id;
    };
    const made: string[] = [];
    try {
      made.push(await settlementFor(insuranceLeg.driverId, "approved"));
      expect(await approve(insurance[0].id)).toMatchObject({ ok: false, category: "stale" });

      // The fuel fix names the pay item it moves; once that item is on a pay run, it is stale
      // even while the run is a draft.
      const draft = await settlementFor(fuelLeg.driverId, "draft");
      made.push(draft);
      await admin.withTenant(T, (q) =>
        q.execute("UPDATE pay_items SET settlement_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid)", [fuelItem, draft]),
      );
      expect(await approve(fuel[0].id)).toMatchObject({ ok: false, category: "stale" });
      expect(await proposal(fuel[0].id)).toEqual({ status: "proposed", decision_note: null, decided_by: null });
      expect(await proposal(insurance[0].id)).toMatchObject({ status: "proposed", decided_by: null });
      expect(await corrections()).toEqual([]);
    } finally {
      await admin.withTenant(T, async (q) => {
        await q.execute("UPDATE pay_items SET settlement_id = NULL WHERE id = CAST($1 AS uuid)", [fuelItem]);
        for (const id of made) await q.execute("DELETE FROM settlements WHERE id = CAST($1 AS uuid)", [id]);
      });
    }
  });

  it("still fails a correction as stale when the week closes between the approval and its execution", async () => {
    const by = await sweep();
    const [owed] = by.get(legOf("missing_reimbursement").driverId)!;
    const period = plan.rows.settlement_periods.find((p) => p.period_start === openWeek.start)!;
    // As if the gate approved it (the precheck passed) and the week closed before the executor's
    // own transaction ran: the next approve takes the resume path, where no precheck is asked.
    await admin.withTenant(T, async (q) => {
      await q.execute(
        `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz)
          WHERE id = CAST($1 AS uuid)`,
        [owed.id, SESSION.sub, NOW.toISOString()],
      );
      await q.execute("UPDATE settlement_periods SET status = 'approved' WHERE id = CAST($1 AS uuid)", [period.id]);
    });
    try {
      expect(await approve(owed.id)).toEqual({ ok: false, category: "stale", retryable: false });
      expect(await proposal(owed.id)).toMatchObject({ status: "failed", decision_note: "stale" });
      expect(await corrections()).toEqual([]);
    } finally {
      await admin.withTenant(T, (q) =>
        q.execute("UPDATE settlement_periods SET status = 'open' WHERE id = CAST($1 AS uuid)", [period.id]),
      );
    }
  });

  it("refuses as not_executable with its switch off, on an approval and on a resume, writing nothing", async () => {
    const by = await sweep();
    const [owed] = by.get(legOf("duplicate_advance").driverId)!;
    const [resumed] = by.get(legOf("missing_reimbursement").driverId)!;
    await admin.withTenant(T, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz)
          WHERE id = CAST($1 AS uuid)`,
        [resumed.id, SESSION.sub, NOW.toISOString()],
      ),
    );
    flags.payCorrectionsEnabled = false;
    const off = { ok: false, category: "not_executable", retryable: false };

    expect(await approve(owed.id)).toEqual(off);
    expect(await proposal(owed.id)).toMatchObject({ status: "proposed", decided_by: null });
    expect(await approve(resumed.id)).toEqual(off);
    expect(await proposal(resumed.id)).toMatchObject({ status: "approved" });
    expect(await corrections()).toEqual([]);

    // Reached directly, the executor and its precheck refuse before any read or write.
    const untouchable: Queryable = {
      query: () => Promise.reject(new Error("read with the switch off")),
      execute: () => Promise.reject(new Error("write with the switch off")),
    };
    const noDb: TenantDb = { withTenant: () => Promise.reject(new Error("opened with the switch off")) };
    const row = { id: resumed.id, kind: "pay_correction" } as ProposalRow;
    expect(await precheckPayCorrection(untouchable, row, NOW)).toEqual(off);
    expect(await payCorrectionExecutor(noDb, SESSION, row, { confirmed: false }, { db: noDb, clock })).toEqual(off);

    // Switched on again, the waiting one approves as usual.
    flags.payCorrectionsEnabled = true;
    expect(await approve(owed.id)).toMatchObject({ ok: true, status: "done" });
    expect(await corrections(owed.id)).toHaveLength(1);
  });

  it("resumes an approval whose execution never finished, writing exactly one pay item", async () => {
    const by = await sweep();
    const [owed] = by.get(legOf("insurance_day_not_driven").driverId)!;
    // The first approval commits, then its execution stops (as if the answer was lost): the row
    // stays approved and nothing is written.
    const stops: Executor = async () => {
      throw new Error("stopped after the approval");
    };
    await expect(
      executeProposal(SESSION, owed.id, { confirmed: false }, { db: app, clock, executors: { pay_correction: stops } }),
    ).rejects.toThrow("stopped after the approval");
    expect(await proposal(owed.id)).toMatchObject({ status: "approved" });
    expect(await corrections()).toEqual([]);

    // The resume re-checks the switch.
    flags.payCorrectionsEnabled = false;
    expect(await approve(owed.id)).toEqual({ ok: false, category: "not_executable", retryable: false });
    expect(await corrections()).toEqual([]);

    // With it on, the resume finishes the correction once; a repeat is already decided.
    flags.payCorrectionsEnabled = true;
    expect(await approve(owed.id)).toMatchObject({ ok: true, status: "done" });
    expect(await corrections(owed.id)).toMatchObject([{ kind: "reimbursement", amount_cents: "1100" }]);
    expect(await approve(owed.id)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await corrections()).toHaveLength(1);
  });
});
