import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { explainPaystub } from "../agent/gateway/tools/read/explain-paystub";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { addJudge, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { ForbiddenError } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { nameOf } from "./list";
import { runPayPeriod } from "./run";
import { markStubSent, stubSummary } from "./stub-sent";
import { readSettlementRecord } from "./views";
import { POST } from "../../app/api/settlements/[id]/stub-sent/route";

// The route reads its session and database from here: no one is signed in unless a case sets one,
// and the staff check runs on the app's role.
const holder = vi.hoisted(() => ({ db: undefined as unknown, session: null as unknown }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSession: async () => holder.session,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => holder.db,
}));

// The stub sent mark (0086) against a real database seeded with a demo carrier under its own slug,
// as the app's role. A staff member marks a paid stub sent; a second press writes nothing; a draft,
// an approved stub, another carrier's stub, a judge, a signed-out caller, a cross-site post and the
// switch off each write nothing. The clock is fixed. Each case puts the two columns back to null
// as admin in finally; both tenants made here are removed after.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const saved = structuredClone(flags);

const CARRIER = {
  ...DEMO_CARRIERS[0],
  slug: "stub-sent-test",
  name: "Stub Sent Test Carrier",
} as unknown as DemoCarrier;
const T = randomUUID();
const PLAN = buildCarrierPlan(CARRIER, golden.anchor);
const EMAIL = `admin@${CARRIER.slug}.example`;
const STAFF: Session = { sub: `stub-sent-admin-${T}`, email: "", tenantId: T };

let admin: Db;
let app: Db;
let other: Fixture | undefined;
let judge: Session;
let staffId: string;

const rows = <R extends object>(sql: string, params: Param[] = []) =>
  admin.withTenant(T, (q) => q.query<R>(sql, params));
const write = (sql: string, params: Param[] = []) => admin.withTenant(T, (q) => q.execute(sql, params));

const OPEN = (() => {
  const p = PLAN.rows.settlement_periods.find((x) => x.status === "open");
  if (!p) throw new Error("no open period");
  return p;
})();

// Two paid stubs of the seed, paid before the fixed clock: one to mark, one left unmarked.
const [PAID, UNMARKED] = (() => {
  const paid = PLAN.rows.settlements
    .filter((s) => s.status === "paid" && s.paid_at !== null && Date.parse(s.paid_at) < NOW)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (paid.length < 2) throw new Error("fewer than two paid stubs in the seed");
  return [paid[0], paid[1]];
})();

type Mark = { stub_sent_at: string | null; stub_sent_by: string | null; x: string };
const markOf = async (id: string): Promise<Mark> => {
  const [m] = await rows<Mark>(
    `SELECT to_char(stub_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stub_sent_at,
            CAST(stub_sent_by AS text) AS stub_sent_by, CAST(xmin AS text) AS x
       FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id],
  );
  if (!m) throw new Error("no such stub");
  return m;
};
const markedCount = async () =>
  Number(
    (
      await rows<{ n: string }>(
        "SELECT count(*) AS n FROM settlements WHERE tenant_id = current_tenant_id() AND stub_sent_at IS NOT NULL",
      )
    )[0].n,
  );
const clearMarks = () =>
  write("UPDATE settlements SET stub_sent_at = NULL, stub_sent_by = NULL WHERE tenant_id = current_tenant_id()");

const firstDraft = async (): Promise<string> => {
  const [d] = await rows<{ id: string }>(
    `SELECT CAST(id AS text) AS id FROM settlements
      WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid) AND status = 'draft' ORDER BY id LIMIT 1`,
    [OPEN.id],
  );
  if (!d) throw new Error("no draft in the open week");
  return d.id;
};

const post = (settlementId: string, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/settlements/${settlementId}/stub-sent`, { method: "POST", headers }), {
    params: Promise.resolve({ id: settlementId }),
  });

const explain = (driverId: string, periodId: string) =>
  app.withTenant(T, (q) =>
    explainPaystub.run(q, { timeZone: CARRIER.timezone } as never, { driverId, periodId }, {} as never),
  );

