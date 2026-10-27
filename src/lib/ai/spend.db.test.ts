import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { ForbiddenError } from "../tenant/context";
import { readRecentCalls, readSpend, reserve, settle, type Reservation, type Spend } from "./spend";
import { AiError } from "./types";
import { clearSpendAlert, readDaySpend, readSpendAlerts } from "./watch";

// The spend ledger as the app's own role sees it: reservations race on the counter's row lock,
// a settle happens once, refused calls release their reservation, unknown ones keep it, and a
// tenant sees only its own calls. The counter is global, so this file puts it back as it found it.
// Tenant C holds the spend watch's jobs, every one stamped with a fixed instant (never the clock).

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const tag = A.slice(0, 8);
const RESERVE = 500_000_000;
const USAGE = { input: 15, cached: 0, output: 64, reasoning: 62 };

let admin: Db;
let app: Db;
let before: Spend;

const session = (tenantId: string): Session => ({
  sub: `sub-${tenantId}`,
  email: `ops@${tenantId.slice(0, 8)}.example`,
  tenantId,
});

const reservation = (over: Partial<Reservation> = {}): Reservation => ({
  callId: randomUUID(),
  target: "spark",
  provider: "meta",
  model: "muse-spark-1.3",
  kind: "text",
  purpose: "proof",
  reasoningEffort: "low",
  traceId: null,
  reserveNanocents: RESERVE,
  capNanocents: Number.MAX_SAFE_INTEGER,
  wonderCapNanocents: null,
  jobCapNanocents: Number.MAX_SAFE_INTEGER,
  at: null,
  ...over,
});

const wonderReservation = (over: Partial<Reservation> = {}): Reservation =>
  reservation({
    target: "wonder",
    model: "muse-wonder-1.0",
    wonderCapNanocents: Number.MAX_SAFE_INTEGER,
    ...over,
  });

const spend = () => app.withTenant(A, (q) => readSpend(q));

const callRow = (tenantId: string, callId: string) =>
  admin.withTenant(tenantId, async (q) => {
    const [row] = await q.query<Record<string, unknown>>(
      `SELECT target, kind, reasoning_effort, trace_id, status, failure, reserved_nanocents,
              cost_nanocents, input_tokens, cached_tokens, output_tokens, reasoning_tokens, units,
              upstream_id, http_status, duration_ms, settled_at IS NOT NULL AS settled
         FROM model_calls WHERE id = CAST($1 AS uuid)`,
      [callId],
    );
    return row;
  });

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return err;
}

async function seed(tenantId: string, slug: string) {
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    await q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
      [`sub-${tenantId}`, `ops@${slug}.example`],
    );
  });
}

