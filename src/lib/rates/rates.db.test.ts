import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { AiResult, AiWebAnswer } from "../ai";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { lookupRate, type LookupComplete } from "./lookup";
import { pinSuggestion, pinTyped } from "./pin";
import { lookupsInDay, readPinnedRates, readRatesPage } from "./read";

// Pinned rates against the real database, as the app's role, with a fake model (0053). A carrier
// sees only its own rates; one live pin per kind and state, and a new pin retires the one before
// it in the same transaction; a pinned rate and its source never change (the guard trigger, and
// the app role may update only the pin and retire columns); only an admin pins; a suggestion
// pinned twice is "changed", and so is one a newer lookup or a later pin has passed; a pin never
// starts after today; the day's lookups count from the model ledger, failed ones included;
// and the agent's read returns pins only. Only this file's tenants are made, and they are removed
// after.

const saved = { ...flags, ratesLimits: { ...flags.ratesLimits } };
// 15:00 UTC is 10:00 in Chicago, the fixtures' zone: today is Oct 27.
const NOW = new Date("2026-10-27T15:00:00Z");
const clock = () => NOW;
const DIESEL = "https://rates.example/diesel/weekly";

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let adminA: Session;
let adminAId: string;

const FOUND: AiWebAnswer = {
  answerText: `3.712 dollars a gallon for the week of October 26, 2026, from ${DIESEL}`,
  citations: [],
  searchResults: [{ url: DIESEL, title: "Diesel averaged $3.712 for the week of Oct. 26, 2026", snippet: "" }],
  searchCalls: 1,
};

// The model ledger row complete() writes before it answers, at a chosen time.
async function ledgerRow(tenantId: string, at: Date, purpose = "rate_lookup"): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(tenantId, (q) =>
    q.execute(
      `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, status, reserved_nanocents,
         cost_nanocents, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2, 'ok', 0, 0,
         CAST($3 AS timestamptz))`,
      [id, purpose, at.toISOString()],
    ),
  );
  return id;
}

const model =
  (web: AiWebAnswer | undefined): LookupComplete =>
  async (_target, _request, session) => ({
    callId: await ledgerRow(session.tenantId, new Date(NOW.getTime() - 60_000)),
    status: "ok",
    text: web?.answerText ?? "",
    toolCalls: [],
    usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
    costNanocents: 0,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    ...(web ? { web } : {}),
  } satisfies AiResult);

const deps = (web: AiWebAnswer | undefined = FOUND) => ({ db: app, clock, complete: model(web) });