describe("the stub sent mark against a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    holder.db = app;
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug = $1", [CARRIER.slug]),
    );
    if (leftover.length > 0) throw new Error("a stub-sent-test tenant already exists: use a fresh database");
    staffId = await admin.withTenant(T, async (q) => {
      await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        CARRIER.slug,
        CARRIER.name,
        CARRIER.timezone,
      ]);
      const [m] = await q.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, $2, 'admin') RETURNING CAST(id AS text) AS id`,
        [STAFF.sub, EMAIL],
      );
      return m.id;
    });
    await replaceTenantData(app, T, PLAN);
    judge = await addJudge(admin, { tenantId: T } as Fixture);
    other = await makeTenant(admin, "stub-sent-other");
    flags.settlementsEnabled = true;
    flags.stubSent.enabled = true;
    flags.payoutsEnabled = false;
    flags.accountingEnabled = false;
    flags.auditorEnabled = false;
    flags.auditorRequired = false;
    const r = await runPayPeriod(app, STAFF, OPEN.id, clock());
    if (!r.ok) throw new Error(`the pay run refused: ${r.category}`);
  }, 120_000);

  afterAll(async () => {
    Object.assign(flags, saved);
    vi.useRealTimers();
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"));
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    await dropTenant(admin, other);
    await app?.close();
    await admin?.close();
  });

  it("0086 validated its three constraints, and each bad mark is refused by its own", async () => {
    const checks = await admin.withoutTenant((q) =>
      q.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conname IN ('settlements_stub_sent_by_fk', 'settlements_stub_sent_pair', 'settlements_stub_sent_paid')
          ORDER BY conname COLLATE "C"`,
      ),
    );
    expect(checks).toEqual([
      { conname: "settlements_stub_sent_by_fk", convalidated: true },
      { conname: "settlements_stub_sent_paid", convalidated: true },
      { conname: "settlements_stub_sent_pair", convalidated: true },
    ]);
    // The seed and the pay run mark nothing.
    expect(await markedCount()).toBe(0);
    const set = (id: string, at: string | null, by: string | null) =>
      write(
        `UPDATE settlements SET stub_sent_at = CAST($2 AS timestamptz), stub_sent_by = CAST($3 AS uuid)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, at, by],
      );
    const draft = await firstDraft();
    const after = new Date(NOW).toISOString();
    try {
      // When without who, and who without when.
      expect(await sqlStateOf(set(PAID.id, after, null))).toBe("23514");
      expect(await sqlStateOf(set(PAID.id, null, staffId))).toBe("23514");
      // A draft, and a paid stub marked before it was paid.
      expect(await sqlStateOf(set(draft, after, staffId))).toBe("23514");
      const before = new Date(Date.parse(PAID.paid_at as string) - 60_000).toISOString();
      expect(await sqlStateOf(set(PAID.id, before, staffId))).toBe("23514");
      // A person who is no membership of this carrier, nor another carrier's.
      expect(await sqlStateOf(set(PAID.id, after, randomUUID()))).toBe("23503");
      expect(await sqlStateOf(set(PAID.id, after, other!.memberId))).toBe("23503");
      expect(await markedCount()).toBe(0);
      // A whole, well-formed mark goes in.
      expect(await set(PAID.id, after, staffId)).toBe(1);
    } finally {
      await clearMarks();
    }
    expect(await markedCount()).toBe(0);
  });

  it("marks a paid stub sent by the clicker, and a second press writes nothing", async () => {
    try {
      const first = await markStubSent(app, STAFF, PAID.id, clock());
      expect(first).toEqual({ ok: true, already: false, sentAt: new Date(NOW).toISOString() });
      const stored = await markOf(PAID.id);
      expect(stored).toMatchObject({ stub_sent_at: new Date(NOW).toISOString(), stub_sent_by: staffId });
      expect(await markedCount()).toBe(1);

      const second = await markStubSent(app, STAFF, PAID.id, new Date(NOW + 3_600_000));
      expect(second).toEqual({ ok: true, already: true, sentAt: new Date(NOW).toISOString() });
      // The same stored values and the same row version: no UPDATE ran.
      expect(await markOf(PAID.id)).toEqual(stored);
      expect(await markedCount()).toBe(1);

      // The record page reads the mark, the person named by role.
      const view = await app.withTenant(T, (q) => readSettlementRecord(q, PAID.id));
      expect(view?.stubSent).toEqual({ at: new Date(NOW).toISOString(), byRole: "admin" });
    } finally {
      await clearMarks();
    }
  });

  it("shows the agent the stub line and who sent it by role, never the membership id or email", async () => {
    try {
      const before = await explain(PAID.driver_id, PAID.period_id);
      const driver = PLAN.rows.drivers.find((d) => d.id === PAID.driver_id)!;
      const period = PLAN.rows.settlement_periods.find((p) => p.id === PAID.period_id)!;
      const summary = stubSummary({
        driverName: nameOf(driver.first_name, driver.last_name),
        driverCode: driver.code,
        periodEnd: period.period_end,
        grossCents: PAID.gross_cents,
        deductionsCents: PAID.deductions_cents,
        netCents: PAID.net_cents,
        carryForwardCents: PAID.carry_forward_cents,
        paidOn: localDateOf(PAID.paid_at as string, CARRIER.timezone),
      });
      expect((before.result as { stub: unknown }).stub).toEqual({ summary, sent: null });

      expect(await markStubSent(app, STAFF, PAID.id, clock())).toMatchObject({ ok: true, already: false });
      const after = await explain(PAID.driver_id, PAID.period_id);
      expect((after.result as { stub: unknown }).stub).toEqual({
        summary,
        sent: { at: new Date(NOW).toISOString(), byRole: "admin" },
      });
      const text = JSON.stringify(after);
      expect(text).not.toContain(staffId);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(STAFF.sub);

      // Another paid stub reads as not yet sent; a draft carries no stub line at all.
      const unmarked = await explain(UNMARKED.driver_id, UNMARKED.period_id);
      expect((unmarked.result as { stub: { sent: unknown } }).stub.sent).toBeNull();
      const [d] = await rows<{ driver_id: string }>(
        "SELECT CAST(driver_id AS text) AS driver_id FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [await firstDraft()],
      );
      const draft = await explain(d.driver_id, OPEN.id);
      expect((draft.result as { stub: unknown }).stub).toBeNull();
    } finally {
      await clearMarks();
    }
  });

  it("refuses a draft and an approved stub as not_paid_yet, writing nothing", async () => {
    const draft = await firstDraft();
    const before = await markOf(draft);
    expect(await markStubSent(app, STAFF, draft, clock())).toEqual({ ok: false, category: "not_paid_yet", retryable: false });
    await write("UPDATE settlements SET status = 'approved' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
      draft,
    ]);
    try {
      expect(await markStubSent(app, STAFF, draft, clock())).toEqual({
        ok: false,
        category: "not_paid_yet",
        retryable: false,
      });
    } finally {
      await write("UPDATE settlements SET status = 'draft' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        draft,
      ]);
      await clearMarks();
    }
    expect((await markOf(draft)).stub_sent_at).toBeNull();
    expect(before.stub_sent_at).toBeNull();
    expect(await markedCount()).toBe(0);
  });

  it("reads another carrier's paid stub as not_found, and a missing one too, writing nothing", async () => {
    try {
      expect(await markStubSent(app, other!.session, PAID.id, clock())).toEqual({
        ok: false,
        category: "not_found",
        retryable: false,
      });
      expect(await markStubSent(app, STAFF, randomUUID(), clock())).toEqual({
        ok: false,
        category: "not_found",
        retryable: false,
      });
      expect(await markedCount()).toBe(0);
    } finally {
      await clearMarks();
    }
  });

  it("refuses a judge in the service and on the route, writing nothing", async () => {
    try {
      await expect(markStubSent(app, judge, PAID.id, clock())).rejects.toBeInstanceOf(ForbiddenError);
      holder.session = judge;
      const res = await post(PAID.id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "judge", retryable: false });
      expect(await markedCount()).toBe(0);
    } finally {
      holder.session = null;
      await clearMarks();
    }
  });

  it("on the route: signed out is 401, cross-site is 403, a bad id is 400, and the switch off is 404, each writing nothing", async () => {
    try {
      const signedOut = await post(PAID.id);
      expect(signedOut.status).toBe(401);
      expect(await signedOut.json()).toEqual({ error: "unauthenticated" });
      holder.session = STAFF;
      const crossSite = await post(PAID.id, { "sec-fetch-site": "cross-site" });
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toEqual({ error: "forbidden" });
      const bad = await post("not-a-uuid");
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "bad_request" });
      flags.stubSent.enabled = false;
      try {
        // A signed-out caller is refused before the switch is asked, so the answer says nothing of it.
        holder.session = null;
        expect((await post(PAID.id)).status).toBe(401);
        holder.session = STAFF;
        const off = await post(PAID.id);
        expect(off.status).toBe(404);
        expect(await off.json()).toEqual({ error: "disabled" });
        expect(await markStubSent(app, STAFF, PAID.id, clock())).toEqual({
          ok: false,
          category: "disabled",
          retryable: false,
        });
      } finally {
        flags.stubSent.enabled = true;
      }
      expect(await markedCount()).toBe(0);
    } finally {
      holder.session = null;
      await clearMarks();
    }
  });

  it("on the route: a staff press marks the stub, a second press answers already, and an unpaid stub is 409", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      holder.session = STAFF;
      const res = await post(PAID.id.toUpperCase());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, already: false, sentAt: new Date(NOW).toISOString() });
      const stored = await markOf(PAID.id);
      expect(stored).toMatchObject({ stub_sent_at: new Date(NOW).toISOString(), stub_sent_by: staffId });
      const again = await post(PAID.id);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, already: true, sentAt: new Date(NOW).toISOString() });
      expect(await markOf(PAID.id)).toEqual(stored);
      const unpaid = await post(await firstDraft());
      expect(unpaid.status).toBe(409);
      expect(await unpaid.json()).toEqual({ error: "not_paid_yet" });
      expect(await markedCount()).toBe(1);
    } finally {
      vi.useRealTimers();
      holder.session = null;
      await clearMarks();
    }
  });
});
