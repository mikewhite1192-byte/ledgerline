import { describe, expect, it } from "vitest";
import type { Session } from "../../auth/claims";
import type { Param, Queryable, TenantDb } from "../../db";
import { RATE_FILL_STATUSES } from "../../documents/match";
import type { ProposalRow } from "../execute";
import { loadRateFill } from "./load-rate-fill";

// The rate fill against a scripted database: one transaction, the proposal locked, the load
// written only while it has no rate, and every status move one the proposals guard allows.

const SESSION: Session = { sub: "sub-ops", email: "ops@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const LOAD = "44444444-4444-4444-8444-444444444444";
const NOW = new Date(Date.UTC(2026, 9, 24, 15, 0, 0));

// status and loaded_miles default to the ones the proposal was checked against (612 miles at
// 245 cents a mile is the 149,940 linehaul).
type Load = { linehaul_cents: number | null; fuel_surcharge_cents: number; status?: string; loaded_miles?: number };
const SQL_STATUSES = `status IN (${RATE_FILL_STATUSES.map((s) => `'${s}'`).join(", ")})`;

class ScriptDb implements TenantDb {
  status: string;
  load: Load | null;
  moves: [string, string, string | null][] = [];
  loadWrites = 0;
  transactions = 0;

  constructor(status: string, load: Load | null) {
    this.status = status;
    this.load = load;
  }

  async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    expect(tenantId).toBe(SESSION.tenantId);
    this.transactions += 1;
    const q: Queryable = {
      query: async <R>(sql: string) => this.query(sql) as R[],
      execute: async (sql: string, params: Param[] = []) => this.execute(sql, params),
    };
    return fn(q);
  }

  private query(sql: string): unknown[] {
    if (sql.includes("FROM memberships")) return [{ ok: 1 }];
    if (sql.includes("FROM proposals") && sql.includes("FOR UPDATE")) return [{ status: this.status }];
    if (sql.includes("FROM loads")) return this.load ? [{ ...this.load }] : [];
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  }

  private execute(sql: string, params: Param[]): number {
    if (sql.startsWith("UPDATE loads")) {
      expect(sql).toContain("linehaul_cents IS NULL");
      expect(sql).toContain("tenant_id = current_tenant_id()");
      expect(sql).toContain(SQL_STATUSES);
      expect(sql).toContain("CAST(loaded_miles AS bigint) * $4 = $2");
      expect(sql).toContain("(fuel_surcharge_cents = 0 OR fuel_surcharge_cents = $3)");
      if (!this.load || this.load.linehaul_cents !== null) return 0;
      const fsc = this.load.fuel_surcharge_cents;
      if (fsc !== 0 && fsc !== params[2]) return 0;
      const status = this.load.status ?? "delivered";
      const miles = this.load.loaded_miles ?? 612;
      if (!(RATE_FILL_STATUSES as readonly string[]).includes(status)) return 0;
      if (miles * (params[3] as number) !== params[1]) return 0;
      this.loadWrites += 1;
      this.load = { ...this.load, linehaul_cents: params[1] as number, fuel_surcharge_cents: params[2] as number };
      return 1;
    }
    if (sql.trimStart().startsWith("UPDATE proposals")) {
      const [, from, to, note] = params as [string, string, string, string | null];
      if (this.status !== from) return 0;
      this.moves.push([from, to, note]);
      this.status = to;
      return 1;
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  }
}

function proposal(over: Partial<ProposalRow> = {}, args: Record<string, unknown> = {}): ProposalRow {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    conversationId: "c1",
    turnId: "t1",
    kind: "load_rate_fill",
    subjectTable: "loads",
    subjectId: LOAD,
    amountCents: 0,
    direction: "none",
    args: { loadId: LOAD, linehaulCents: 149_940, fuelSurchargeCents: 18_360, ratePerMileCents: 245, ...args },
    status: "approved",
    flaggedInputId: null,
    auditorVerdict: null,
    auditorAgrees: null,
    moneyActionId: null,
    traceId: "trace-1",
    ...over,
  };
}

const run = (db: ScriptDb, p: ProposalRow = proposal()) => loadRateFill(db, SESSION, p, { confirmed: false }, { clock: () => NOW });