describe("model spend ledger", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    // Two connections, so two reservations can really wait on each other.
    app = createPgDb({ connectionString: appUrl(), max: 2 });
    await seed(A, `a-${tag}`);
    await seed(B, `b-${tag}`);
    await seed(C, `c-${tag}`);
    await admin.withTenant(C, (q) =>
      q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')",
        [`sub-staff-${C}`, `staff@c-${tag}.example`],
      ),
    );
    before = await spend();
  });

  afterAll(async () => {
    // Put the global counter back, then remove only this file's tenants (their calls go with them).
    if (before) {
      await admin.withoutTenant((q) =>
        q.execute(
          `UPDATE ops.ai_spend
              SET spent_nanocents = CAST($1 AS bigint), reserved_nanocents = CAST($2 AS bigint),
                  calls = CAST($3 AS bigint), wonder_spent_nanocents = CAST($4 AS bigint),
                  wonder_reserved_nanocents = CAST($5 AS bigint)
            WHERE id = 1`,
          [
            before.spentNanocents,
            before.reservedNanocents,
            before.calls,
            before.wonderSpentNanocents,
            before.wonderReservedNanocents,
          ],
        ),
      );
    }
    for (const id of [A, B, C]) {
      await admin?.withTenant(id, (q) =>
        q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"),
      );
    }
    await app?.close();
    await admin?.close();
  });

  it("reserves, then settles an answer to its real cost, once", async () => {
    const start = await spend();
    const trace = randomUUID();
    const r = reservation({ traceId: trace });
    await reserve(app, session(A), r);
    expect(await spend()).toEqual({
      ...start,
      reservedNanocents: start.reservedNanocents + RESERVE,
    });
    expect(await callRow(A, r.callId)).toMatchObject({
      target: "spark",
      kind: "text",
      reasoning_effort: "low",
      trace_id: trace,
      status: "reserved",
      reserved_nanocents: RESERVE,
      settled: false,
    });

    const answer = {
      kind: "answered" as const,
      status: "incomplete" as const,
      usage: USAGE,
      units: null,
      costNanocents: 29_075_000,
      upstreamId: "resp_test1",
      httpStatus: 200,
      durationMs: 812,
    };
    expect(await settle(app, session(A), r.callId, answer)).toBe(true);
    const settled = {
      ...start,
      spentNanocents: start.spentNanocents + 29_075_000,
      reservedNanocents: start.reservedNanocents,
      calls: start.calls + 1,
    };
    expect(await spend()).toEqual(settled);
    expect(await callRow(A, r.callId)).toEqual({
      target: "spark",
      kind: "text",
      reasoning_effort: "low",
      trace_id: trace,
      status: "incomplete",
      failure: null,
      reserved_nanocents: RESERVE,
      cost_nanocents: 29_075_000,
      input_tokens: 15,
      cached_tokens: 0,
      output_tokens: 64,
      reasoning_tokens: 62,
      units: null,
      upstream_id: "resp_test1",
      http_status: 200,
      duration_ms: 812,
      settled: true,
    });

    // The same settlement again, or a different one, changes nothing.
    expect(await settle(app, session(A), r.callId, answer)).toBe(false);
    expect(
      await settle(app, session(A), r.callId, {
        kind: "refused",
        category: "rate_limited",
        httpStatus: 429,
        durationMs: 1,
      }),
    ).toBe(false);
    expect(await spend()).toEqual(settled);
  });

  it("releases a refused call's reservation and spends nothing", async () => {
    const start = await spend();
    const r = reservation();
    await reserve(app, session(A), r);
    expect(
      await settle(app, session(A), r.callId, {
        kind: "refused",
        category: "billing",
        httpStatus: 402,
        durationMs: 90,
      }),
    ).toBe(true);
    expect(await spend()).toEqual({ ...start, calls: start.calls + 1 });
    expect(await callRow(A, r.callId)).toMatchObject({
      status: "failed",
      failure: "billing",
      cost_nanocents: 0,
      http_status: 402,
      input_tokens: null,
    });
  });

  it("keeps an unknown call's reservation counted against the cap, a timeout's too", async () => {
    for (const category of ["network", "timeout"] as const) {
      const start = await spend();
      const r = reservation();
      await reserve(app, session(A), r);
      expect(
        await settle(app, session(A), r.callId, {
          kind: "unknown",
          category,
          httpStatus: null,
          durationMs: 25_000,
        }),
      ).toBe(true);
      expect(await spend()).toEqual({
        ...start,
        reservedNanocents: start.reservedNanocents + RESERVE,
        calls: start.calls + 1,
      });
      expect(await callRow(A, r.callId)).toMatchObject({
        status: "unknown",
        failure: category,
        cost_nanocents: null,
        http_status: null,
        duration_ms: 25_000,
        settled: true,
      });
    }
  });

  it("lets exactly one of two racing reservations through when only one fits under the cap", async () => {
    const start = await spend();
    const cap = start.spentNanocents + start.reservedNanocents + RESERVE + RESERVE / 2;
    const first = reservation({ capNanocents: cap });
    const second = reservation({ capNanocents: cap });
    const results = await Promise.allSettled([
      reserve(app, session(A), first),
      reserve(app, session(B), second),
    ]);
    const passed = results.filter((r) => r.status === "fulfilled");
    const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(passed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(AiError);
    expect((refused[0] as AiError).category).toBe("cap");
    expect(await spend()).toEqual({
      ...start,
      reservedNanocents: start.reservedNanocents + RESERVE,
    });

    // The refused one wrote nothing.
    const rows = await Promise.all([callRow(A, first.callId), callRow(B, second.callId)]);
    expect(rows.filter(Boolean)).toHaveLength(1);
  });

  it("writes nothing for a login with no membership in the tenant", async () => {
    const start = await spend();
    const stranger = { ...session(A), sub: `sub-${randomUUID()}` };
    const r = reservation();
    expect(await failureOf(reserve(app, stranger, r))).toBeInstanceOf(ForbiddenError);
    expect(await callRow(A, r.callId)).toBeUndefined();
    expect(await spend()).toEqual(start);
  });

  it("shows a tenant only its own calls, and cannot settle another tenant's", async () => {
    const r = reservation();
    await reserve(app, session(A), r);
    const seenByA = await app.withTenant(A, (q) => readRecentCalls(q, 50));
    const seenByB = await app.withTenant(B, (q) => readRecentCalls(q, 50));
    expect(seenByA.map((c) => c.id)).toContain(r.callId);
    expect(seenByB.map((c) => c.id)).not.toContain(r.callId);
    expect(seenByA[0]).toMatchObject({ purpose: "proof", model: "muse-spark-1.3" });
    expect(seenByA[0].created_utc).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const start = await spend();
    expect(
      await settle(app, session(B), r.callId, {
        kind: "refused",
        category: "auth",
        httpStatus: 401,
        durationMs: 1,
      }),
    ).toBe(false);
    expect(await spend()).toEqual(start);
    expect(await callRow(A, r.callId)).toMatchObject({ status: "reserved" });
  });

  it("refuses the app a row for another tenant, a deleted ledger row, and a new counter row", async () => {
    const other = await failureOf(
      app.withTenant(B, (q) =>
        q.execute(
          `INSERT INTO model_calls (id, tenant_id, target, provider, model, purpose, status,
                                    reserved_nanocents)
           VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'spark', 'meta', 'muse-spark-1.3', 'proof',
                   'reserved', 1)`,
          [randomUUID(), A],
        ),
      ),
    );
    expect((other as { sqlState?: string }).sqlState).toBe("42501");

    const deleted = await failureOf(app.withTenant(A, (q) => q.execute("DELETE FROM model_calls")));
    expect((deleted as { sqlState?: string }).sqlState).toBe("42501");

    const added = await failureOf(
      app.withTenant(A, (q) =>
        q.execute("INSERT INTO ops.ai_spend (id) VALUES (1) ON CONFLICT DO NOTHING"),
      ),
    );
    expect((added as { sqlState?: string }).sqlState).toBe("42501");

    const removed = await failureOf(
      app.withTenant(A, (q) => q.execute("DELETE FROM ops.ai_spend")),
    );
    expect((removed as { sqlState?: string }).sqlState).toBe("42501");
  });

  it("refuses the app a change to anything a settle does not write, and still settles", async () => {
    const start = await spend();
    const r = reservation();
    await reserve(app, session(A), r);
    const refusals = [
      ["UPDATE model_calls SET tenant_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid)", B],
      ["UPDATE model_calls SET purpose = $2 WHERE id = CAST($1 AS uuid)", "other"],
      [
        "UPDATE model_calls SET reserved_nanocents = CAST($2 AS bigint) WHERE id = CAST($1 AS uuid)",
        1,
      ],
      ["UPDATE model_calls SET model = $2 WHERE id = CAST($1 AS uuid)", "muse-spark-1.0"],
    ] as const;
    for (const [sql, value] of refusals) {
      const err = await failureOf(app.withTenant(A, (q) => q.execute(sql, [r.callId, value])));
      expect((err as { sqlState?: string }).sqlState).toBe("42501");
    }
    const moved = await failureOf(
      app.withTenant(A, (q) => q.execute("UPDATE ops.ai_spend SET id = 2 WHERE id = 1")),
    );
    expect((moved as { sqlState?: string }).sqlState).toBe("42501");
    expect(await spend()).toEqual({
      ...start,
      reservedNanocents: start.reservedNanocents + RESERVE,
    });

    expect(
      await settle(app, session(A), r.callId, {
        kind: "answered",
        status: "ok",
        usage: USAGE,
        units: null,
        costNanocents: 1_000,
        upstreamId: "resp_narrow",
        httpStatus: 200,
        durationMs: 40,
      }),
    ).toBe(true);
    expect(await spend()).toEqual({
      ...start,
      spentNanocents: start.spentNanocents + 1_000,
      calls: start.calls + 1,
    });
    expect(await callRow(A, r.callId)).toMatchObject({
      status: "ok",
      reserved_nanocents: RESERVE,
      cost_nanocents: 1_000,
      upstream_id: "resp_narrow",
    });
  });

  it("keeps the renamed log's policy, forced row security and grants, and the old name is gone", async () => {
    const facts = await admin.withoutTenant(async (q) => {
      const [table] = await q.query<{ rls: boolean; forced: boolean; old: string | null }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                to_regclass('public.ai_calls')::text AS old
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'model_calls'`,
      );
      const policies = await q.query<{ policyname: string }>(
        "SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'model_calls'",
      );
      const [grants] = await q.query<Record<string, boolean>>(
        `SELECT has_table_privilege('payday_app', 'public.model_calls', 'SELECT') AS sel,
                has_table_privilege('payday_app', 'public.model_calls', 'INSERT') AS ins,
                has_table_privilege('payday_app', 'public.model_calls', 'UPDATE') AS upd,
                has_table_privilege('payday_app', 'public.model_calls', 'DELETE') AS del,
                has_table_privilege('payday_app', 'ops.ai_spend', 'INSERT') AS spend_ins,
                has_table_privilege('payday_app', 'ops.ai_spend', 'UPDATE') AS spend_upd,
                has_table_privilege('payday_app', 'ops.ai_spend', 'DELETE') AS spend_del`,
      );
      // Every column the app may update, on the two tables it updates.
      const updatable = await q.query<{ col: string }>(
        `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS col
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ((n.nspname = 'public' AND c.relname = 'model_calls')
                 OR (n.nspname = 'ops' AND c.relname = 'ai_spend'))
            AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('payday_app', c.oid, a.attnum, 'UPDATE')
          ORDER BY 1`,
      );
      return {
        table,
        policies: policies.map((p) => p.policyname),
        grants,
        updatable: updatable.map((u) => u.col),
      };
    });
    expect(facts.table).toEqual({ rls: true, forced: true, old: null });
    expect(facts.policies).toEqual(["tenant_isolation"]);
    // No table-wide UPDATE on either table: only the columns listed below.
    expect(facts.grants).toEqual({
      sel: true,
      ins: true,
      upd: false,
      del: false,
      spend_ins: false,
      spend_upd: false,
      spend_del: false,
    });
    expect(facts.updatable).toEqual(
      [
        ...[
          "status",
          "failure",
          "cost_nanocents",
          "input_tokens",
          "cached_tokens",
          "output_tokens",
          "reasoning_tokens",
          "upstream_id",
          "http_status",
          "duration_ms",
          "units",
          "settled_at",
        ].map((c) => `public.model_calls.${c}`),
        ...[
          "spent_nanocents",
          "reserved_nanocents",
          "wonder_spent_nanocents",
          "wonder_reserved_nanocents",
          "calls",
          "updated_at",
        ].map((c) => `ops.ai_spend.${c}`),
      ].sort(),
    );
  });

  it("refuses a Wonder reservation without a Wonder cap, writing nothing", async () => {
    const start = await spend();
    const r = wonderReservation({ wonderCapNanocents: null });
    const err = await failureOf(reserve(app, session(A), r));
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).category).toBe("not_configured");
    expect(await callRow(A, r.callId)).toBeUndefined();
    expect(await spend()).toEqual(start);
  });

  it("lets one of two racing Wonder reservations through when the overall cap fits both but Wonder's fits one", async () => {
    const start = await spend();
    const overall = start.spentNanocents + start.reservedNanocents + 2 * RESERVE + RESERVE / 2;
    const wonderCap =
      start.wonderSpentNanocents + start.wonderReservedNanocents + RESERVE + RESERVE / 2;
    const first = wonderReservation({ capNanocents: overall, wonderCapNanocents: wonderCap });
    const second = wonderReservation({ capNanocents: overall, wonderCapNanocents: wonderCap });
    const results = await Promise.allSettled([
      reserve(app, session(A), first),
      reserve(app, session(B), second),
    ]);
    const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as AiError).category).toBe("cap");
    expect(await spend()).toEqual({
      ...start,
      reservedNanocents: start.reservedNanocents + RESERVE,
      wonderReservedNanocents: start.wonderReservedNanocents + RESERVE,
    });

    // Wonder's cap is now full, and Spark still passes under the overall cap.
    const full = start.wonderSpentNanocents + start.wonderReservedNanocents + RESERVE;
    const third = wonderReservation({ wonderCapNanocents: full });
    expect(((await failureOf(reserve(app, session(A), third))) as AiError).category).toBe("cap");
    const spark = reservation({ capNanocents: overall, wonderCapNanocents: full });
    await reserve(app, session(A), spark);
    expect(await spend()).toEqual({
      ...start,
      reservedNanocents: start.reservedNanocents + 2 * RESERVE,
      wonderReservedNanocents: start.wonderReservedNanocents + RESERVE,
    });
  });

  it("moves Wonder's counters with the overall ones: spent when answered, released when refused, kept when unknown", async () => {
    const start = await spend();
    const answered = wonderReservation();
    const refused = wonderReservation();
    const unknown = wonderReservation();
    for (const r of [answered, refused, unknown]) await reserve(app, session(A), r);
    expect(await spend()).toEqual({
      ...start,
      reservedNanocents: start.reservedNanocents + 3 * RESERVE,
      wonderReservedNanocents: start.wonderReservedNanocents + 3 * RESERVE,
    });

    const cost = 15 * 400_000 + 64 * 2_000_000;
    const answer = {
      kind: "answered" as const,
      status: "ok" as const,
      usage: USAGE,
      units: null,
      costNanocents: cost,
      upstreamId: "resp_w1",
      httpStatus: 200,
      durationMs: 3_000,
    };
    expect(await settle(app, session(A), answered.callId, answer)).toBe(true);
    // Twice changes nothing.
    expect(await settle(app, session(A), answered.callId, answer)).toBe(false);
    expect(
      await settle(app, session(A), refused.callId, {
        kind: "refused",
        category: "rate_limited",
        httpStatus: 429,
        durationMs: 5,
      }),
    ).toBe(true);
    expect(
      await settle(app, session(A), unknown.callId, {
        kind: "unknown",
        category: "unavailable",
        httpStatus: 503,
        durationMs: 5,
      }),
    ).toBe(true);
    expect(await spend()).toEqual({
      spentNanocents: start.spentNanocents + cost,
      reservedNanocents: start.reservedNanocents + RESERVE,
      calls: start.calls + 3,
      wonderSpentNanocents: start.wonderSpentNanocents + cost,
      wonderReservedNanocents: start.wonderReservedNanocents + RESERVE,
    });
  });

  it("records the units a call that is not billed by tokens was charged for", async () => {
    const r = reservation({
      target: "voice",
      model: "muse-voice-transcribe-1.0",
      kind: "transcribe",
      reasoningEffort: null,
      reserveNanocents: 20_000_000,
    });
    await reserve(app, session(A), r);
    expect(
      await settle(app, session(A), r.callId, {
        kind: "answered",
        status: "ok",
        usage: null,
        units: 2,
        costNanocents: 10_000_000,
        upstreamId: "asr/1:abc",
        httpStatus: 200,
        durationMs: 900,
      }),
    ).toBe(true);
    expect(await callRow(A, r.callId)).toMatchObject({
      target: "voice",
      kind: "transcribe",
      reasoning_effort: null,
      status: "ok",
      units: 2,
      cost_nanocents: 10_000_000,
      input_tokens: null,
      upstream_id: "asr/1:abc",
    });
    const [row] = (await app.withTenant(A, (q) => readRecentCalls(q, 50))).filter(
      (c) => c.id === r.callId,
    );
    expect(row).toMatchObject({ target: "voice", kind: "transcribe", units: 2 });
  });

  it("logs a call to Spark Open's standby host under its own host, and refuses any other host", async () => {
    const start = await spend();
    const r = reservation({
      target: "spark_open",
      provider: "fireworks",
      model: "accounts/fireworks/models/muse-spark-open",
      reasoningEffort: null,
    });
    await reserve(app, session(A), r);
    expect(
      await settle(app, session(A), r.callId, {
        kind: "answered",
        status: "ok",
        usage: USAGE,
        units: null,
        costNanocents: 29_075_000,
        upstreamId: "chatcmpl-test1",
        httpStatus: 200,
        durationMs: 640,
      }),
    ).toBe(true);
    const hostOf = (callId: string) =>
      admin.withTenant(A, async (q) => {
        const rows = await q.query<{ provider: string; model: string; status: string }>(
          "SELECT provider, model, status FROM model_calls WHERE id = CAST($1 AS uuid)",
          [callId],
        );
        return rows;
      });
    expect(await hostOf(r.callId)).toEqual([
      { provider: "fireworks", model: "accounts/fireworks/models/muse-spark-open", status: "ok" },
    ]);
    const settled = {
      ...start,
      spentNanocents: start.spentNanocents + 29_075_000,
      calls: start.calls + 1,
    };
    expect(await spend()).toEqual(settled);

    // A host the log does not know is refused, and the reservation's counter move goes with it.
    const other = reservation({
      target: "spark_open",
      provider: "together" as Reservation["provider"],
      model: "muse-spark-open",
      reasoningEffort: null,
    });
    const err = await failureOf(reserve(app, session(A), other));
    expect((err as { sqlState?: string }).sqlState).toBe("23514");
    expect(await hostOf(other.callId)).toEqual([]);
    expect(await spend()).toEqual(settled);

    // The check carries the log's own name now, lists the standby host, and the old name is gone.
    const checks = await admin.withoutTenant((q) =>
      q.query<{ name: string; def: string }>(
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
          WHERE con.conrelid = to_regclass('public.model_calls')
            AND con.conname IN ('model_calls_provider_check', 'ai_calls_provider_check')`,
      ),
    );
    expect(checks.map((c) => c.name)).toEqual(["model_calls_provider_check"]);
    for (const host of ["meta", "baseten", "fireworks"]) {
      expect(checks[0]?.def).toContain(`'${host}'`);
    }
  });
  // --- The spend watch: a job's hourly allowance ---

  const CENT = 1_000_000_000;
  const JOB_CAP = 1_000 * CENT;
  const T0 = Date.parse("2026-10-27T12:00:00.000Z");
  // An instant this many minutes after T0, as the wrapper passes it.
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  const jobCall = (over: Partial<Reservation> = {}) =>
    reservation({ jobCapNanocents: JOB_CAP, ...over });
  const staff = (tenantId: string): Session => ({ ...session(tenantId), sub: `sub-staff-${tenantId}` });

  type AlertFacts = {
    id: string;
    trace_id: string | null;
    purpose: string;
    spent_nanocents: number;
    limit_nanocents: number;
    window_start: string;
    window_end: string;
    created: string;
    cleared: string | null;
    cleared_by: string | null;
  };

  // The admin login is not held by row security, so the tenant is named in the statement.
  const alertsOf = (tenantId: string, job: { trace?: string; purpose?: string }) =>
    admin.withTenant(tenantId, (q) =>
      q.query<AlertFacts>(
        `SELECT id, trace_id, purpose, spent_nanocents, limit_nanocents,
                to_char(window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS window_start,
                to_char(window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS window_end,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
                to_char(cleared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cleared,
                cleared_by
           FROM spend_alerts
          WHERE tenant_id = current_tenant_id()
            AND (CAST($1 AS uuid) IS NULL OR trace_id = CAST($1 AS uuid))
            AND (CAST($2 AS text) IS NULL OR (trace_id IS NULL AND purpose = $2))
          ORDER BY created_at`,
        [job.trace ?? null, job.purpose ?? null],
      ),
    );

  const adminMemberOf = async (tenantId: string) => {
    const [row] = await admin.withTenant(tenantId, (q) =>
      q.query<{ id: string }>(
        "SELECT id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
        [`sub-${tenantId}`],
      ),
    );
    return row.id;
  };

  const categoryOf = async (work: Promise<unknown>) => {
    const err = await failureOf(work);
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).category;
  };

  it("lets a job spend $9.99 in an hour, stops it at $10.01 with one alert, and keeps it stopped past the hour", async () => {
    const trace = randomUUID();
    const start = await spend();
    await reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(0) }));

    const over = jobCall({ traceId: trace, reserveNanocents: 2 * CENT, at: at(1) });
    expect(await categoryOf(reserve(app, session(C), over))).toBe("job_cap");
    // Nothing written to the ledger for the refused call, and its reservation never counted.
    expect(await callRow(C, over.callId)).toBeUndefined();
    expect(await spend()).toEqual({ ...start, reservedNanocents: start.reservedNanocents + 999 * CENT });

    const alerts = await alertsOf(C, { trace });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      trace_id: trace,
      purpose: "proof",
      spent_nanocents: 1_001 * CENT,
      limit_nanocents: JOB_CAP,
      window_start: at(-59),
      window_end: at(1),
      created: at(1),
      cleared: null,
      cleared_by: null,
    });

    // Asked again, the job is refused with no second alert, even a cent's call, even hours later.
    const again = jobCall({ traceId: trace, reserveNanocents: CENT, at: at(2) });
    expect(await categoryOf(reserve(app, session(C), again))).toBe("job_cap");
    const later = jobCall({ traceId: trace, reserveNanocents: CENT, at: at(180) });
    expect(await categoryOf(reserve(app, session(C), later))).toBe("job_cap");
    expect(await alertsOf(C, { trace })).toHaveLength(1);
    expect(await callRow(C, again.callId)).toBeUndefined();
    expect(await callRow(C, later.callId)).toBeUndefined();
  });

  it("lets only an admin of the carrier clear a stop, records who and when, and starts a fresh hour", async () => {
    const trace = randomUUID();
    await reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(0) }));
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 2 * CENT, at: at(1) }))),
    ).toBe("job_cap");
    const [alert] = await alertsOf(C, { trace });

    // Staff are refused, and another carrier's admin cannot see the alert at all.
    expect(await failureOf(app.withTenant(C, (q) => clearSpendAlert(q, staff(C), alert.id, at(2))))).toBeInstanceOf(
      ForbiddenError,
    );
    expect(await app.withTenant(B, (q) => clearSpendAlert(q, session(B), alert.id, at(2)))).toBe("not_found");
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: CENT, at: at(2) }))),
    ).toBe("job_cap");

    expect(await app.withTenant(C, (q) => clearSpendAlert(q, session(C), alert.id, at(3)))).toBe("cleared");
    expect(await app.withTenant(C, (q) => clearSpendAlert(q, session(C), alert.id, at(4)))).toBe("already_cleared");
    expect((await alertsOf(C, { trace }))[0]).toMatchObject({
      cleared: at(3),
      cleared_by: await adminMemberOf(C),
    });

    // $9.99 was reserved at T0, inside the hour, but the hour now starts at the clear.
    const fresh = jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(5) });
    await reserve(app, session(C), fresh);
    expect(await callRow(C, fresh.callId)).toMatchObject({ status: "reserved" });
    // And the job is watched again from there: past the allowance, it stops with a new alert.
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 2 * CENT, at: at(6) }))),
    ).toBe("job_cap");
    const both = await alertsOf(C, { trace });
    expect(both.map((a) => [a.cleared, a.window_start, a.spent_nanocents])).toEqual([
      [at(3), at(-59), 1_001 * CENT],
      [null, at(3), 1_001 * CENT],
    ]);
  });

  it("leaves another carrier's job with the same trace alone", async () => {
    const trace = randomUUID();
    await reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(0) }));
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 2 * CENT, at: at(1) }))),
    ).toBe("job_cap");

    const theirs = jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(2) });
    await reserve(app, session(B), theirs);
    expect(await callRow(B, theirs.callId)).toMatchObject({ status: "reserved" });
    expect(await alertsOf(B, { trace })).toEqual([]);
    const seenByB = await app.withTenant(B, (q) => readSpendAlerts(q, 100));
    expect(seenByB.filter((a) => a.traceId === trace)).toEqual([]);
  });

  it("groups calls with no trace by purpose, apart from traced calls and other purposes", async () => {
    const alpha = `watch_alpha_${tag}`;
    const beta = `watch_beta_${tag}`;
    await reserve(app, session(C), jobCall({ purpose: alpha, reserveNanocents: 999 * CENT, at: at(0) }));
    // Another purpose, and a traced call of the same purpose, are other jobs.
    await reserve(app, session(C), jobCall({ purpose: beta, reserveNanocents: 999 * CENT, at: at(0) }));
    await reserve(
      app,
      session(C),
      jobCall({ purpose: alpha, traceId: randomUUID(), reserveNanocents: 999 * CENT, at: at(0) }),
    );
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ purpose: alpha, reserveNanocents: 2 * CENT, at: at(1) }))),
    ).toBe("job_cap");
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ purpose: alpha, reserveNanocents: CENT, at: at(2) }))),
    ).toBe("job_cap");
    const alerts = await alertsOf(C, { purpose: alpha });
    expect(alerts.map((a) => [a.trace_id, a.purpose, a.spent_nanocents])).toEqual([[null, alpha, 1_001 * CENT]]);
    // beta still has its cent of room.
    await reserve(app, session(C), jobCall({ purpose: beta, reserveNanocents: CENT, at: at(2) }));
  });

  it("counts a settled call at its cost, never its reservation, and forgets calls older than the hour", async () => {
    const trace = randomUUID();
    await reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(-61) }));
    const recent = jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(0) });
    await reserve(app, session(C), recent);
    await settle(app, session(C), recent.callId, {
      kind: "answered",
      status: "ok",
      usage: USAGE,
      units: null,
      costNanocents: CENT,
      upstreamId: null,
      httpStatus: 200,
      durationMs: 1,
    });
    // One cent spent plus $9.99 reaches the allowance exactly, which is allowed.
    await reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 999 * CENT, at: at(1) }));
    expect(
      await categoryOf(reserve(app, session(C), jobCall({ traceId: trace, reserveNanocents: 1, at: at(2) }))),
    ).toBe("job_cap");
  });

  it("shows the carrier its alerts, open ones first with who cleared the rest, and its last day's spend", async () => {
    const alerts = await app.withTenant(C, (q) => readSpendAlerts(q, 100));
    expect(alerts.length).toBeGreaterThan(0);
    const firstCleared = alerts.findIndex((a) => a.clearedAt !== null);
    expect(firstCleared).toBeGreaterThan(0);
    expect(alerts.slice(firstCleared).every((a) => a.clearedAt !== null)).toBe(true);
    expect(alerts[firstCleared]).toMatchObject({ clearedByEmail: `ops@c-${tag}.example`, limitNanocents: JOB_CAP });

    const [expected] = await admin.withTenant(C, (q) =>
      q.query<{ spent: number; calls: number }>(
        `SELECT CAST(COALESCE(SUM(COALESCE(cost_nanocents, reserved_nanocents)), 0) AS bigint) AS spent,
                CAST(count(*) AS integer) AS calls
           FROM model_calls
          WHERE tenant_id = current_tenant_id() AND created_at > CAST($1 AS timestamptz) - interval '24 hours'`,
        [at(30)],
      ),
    );
    expect(expected.calls).toBeGreaterThan(0);
    expect(await app.withTenant(C, (q) => readDaySpend(q, at(30)))).toEqual({
      spentNanocents: expected.spent,
      calls: expected.calls,
    });
    // A day after the last of them, nothing is in the window.
    expect(await app.withTenant(C, (q) => readDaySpend(q, at(60 * 26)))).toEqual({ spentNanocents: 0, calls: 0 });
  });

  it("gives the app only reads, new alerts and the clear on spend_alerts", async () => {
    const facts = await admin.withoutTenant(async (q) => {
      const [grants] = await q.query<Record<string, boolean>>(
        `SELECT has_table_privilege('payday_app', 'public.spend_alerts', 'SELECT') AS sel,
                has_table_privilege('payday_app', 'public.spend_alerts', 'INSERT') AS ins,
                has_table_privilege('payday_app', 'public.spend_alerts', 'UPDATE') AS upd,
                has_table_privilege('payday_app', 'public.spend_alerts', 'DELETE') AS del`,
      );
      const updatable = await q.query<{ col: string }>(
        `SELECT a.attname AS col
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass('public.spend_alerts')
            AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('payday_app', a.attrelid, a.attnum, 'UPDATE')
          ORDER BY 1`,
      );
      return { grants, updatable: updatable.map((u) => u.col) };
    });
    expect(facts.grants).toEqual({ sel: true, ins: true, upd: false, del: false });
    expect(facts.updatable).toEqual(["cleared_at", "cleared_by"]);

    const deleted = await failureOf(app.withTenant(C, (q) => q.execute("DELETE FROM spend_alerts")));
    expect((deleted as { sqlState?: string }).sqlState).toBe("42501");
    const changed = await failureOf(
      app.withTenant(C, (q) => q.execute("UPDATE spend_alerts SET spent_nanocents = 0")),
    );
    expect((changed as { sqlState?: string }).sqlState).toBe("42501");
    const forged = await failureOf(
      app.withTenant(B, (q) =>
        q.execute(
          `INSERT INTO spend_alerts (tenant_id, purpose, window_start, window_end, spent_nanocents, limit_nanocents)
           VALUES (CAST($1 AS uuid), 'proof', now(), now(), 2, 1)`,
          [C],
        ),
      ),
    );
    expect((forged as { sqlState?: string }).sqlState).toBe("42501");
  });
});
