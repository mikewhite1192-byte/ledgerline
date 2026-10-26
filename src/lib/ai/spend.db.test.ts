import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { ForbiddenError } from "../tenant/context";
import { readRecentCalls, readSpend, reserve, settle, type Reservation, type Spend } from "./spend";
import { AiError } from "./types";

// The spend ledger as the app's own role sees it: reservations race on the counter's row lock,
// a settle happens once, refused calls release their reservation, unknown ones keep it, and a
// tenant sees only its own calls. The counter is global, so this file puts it back as it found it.

const A = randomUUID();
const B = randomUUID();
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
    for (const id of [A, B]) {
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

  it("keeps an unknown call's reservation counted against the cap", async () => {
    const start = await spend();
    const r = reservation();
    await reserve(app, session(A), r);
    expect(
      await settle(app, session(A), r.callId, {
        kind: "unknown",
        category: "network",
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
      failure: "network",
      cost_nanocents: null,
      http_status: null,
    });
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
                has_table_privilege('payday_app', 'ops.ai_spend', 'DELETE') AS spend_del`,
      );
      return { table, policies: policies.map((p) => p.policyname), grants };
    });
    expect(facts.table).toEqual({ rls: true, forced: true, old: null });
    expect(facts.policies).toEqual(["tenant_isolation"]);
    expect(facts.grants).toEqual({
      sel: true,
      ins: true,
      upd: true,
      del: false,
      spend_ins: false,
      spend_del: false,
    });
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
});