describe("loadRateFill", () => {
  it("fills the empty rate once and moves approved to executing to done, with no money action", async () => {
    const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 0 });
    const out = await run(db);
    expect(out).toEqual({ ok: true, proposalId: proposal().id, status: "done", moneyActionId: null });
    expect(db.load).toEqual({ linehaul_cents: 149_940, fuel_surcharge_cents: 18_360 });
    expect(db.loadWrites).toBe(1);
    expect(db.moves).toEqual([
      ["approved", "executing", null],
      ["executing", "done", null],
    ]);
    expect(db.transactions).toBe(1);
  });

  it("finishes a resume when the load already carries exactly these values", async () => {
    const db = new ScriptDb("executing", { linehaul_cents: 149_940, fuel_surcharge_cents: 18_360 });
    const out = await run(db);
    expect(out.ok).toBe(true);
    expect(db.loadWrites).toBe(0);
    expect(db.moves).toEqual([["executing", "done", null]]);
  });

  it("fails with changed_since when the load now carries different values", async () => {
    const db = new ScriptDb("approved", { linehaul_cents: 150_000, fuel_surcharge_cents: 18_360 });
    const out = await run(db);
    expect(out).toEqual({ ok: false, category: "changed_since", retryable: false });
    expect(db.load?.linehaul_cents).toBe(150_000);
    expect(db.moves).toEqual([["approved", "failed", "changed_since"]]);
  });

  it("fails with changed_since when the load was cancelled or invoiced after the proposal, writing nothing", async () => {
    for (const status of ["cancelled", "invoiced"]) {
      const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 0, status });
      expect(await run(db)).toEqual({ ok: false, category: "changed_since", retryable: false });
      expect(db.loadWrites).toBe(0);
      expect(db.load?.linehaul_cents).toBeNull();
      expect(db.moves).toEqual([["approved", "failed", "changed_since"]]);
    }
  });

  it("fails with changed_since when the load's loaded miles changed after the proposal, writing nothing", async () => {
    const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 0, loaded_miles: 613 });
    expect(await run(db)).toEqual({ ok: false, category: "changed_since", retryable: false });
    expect(db.loadWrites).toBe(0);
    expect(db.moves).toEqual([["approved", "failed", "changed_since"]]);
  });

  it("fills a load whose surcharge is already the document's value", async () => {
    const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 18_360 });
    expect(await run(db)).toMatchObject({ ok: true, status: "done" });
    expect(db.load).toEqual({ linehaul_cents: 149_940, fuel_surcharge_cents: 18_360 });
    expect(db.loadWrites).toBe(1);
  });

  it("fails with changed_since when the load was given another surcharge after the proposal, writing nothing", async () => {
    const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 9_000 });
    expect(await run(db)).toEqual({ ok: false, category: "changed_since", retryable: false });
    expect(db.loadWrites).toBe(0);
    expect(db.load).toEqual({ linehaul_cents: null, fuel_surcharge_cents: 9_000 });
    expect(db.moves).toEqual([["approved", "failed", "changed_since"]]);
  });

  it("fills a load in each status the proposal limit accepts", async () => {
    for (const status of RATE_FILL_STATUSES) {
      const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 0, status });
      expect(await run(db)).toMatchObject({ ok: true, status: "done" });
      expect(db.loadWrites).toBe(1);
    }
  });

  it("fails with changed_since when the load is gone", async () => {
    const db = new ScriptDb("approved", null);
    expect(await run(db)).toEqual({ ok: false, category: "changed_since", retryable: false });
  });

  it("fails closed on args that are not whole cents or name another load, writing nothing", async () => {
    for (const bad of [
      proposal({}, { linehaulCents: 12.5 }),
      proposal({}, { linehaulCents: 0 }),
      proposal({}, { fuelSurchargeCents: -1 }),
      proposal({}, { fuelSurchargeCents: "100" }),
      proposal({}, { ratePerMileCents: 0 }),
      proposal({}, { ratePerMileCents: 100_000 }),
      proposal({}, { ratePerMileCents: undefined }),
      proposal({}, { loadId: "66666666-6666-4666-8666-666666666666" }),
      proposal({ subjectTable: "drivers" }),
    ]) {
      const db = new ScriptDb("approved", { linehaul_cents: null, fuel_surcharge_cents: 0 });
      expect(await run(db, bad)).toEqual({ ok: false, category: "invalid_args", retryable: false });
      expect(db.loadWrites).toBe(0);
      expect(db.moves).toEqual([["approved", "failed", "invalid_args"]]);
    }
  });

  it("does nothing to a proposal that is not approved or executing", async () => {
    for (const status of ["proposed", "done", "failed", "rejected"]) {
      const db = new ScriptDb(status, { linehaul_cents: null, fuel_surcharge_cents: 0 });
      expect(await run(db)).toEqual({ ok: false, category: "already_decided", retryable: false });
      expect(db.loadWrites).toBe(0);
      expect(db.moves).toEqual([]);
    }
  });
});