type Raw = { id: string; status: string; value_mcents: string | null; effective_from: string | null; retired: boolean };
async function ratesOf(f: Fixture): Promise<Raw[]> {
  return admin.withTenant(f.tenantId, (q) =>
    q.query<Raw>(
      `SELECT CAST(id AS text) AS id, status, CAST(value_mcents AS text) AS value_mcents,
              CAST(effective_from AS text) AS effective_from, retired_at IS NOT NULL AS retired
         FROM pinned_rates WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );
}

async function clear(f: Fixture) {
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute("DELETE FROM pinned_rates WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()");
  });
}

// A row written straight in as the admin login, for the constraint and trigger checks.
function insertPin(q: Queryable, over: { kind?: string; state?: string | null; value?: number; from?: string } = {}) {
  const id = randomUUID();
  return q
    .execute(
      `INSERT INTO pinned_rates (id, tenant_id, kind, state, status, value_mcents, source, source_url, effective_from,
         created_by, pinned_by, pinned_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, 'pinned', $4, 'typed', $5, CAST($6 AS date),
         CAST($7 AS uuid), CAST($7 AS uuid), now())`,
      [id, over.kind ?? "diesel_index", over.state ?? null, over.value ?? 365_700, DIESEL, over.from ?? "2026-10-19", adminAId],
    )
    .then(() => id);
}

describe("pinned rates (database)", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `rates-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `rates-${randomUUID().slice(0, 8)}`);
    const sub = `sub-admin-${A.tenantId}`;
    adminAId = await admin.withTenant(A.tenantId, async (q) => {
      const rows = await q.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, 'admin@rates.example', 'admin') RETURNING CAST(id AS text) AS id`,
        [sub],
      );
      return rows[0].id;
    });
    adminA = { sub, email: "admin@rates.example", tenantId: A.tenantId };
  });

  beforeEach(() => {
    Object.assign(flags, saved, { ratesLimits: { ...saved.ratesLimits }, groundedRatesEnabled: true });
  });

  afterEach(async () => {
    if (A) await clear(A);
    if (B) await clear(B);
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await admin?.close();
    await app?.close();
  });

  it("keeps a lookup as a suggestion an admin pins; staff cannot pin; pinning twice is changed", async () => {
    const looked = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!looked.ok) throw new Error(`lookup ${JSON.stringify(looked)}`);
    expect(looked.status).toBe("suggested");
    expect(await ratesOf(A)).toEqual([
      { id: looked.id, status: "suggested", value_mcents: "371200", effective_from: null, retired: false },
    ]);

    expect(await pinSuggestion(A.session, { id: looked.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "forbidden",
    });
    expect(await pinSuggestion(adminA, { id: looked.id, effectiveFrom: "2025-10-01" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "bad_request",
    });
    expect(await pinSuggestion(adminA, { id: looked.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: true,
      id: looked.id,
      already: false,
    });
    expect(await pinSuggestion(adminA, { id: looked.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "changed",
    });
    // Another carrier's rate is not found, even by its own admin login's id.
    expect(await pinSuggestion(adminA, { id: randomUUID(), effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "not_found",
    });

    const read = await app.withTenant(A.tenantId, (q) => readPinnedRates(q, "diesel_index", null, "2026-10-27", "America/Chicago"));
    expect(read).toMatchObject([{ id: looked.id, perGallon: "$3.712", valueMcents: 371_200, effectiveFrom: "2026-10-26", typed: false }]);
    expect(
      await app.withTenant(A.tenantId, (q) => readPinnedRates(q, "diesel_index", null, "2026-10-25", "America/Chicago")),
    ).toEqual([]);
  });

  it("never pins from a later day, so the live pin keeps today covered", async () => {
    const typed = { kind: "diesel_index", rate: "3.657", sourceUrl: DIESEL, effectiveFrom: "2026-10-20" };
    const live = await pinTyped(adminA, typed, { db: app, clock });
    if (!live.ok) throw new Error("typed pin failed");
    expect(await pinTyped(adminA, { ...typed, rate: "3.712", effectiveFrom: "2026-10-28" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "bad_request",
    });
    const looked = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!looked.ok) throw new Error("lookup failed");
    expect(await pinSuggestion(adminA, { id: looked.id, effectiveFrom: "2026-10-28" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "bad_request",
    });
    // The refused starts retired nothing: today still reads the pin from Oct 20.
    const today = await app.withTenant(A.tenantId, (q) => readPinnedRates(q, "diesel_index", null, "2026-10-27", "America/Chicago"));
    expect(today).toMatchObject([{ id: live.id, perGallon: "$3.657", effectiveFrom: "2026-10-20" }]);
    // Today itself is a day a pin may start.
    expect(await pinSuggestion(adminA, { id: looked.id, effectiveFrom: "2026-10-27" }, { db: app, clock })).toEqual({
      ok: true,
      id: looked.id,
      already: false,
    });
  });

  it("refuses a suggestion the page no longer shows: a newer lookup, or a pin made since", async () => {
    const older = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    const newer = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!older.ok || !newer.ok) throw new Error("lookup failed");
    expect(await pinSuggestion(adminA, { id: older.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "changed",
    });
    const typed = await pinTyped(adminA, { kind: "diesel_index", rate: "3.700", sourceUrl: DIESEL, effectiveFrom: "2026-10-26" }, { db: app, clock });
    if (!typed.ok) throw new Error("typed pin failed");
    expect(await pinSuggestion(adminA, { id: newer.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "changed",
    });
    // A lookup after that pin is the one the page shows, and it pins.
    const fresh = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!fresh.ok) throw new Error("lookup failed");
    const page = await app.withTenant(A.tenantId, (q) => readRatesPage(q, A.session.sub, NOW));
    expect(page?.diesel.suggestion?.id).toBe(fresh.id);
    expect(await pinSuggestion(adminA, { id: fresh.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: true,
      id: fresh.id,
      already: false,
    });
    expect((await ratesOf(A)).filter((r) => r.status === "pinned").map((r) => [r.id, r.retired])).toEqual([
      [typed.id, true],
      [fresh.id, false],
    ]);
  });

  it("never pins an unconfirmed lookup, and never reads a suggestion as a rate", async () => {
    const unconfirmed = await lookupRate(A.session, { kind: "diesel_index" }, deps({ ...FOUND, answerText: `3.719, from ${DIESEL}` }));
    if (!unconfirmed.ok) throw new Error("lookup failed");
    expect(unconfirmed.status).toBe("unconfirmed");
    expect(await pinSuggestion(adminA, { id: unconfirmed.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "changed",
    });
    await lookupRate(A.session, { kind: "diesel_index" }, deps());
    expect(
      await app.withTenant(A.tenantId, (q) => readPinnedRates(q, "diesel_index", null, "2026-10-27", "America/Chicago")),
    ).toEqual([]);
  });

  it("retires the live pin when a new one lands, in one transaction, and dedupes a typed pin", async () => {
    const typed = { kind: "ifta_rate", state: "IN", rate: "0.61", sourceUrl: "https://rates.example/tax", effectiveFrom: "2026-10-01" };
    const first = await pinTyped(adminA, typed, { db: app, clock });
    if (!first.ok) throw new Error("typed pin failed");
    expect(await pinTyped(adminA, typed, { db: app, clock })).toEqual({ ok: true, id: first.id, already: true });
    const second = await pinTyped(adminA, { ...typed, rate: "0.6200" }, { db: app, clock });
    if (!second.ok) throw new Error("second pin failed");
    expect(second.already).toBe(false);
    expect((await ratesOf(A)).map((r) => [r.id, r.value_mcents, r.retired])).toEqual([
      [first.id, "61000", true],
      [second.id, "62000", false],
    ]);
    const live = await app.withTenant(A.tenantId, (q) => readPinnedRates(q, "ifta_rate", null, "2026-10-27", "America/Chicago"));
    expect(live).toMatchObject([{ id: second.id, state: "IN", perGallon: "$0.6200", typed: true }]);

    // Staff cannot type one either; a value outside the kind's range or a non-https page never reaches the table.
    expect(await pinTyped(A.session, typed, { db: app, clock })).toEqual({ ok: false, refused: "forbidden" });
    expect(await pinTyped(adminA, { ...typed, rate: "3.657" }, { db: app, clock })).toEqual({ ok: false, refused: "bad_request" });
    expect(await pinTyped(adminA, { ...typed, sourceUrl: "http://rates.example/tax" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "bad_request",
    });
  });

  it("holds one live pin per kind and state, and lets a pin change only by retiring it once", async () => {
    // Each write in its own transaction: a refused statement ends the one it ran in.
    const asAdmin = <T>(fn: (q: Queryable) => Promise<T>) => admin.withTenant(A.tenantId, fn);
    const pin = await asAdmin((q) => insertPin(q));
    expect(await sqlStateOf(asAdmin((q) => insertPin(q)))).toBe("23505");
    // Another state, or the other kind, is its own slot.
    await asAdmin((q) => insertPin(q, { kind: "ifta_rate", state: "IL", value: 45_400 }));
    const update = (set: string) =>
      sqlStateOf(
        asAdmin((q) =>
          q.execute(`UPDATE pinned_rates SET ${set} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`, [pin]),
        ),
      );
    expect(await update("value_mcents = 1")).toBe("23514");
    expect(await update("source_url = 'https://rates.example/other'")).toBe("23514");
    expect(await update("effective_from = CAST('2026-10-01' AS date)")).toBe("23514");
    expect(await update("retired_at = now()")).toBe("no error");
    expect(await update("retired_at = NULL")).toBe("23514");
    expect(await update("retired_at = now() + interval '1 day'")).toBe("23514");
    // With that one retired, a new live pin fits.
    expect(await sqlStateOf(asAdmin((q) => insertPin(q, { value: 371_200, from: "2026-10-26" })))).toBe("no error");
  });

  it("lets the app role write only the pin and retire columns, and never a suggestion's figure", async () => {
    const looked = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!looked.ok) throw new Error("lookup failed");
    const update = (set: string) =>
      sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute(`UPDATE pinned_rates SET ${set} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`, [looked.id]),
        ),
      );
    expect(await update("value_mcents = 1")).toBe("42501");
    expect(await update("source_url = 'https://rates.example/other'")).toBe("42501");
    expect(await update("quote = 'x'")).toBe("42501");
    // A suggestion becomes only a live pin, through the columns the app may write: never pinned and
    // retired in one update.
    expect(await update("status = 'unconfirmed'")).toBe("23514");
    expect(
      await update(
        `status = 'pinned', pinned_by = CAST('${adminAId}' AS uuid), pinned_at = now(),
         effective_from = CAST('2026-10-26' AS date), retired_at = now()`,
      ),
    ).toBe("23514");
    expect((await ratesOf(A)).map((r) => [r.status, r.retired])).toEqual([["suggested", false]]);
  });

  it("keeps each carrier's rates to itself", async () => {
    const looked = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!looked.ok) throw new Error("lookup failed");
    const seen = await app.withTenant(B.tenantId, (q) => q.query("SELECT id FROM pinned_rates"));
    expect(seen).toEqual([]);
    const moved = await app.withTenant(B.tenantId, (q) =>
      q.execute("UPDATE pinned_rates SET retired_at = now() WHERE id = CAST($1 AS uuid)", [looked.id]),
    );
    expect(moved).toBe(0);
    // Written under B's session with A's tenant id: refused by the policy.
    const smuggled = app.withTenant(B.tenantId, (q) =>
      q.execute(
        `INSERT INTO pinned_rates (id, tenant_id, kind, status, value_mcents, source, source_url, effective_from,
           created_by, pinned_by, pinned_at)
         VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'diesel_index', 'pinned', 1, 'typed', $3, CAST('2026-10-26' AS date),
           CAST($4 AS uuid), CAST($4 AS uuid), now())`,
        [randomUUID(), A.tenantId, DIESEL, A.memberId],
      ),
    );
    expect(await sqlStateOf(smuggled)).toBe("42501");
    expect(await pinSuggestion({ ...adminA, tenantId: B.tenantId }, { id: looked.id, effectiveFrom: "2026-10-26" }, { db: app, clock })).toEqual({
      ok: false,
      refused: "forbidden",
    });
  });

  it("counts the day's lookups from the model ledger, failed ones included, and stops at the limit", async () => {
    await ledgerRow(A.tenantId, new Date(NOW.getTime() - 3_600_000));
    await ledgerRow(A.tenantId, new Date(NOW.getTime() - 86_000_000));
    // Older than a day, another purpose, and another carrier: not counted.
    await ledgerRow(A.tenantId, new Date(NOW.getTime() - 86_500_000));
    await ledgerRow(A.tenantId, new Date(NOW.getTime() - 60_000), "operator");
    await ledgerRow(B.tenantId, new Date(NOW.getTime() - 60_000));
    expect(await app.withTenant(A.tenantId, (q) => lookupsInDay(q, NOW))).toBe(2);
    expect(await app.withTenant(B.tenantId, (q) => lookupsInDay(q, NOW))).toBe(1);

    flags.ratesLimits.lookupsPerTenantPerDay = 3;
    // A lookup whose answer had no figure still used one.
    expect(await lookupRate(A.session, { kind: "diesel_index" }, deps({ ...FOUND, searchResults: [] }))).toEqual({
      ok: false,
      failed: "no_source",
    });
    let called = false;
    const out = await lookupRate(A.session, { kind: "diesel_index" }, {
      db: app,
      clock,
      complete: async (...args) => {
        called = true;
        return model(FOUND)(...args);
      },
    });
    expect(out).toEqual({ ok: false, refused: "limit" });
    expect(called).toBe(false);
    expect(await ratesOf(A)).toEqual([]);
  });

  it("shows the page: pins, newer suggestions, the lookups left and who may pin", async () => {
    const typed = await pinTyped(
      adminA,
      { kind: "ifta_rate", state: "IL", rate: "0.4540", sourceUrl: "https://rates.example/tax", effectiveFrom: "2026-10-01" },
      { db: app, clock },
    );
    if (!typed.ok) throw new Error("typed pin failed");
    const looked = await lookupRate(A.session, { kind: "diesel_index" }, deps());
    if (!looked.ok) throw new Error("lookup failed");

    const staff = await app.withTenant(A.tenantId, (q) => readRatesPage(q, A.session.sub, NOW));
    expect(staff).toMatchObject({
      today: "2026-10-27",
      canPin: false,
      lookupsLeft: 19,
      diesel: { pinned: null, suggestion: { id: looked.id, status: "suggested", perGallon: "$3.712", byYou: true } },
      states: [{ code: "IL", name: "Illinois", pinned: { id: typed.id, typed: true, byYou: false }, suggestion: null }],
    });
    const boss = await app.withTenant(A.tenantId, (q) => readRatesPage(q, adminA.sub, NOW));
    expect(boss?.canPin).toBe(true);
    expect(boss?.states[0].pinned?.byYou).toBe(true);
    // Not a member here: no page.
    expect(await app.withTenant(B.tenantId, (q) => readRatesPage(q, A.session.sub, NOW))).toBeNull();
  });
});
