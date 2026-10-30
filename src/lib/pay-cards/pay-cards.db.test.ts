import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { checkPayCard, type CheckDeps } from "./check";
import {
  PAY_CARD_PURPOSE,
  expireStaleCards,
  finishCard,
  readCardFile,
  readDriverCard,
  readPeriodCards,
  readSettlementCards,
  readSettlementSpec,
  reserveCard,
} from "./read";
import type { CardRead } from "./schema";
import type { CardSpec } from "./spec";

// Pay cards against the real tables, as the app role, with a fake model. A card is kept, with its
// image, only when what the model read matches every figure the server works out from the
// settlement; any other answer keeps no image. Each settlement gets at most three attempts, the
// fourth refused by the table itself; a call turned down before any request, a full budget, or a
// second click while a card is still checking, uses none. The run's cap and the day's count stop the next card before its call. A finished card
// never changes, a stale reservation is closed, the lists never read an image, the card page's
// batched read works out the same card as the check, and another carrier sees none of it. Only
// this file's tenants are made, and they are removed after.

const savedLimits = { ...flags.payCardLimits };
const savedCards = flags.payCardsEnabled;
const savedAi = flags.aiEnabled;

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let thirdDriver: string;
const period0 = randomUUID();
const period1 = randomUUID();
const s0 = randomUUID(); // DRV-1, last week, paid
const s1 = randomUUID(); // DRV-1, this week, approved, per mile
const s2 = randomUUID(); // DRV-2, this week, approved, Spanish, percent, carried shortfall
const s3 = randomUUID(); // DRV-3, this week, still a draft
const sB = randomUUID(); // carrier B's own settlement

// A PNG header of the card's size: the check reads only the header; the fake model reads nothing.
function cardPng(seed = 0): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 1080);
  view.setUint32(20, 1350);
  bytes[40] = seed;
  return bytes;
}

// What a correct read of a card says: its figures, as printed, and nothing else.
function readOf(spec: CardSpec): CardRead {
  const other: number[] = [];
  if (spec.topChange) other.push(Math.abs(spec.topChange.deltaCents));
  if (spec.carriedCents !== 0) other.push(Math.abs(spec.carriedCents));
  return {
    net_pay_cents: spec.netCents,
    earned_cents: spec.grossCents,
    taken_out_cents: spec.deductionsCents,
    loads: spec.loads,
    miles: spec.miles,
    change_cents: spec.changeCents,
    first_name: spec.firstName,
    week_text: spec.weekText,
    other_amounts_cents: other,
    any_other_digits: false,
  };
}

async function specOf(f: Fixture, settlementId: string): Promise<CardSpec> {
  const read = await app.withTenant(f.tenantId, (q) => readSettlementSpec(q, settlementId));
  if (!read?.spec) throw new Error("no spec");
  return read.spec;
}

// The fake model: each call writes its own ledger row (a card names its call), at a cost a test
// may set, then answers what the test asked for.
type Answer = { text: string; status?: AiResult["status"] } | { throw: AiError };
let answers: Answer[] = [];
let sent: AiRequest[] = [];
let callCost = 0;

async function ledgerRow(tenantId: string, id: string, request: AiRequest) {
  await admin.withTenant(tenantId, (q) =>
    q.execute(
      `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
         reserved_nanocents, cost_nanocents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
         CAST($3 AS uuid), 'ok', 0, $4)`,
      [id, request.purpose, request.traceId ?? null, callCost],
    ),
  );
}

const fakeComplete = async (request: AiRequest, session: Session): Promise<AiResult> => {
  sent.push(request);
  const answer = answers.shift();
  if (!answer) throw new Error("no answer queued");
  if ("throw" in answer) throw answer.throw;
  const callId = randomUUID();
  await ledgerRow(session.tenantId, callId, request);
  return {
    callId,
    status: answer.status ?? "ok",
    text: answer.text,
    toolCalls: [],
    usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
    costNanocents: callCost,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
};

const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({ db: app, complete: fakeComplete, ...over });
const check = (settlementId: string, traceId = randomUUID(), png = cardPng(), d: CheckDeps = deps(), f: Fixture = A) =>
  checkPayCard(f.session, { settlementId, traceId, png }, d);

type StoredCard = {
  attempt: number;
  status: string;
  category: string | null;
  has_bytes: boolean;
  byte_length: number | null;
  content_hash: string | null;
  check_read: CardRead | null;
  check_call_id: string | null;
};

async function cardsOf(f: Fixture, settlementId: string): Promise<StoredCard[]> {
  return admin.withTenant(f.tenantId, (q) =>
    q.query<StoredCard>(
      `SELECT attempt, status, category, bytes IS NOT NULL AS has_bytes, byte_length, content_hash, check_read,
              CAST(check_call_id AS text) AS check_call_id
         FROM pay_cards WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid)
        ORDER BY attempt`,
      [settlementId],
    ),
  );
}

async function seed(f: Fixture, third: string) {
  const payConfig = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 0, 0, 0)`,
      [payConfig],
    );
    await q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
         per_mile_cents, active_from)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'DRV-3', 'Third', 'Driver', 'drv-3@example.test',
         'company', 'per_mile', 60, CAST('2026-01-01' AS date))`,
      [third],
    );
    await q.execute(
      `UPDATE drivers SET preferred_language = 'es', first_name = 'José'
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [f.otherDriverId],
    );
    await q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status) VALUES
         (CAST($1 AS uuid), current_tenant_id(), CAST('2026-10-12' AS date), CAST('2026-10-18' AS date), 'paid'),
         (CAST($2 AS uuid), current_tenant_id(), CAST('2026-10-19' AS date), CAST('2026-10-25' AS date), 'approved')`,
      [period0, period1],
    );
    type Line = [kind: string, amount: number, loadId: string | null, meta: object | null];
    const settlements: [string, string, string, string, number, number, number, number, Line[]][] = [
      [s0, period0, f.driverId, "paid", 130_000, 20_000, 110_000, 0, [
        ["load_pay", 130_000, "L-100", { loadedMiles: 1_600, emptyMiles: 100 }],
        ["fuel", -20_000, null, null],
      ]],
      [s1, period1, f.driverId, "approved", 141_200, 23_450, 117_750, 0, [
        ["load_pay", 80_000, "L-101", { loadedMiles: 1_000, emptyMiles: 100 }],
        ["load_pay", 61_200, "L-102", { loadedMiles: 800, emptyMiles: 50 }],
        ["fuel", -23_450, null, null],
      ]],
      [s2, period1, f.otherDriverId, "approved", 90_000, 95_000, 0, 5_000, [
        ["load_pay", 90_000, "L-103", { percentBps: 7_000 }],
        ["lease", -95_000, null, null],
      ]],
      [s3, period1, third, "draft", 50_000, 0, 50_000, 0, [["load_pay", 50_000, "L-104", { loadedMiles: 500, emptyMiles: 0 }]]],
    ];
    for (const [id, period, driver, status, gross, deductions, net, carried, lines] of settlements) {
      await q.execute(
        `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
           deductions_cents, net_cents, carry_forward_cents, paid_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5,
           $6, $7, $8, $9, CASE WHEN $5 = 'paid' THEN CAST('2026-10-23T15:00:00Z' AS timestamptz) END)`,
        [id, period, driver, payConfig, status, gross, deductions, net, carried],
      );
      let seq = 0;
      for (const [kind, amount, loadId, meta] of lines) {
        seq += 1;
        await q.execute(
          `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources, meta)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, CAST($7 AS jsonb),
             CAST($8 AS jsonb))`,
          [
            randomUUID(),
            id,
            seq,
            kind,
            loadId ?? kind,
            amount,
            JSON.stringify(loadId ? [{ table: "loads", id: loadId }] : []),
            meta ? JSON.stringify(meta) : null,
          ],
        );
      }
    }
  });
}

async function seedB(f: Fixture) {
  const payConfig = randomUUID();
  const period = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 0, 0, 0)`,
      [payConfig],
    );
    await q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-10-19' AS date), CAST('2026-10-25' AS date), 'approved')`,
      [period],
    );
    await q.execute(
      `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
         deductions_cents, net_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
         'approved', 70000, 0, 70000)`,
      [sB, period, f.driverId, payConfig],
    );
  });
}

const clearCards = (f: Fixture) =>
  admin.withTenant(f.tenantId, async (q) => {
    await q.execute("DELETE FROM pay_cards WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()");
  });

describe("pay cards", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `cards-a-${tag}`);
    B = await makeTenant(admin, `cards-b-${tag}`);
    thirdDriver = randomUUID();
    await seed(A, thirdDriver);
    await seedB(B);
  });

  beforeEach(async () => {
    flags.payCardsEnabled = true;
    flags.aiEnabled = true;
    flags.payCardLimits = { ...savedLimits };
    vi.stubEnv("DB_CLUSTER_ARN", "");
    vi.stubEnv("META_MODEL_SPARK", "muse-spark-1.3");
    vi.stubEnv("META_CONTRIBUTOR_MODE", undefined);
    vi.stubEnv("AI_SPEND_CAP_CENTS", "40000");
    vi.spyOn(console, "error").mockImplementation(() => {});
    answers = [];
    sent = [];
    callCost = 0;
    await clearCards(A);
    await clearCards(B);
  });

  afterEach(() => {
    flags.payCardsEnabled = savedCards;
    flags.aiEnabled = savedAi;
    flags.payCardLimits = { ...savedLimits };
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    flags.payCardsEnabled = savedCards;
    flags.aiEnabled = savedAi;
    flags.payCardLimits = { ...savedLimits };
    for (const f of [A, B]) {
      if (!f) continue;
      await clearCards(f);
      await dropTenant(admin, f);
    }
    await app?.close();
    await admin?.close();
  });

  it("keeps a card that reads back as the paystub, with its image, and never sends a figure to the model", async () => {
    const spec = await specOf(A, s1);
    answers = [{ text: JSON.stringify(readOf(spec)) }];
    const png = cardPng(7);
    const result = await check(s1, randomUUID(), png);
    expect(result).toMatchObject({ ok: true, attempt: 1, status: "checked", category: null });
    const [card] = await cardsOf(A, s1);
    expect(card).toMatchObject({
      attempt: 1,
      status: "checked",
      category: null,
      has_bytes: true,
      byte_length: png.length,
      content_hash: createHash("sha256").update(png).digest("hex"),
    });
    expect(card.check_read).toEqual(readOf(spec));
    expect(card.check_call_id).not.toBeNull();
    // The request carried the picture and the fixed prompt only: no figure, name or week.
    expect(sent).toHaveLength(1);
    const words = sent[0].messages.map((m) => m.content).join("\n");
    for (const value of ["1,177", "117750", "1,412", "Test", "Oct 19", s1]) expect(words).not.toContain(value);
    expect(sent[0]).toMatchObject({ purpose: PAY_CARD_PURPOSE, maxCostCents: savedLimits.checkMaxCostCents });

    // The image comes back only while the card still matches the paystub.
    if (!result.ok) throw new Error("not ok");
    const file = await app.withTenant(A.tenantId, (q) => readCardFile(q, result.cardId));
    expect(file?.bytes).toEqual(png);
    expect(file).toMatchObject({ periodStart: "2026-10-19", firstName: "Test" });
    expect(await app.withTenant(A.tenantId, (q) => readDriverCard(q, s1))).toEqual({ id: result.cardId, art: spec.art });
    // A second check of the same figures makes no call.
    expect(await check(s1)).toEqual({ ok: false, category: "already_checked" });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["net pay off by one cent", (r: CardRead) => ({ ...r, net_pay_cents: (r.net_pay_cents ?? 0) + 1 }), "number_mismatch"],
    ["earned missing", (r: CardRead) => ({ ...r, earned_cents: null }), "number_mismatch"],
    ["miles misread", (r: CardRead) => ({ ...r, miles: 1_590 }), "number_mismatch"],
    ["change sign flipped", (r: CardRead) => ({ ...r, change_cents: -(r.change_cents ?? 0) }), "number_mismatch"],
    ["an extra amount", (r: CardRead) => ({ ...r, other_amounts_cents: [...r.other_amounts_cents, 99] }), "number_mismatch"],
    ["an extra digit", (r: CardRead) => ({ ...r, any_other_digits: true }), "number_mismatch"],
    ["another name", (r: CardRead) => ({ ...r, first_name: "Tess" }), "text_mismatch"],
    ["a name cut short", (r: CardRead) => ({ ...r, first_name: "Tes" }), "text_mismatch"],
    ["another week", (r: CardRead) => ({ ...r, week_text: "Week of Oct 12 to Oct 18, 2026" }), "text_mismatch"],
  ] as const)("keeps no image when the read differs: %s", async (_name, change, category) => {
    const spec = await specOf(A, s1);
    answers = [{ text: JSON.stringify(change(readOf(spec))) }];
    expect(await check(s1)).toMatchObject({ ok: true, status: "mismatch", category });
    const [card] = await cardsOf(A, s1);
    expect(card).toMatchObject({ status: "mismatch", category, has_bytes: false, byte_length: null, content_hash: null });
    expect(card.check_read).not.toBeNull();
    expect(await app.withTenant(A.tenantId, (q) => readDriverCard(q, s1))).toBeNull();
  });

  it("reads a name and week in another letter case or spacing as the same", async () => {
    const spec = await specOf(A, s2);
    const read = readOf(spec);
    answers = [{ text: JSON.stringify({ ...read, first_name: " josé ", week_text: read.week_text?.toUpperCase().replace(/ /g, "  ") }) }];
    expect(await check(s2)).toMatchObject({ ok: true, status: "checked" });
  });

  it("uses the attempt, keeping no image, when the answer is off schema, cut off, timed out or failed", async () => {
    const spec = await specOf(A, s1);
    const cases: [Answer, string][] = [
      [{ text: "{\"net_pay_cents\": 1}" }, "off_schema"],
      [{ text: JSON.stringify(readOf(spec)), status: "incomplete" }, "off_schema"],
      [{ throw: new AiError("timeout") }, "timeout"],
    ];
    for (const [answer, category] of cases) answers.push(answer);
    for (const [, category] of cases) {
      expect(await check(s1)).toMatchObject({ ok: true, status: "unavailable", category });
    }
    expect((await cardsOf(A, s1)).map((c) => [c.attempt, c.status, c.category, c.has_bytes])).toEqual([
      [1, "unavailable", "off_schema", false],
      [2, "unavailable", "off_schema", false],
      [3, "unavailable", "timeout", false],
    ]);
    // Three attempts used: the fourth is refused with no call.
    expect(await check(s1)).toEqual({ ok: false, category: "attempts" });
    expect(sent).toHaveLength(3);
  });

  it("files a billing failure as budget and any other failure as unknown", async () => {
    answers = [{ throw: new AiError("billing", 402) }, { throw: new AiError("unavailable", 503) }];
    expect(await check(s1)).toMatchObject({ ok: true, status: "unavailable", category: "budget" });
    expect(await check(s1)).toMatchObject({ ok: true, status: "unavailable", category: "unknown" });
  });

  it.each([
    ["disabled", "ai_off"],
    ["not_configured", "ai_off"],
    ["too_expensive", "budget"],
    ["cap", "budget"],
    ["job_cap", "budget"],
  ] as const)("uses no attempt when the call is turned down before any request (%s)", async (category, refusal) => {
    answers = [{ throw: new AiError(category) }];
    expect(await check(s1)).toEqual({ ok: false, category: refusal });
    expect(await cardsOf(A, s1)).toEqual([]);
  });

  it("uses no attempt and makes no call when the spend cap has no room", async () => {
    // The counter reads as already at a one-cent cap: the check's own reserve has no room.
    const full = (spent: number): CheckDeps["db"] => ({
      withTenant: (tenantId, fn) =>
        app.withTenant(tenantId, (q) =>
          fn({
            query: (sql, params) =>
              sql.includes("FROM ops.ai_spend")
                ? Promise.resolve([
                    { spent_nanocents: spent, reserved_nanocents: 0, calls: 1, wonder_spent_nanocents: 0, wonder_reserved_nanocents: 0 },
                  ] as never)
                : q.query(sql, params),
            execute: (sql, params) => q.execute(sql, params),
          } as Queryable),
        ),
    });
    vi.stubEnv("AI_SPEND_CAP_CENTS", "1");
    for (let i = 0; i < 4; i++) {
      expect(await check(s1, randomUUID(), cardPng(), deps({ db: full(1_000_000_000) }))).toEqual({ ok: false, category: "budget" });
    }
    expect(sent).toHaveLength(0);
    expect(await cardsOf(A, s1)).toEqual([]);
    // With room again, the first attempt is still the first.
    vi.stubEnv("AI_SPEND_CAP_CENTS", "40000");
    answers = [{ text: JSON.stringify(readOf(await specOf(A, s1))) }];
    expect(await check(s1)).toMatchObject({ ok: true, attempt: 1, status: "checked" });
  });

  it("stops a run at its own cap, counting settled calls and cards still checking at their worst", async () => {
    const trace = randomUUID();
    const spec = await specOf(A, s1);
    // Each call settles at 38 cents: the next card's worst case would carry the run past 40.
    callCost = 38 * 1_000_000_000;
    answers = [{ text: JSON.stringify({ ...readOf(spec), loads: 9 }) }];
    expect(await check(s1, trace)).toMatchObject({ ok: true, status: "mismatch" });
    expect(await check(s2, trace)).toEqual({ ok: false, category: "batch_cap" });
    // Another run is not held by this one.
    callCost = 0;
    answers = [{ text: JSON.stringify(readOf(await specOf(A, s2))) }];
    expect(await check(s2, randomUUID())).toMatchObject({ ok: true, status: "checked" });

    // A card of the run still checking counts at its worst: two of them (on another paystub, which
    // they hold) hold 6 cents, and the next card's 3 would pass an 8-cent cap.
    const held = randomUUID();
    const spec2 = await specOf(A, s2);
    await app.withTenant(A.tenantId, async (q) => {
      for (let i = 0; i < 2; i++) {
        await reserveCard(q, { id: randomUUID(), settlementId: s2, art: spec2.art, spec: spec2, traceId: held, createdBy: A.memberId });
      }
    });
    flags.payCardLimits = { ...savedLimits, maxBatchCents: 8 };
    expect(await check(s1, held)).toEqual({ ok: false, category: "batch_cap" });
    expect(sent).toHaveLength(2);
  });

  it("stops at the day's count before any call", async () => {
    flags.payCardLimits = { ...savedLimits, cardsPerTenantPerDay: 1 };
    answers = [{ text: JSON.stringify({ ...readOf(await specOf(A, s1)), loads: 9 }) }];
    expect(await check(s1)).toMatchObject({ ok: true, status: "mismatch" });
    expect(await check(s2)).toEqual({ ok: false, category: "day_cap" });
    expect(sent).toHaveLength(1);
  });

  it("refuses with no call: switched off, a wrong picture, a draft, another carrier's paystub, a stranger", async () => {
    flags.payCardsEnabled = false;
    expect(await check(s1)).toEqual({ ok: false, category: "cards_off" });
    flags.payCardsEnabled = true;
    flags.aiEnabled = false;
    expect(await check(s1)).toEqual({ ok: false, category: "ai_off" });
    flags.aiEnabled = true;
    const wide = cardPng();
    new DataView(wide.buffer).setUint32(16, 1079);
    expect(await check(s1, randomUUID(), wide)).toEqual({ ok: false, category: "bad_image" });
    expect(await check(s3)).toEqual({ ok: false, category: "not_approved" });
    expect(await check(sB)).toEqual({ ok: false, category: "not_found" });
    await expect(check(s1, randomUUID(), cardPng(), deps(), { ...A, session: { ...A.session, sub: "sub-stranger" } })).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(await cardsOf(A, s1)).toEqual([]);
  });

  it("reads a lost finish back, and calls a row still checking unknown", async () => {
    const spec = await specOf(A, s1);
    // The finish (the second transaction) lands, then its reply is lost: the read-back finds the
    // card checked.
    let calls = 0;
    const lossy: CheckDeps["db"] = {
      withTenant: async (tenantId, fn) => {
        const out = await app.withTenant(tenantId, fn);
        calls += 1;
        if (calls === 2) throw new Error("reply lost");
        return out;
      },
    };
    answers = [{ text: JSON.stringify(readOf(spec)) }];
    expect(await check(s1, randomUUID(), cardPng(), deps({ db: lossy }))).toMatchObject({ ok: true, attempt: 1, status: "checked" });
    expect(calls).toBe(3);

    // The finish never lands and the read-back fails too: unknown, and the row waits for its lease.
    await clearCards(A);
    calls = 0;
    const down: CheckDeps["db"] = {
      withTenant: async (tenantId, fn) => {
        calls += 1;
        if (calls >= 2) throw new Error("connection reset");
        return app.withTenant(tenantId, fn);
      },
    };
    answers = [{ text: JSON.stringify(readOf(spec)) }];
    expect(await check(s1, randomUUID(), cardPng(), deps({ db: down }))).toEqual({ ok: false, category: "unknown" });
    expect((await cardsOf(A, s1)).map((c) => [c.status, c.has_bytes])).toEqual([["checking", false]]);
  });

  it("refuses a second check while a card for the paystub is still checking, using no attempt and making no call", async () => {
    const spec = await specOf(A, s1);
    // The first check waits inside its model call; a second click comes in meanwhile.
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inCall = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: CheckDeps["complete"] = async (request, session) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fakeComplete(request, session);
    };
    answers = [{ text: JSON.stringify(readOf(spec)) }, { text: JSON.stringify(readOf(spec)) }];
    const first = check(s1, randomUUID(), cardPng(), deps({ complete: slow }));
    await inCall;
    expect(await check(s1)).toEqual({ ok: false, category: "busy" });
    expect(sent).toHaveLength(0);
    expect((await cardsOf(A, s1)).map((c) => [c.attempt, c.status])).toEqual([[1, "checking"]]);
    release();
    expect(await first).toMatchObject({ ok: true, attempt: 1, status: "checked" });
    expect(sent).toHaveLength(1);
    expect((await cardsOf(A, s1)).map((c) => [c.attempt, c.status])).toEqual([[1, "checked"]]);
  });

  it("closes a card left checking past its lease as could not check, and that attempt stays used", async () => {
    const spec = await specOf(A, s1);
    const id = randomUUID();
    await app.withTenant(A.tenantId, (q) =>
      reserveCard(q, { id, settlementId: s1, art: spec.art, spec, traceId: randomUUID(), createdBy: A.memberId }),
    );
    // Fresh: shown checking, and not closed.
    expect((await app.withTenant(A.tenantId, (q) => readSettlementCards(q, s1)))[0]).toMatchObject({ status: "checking" });
    expect(await app.withTenant(A.tenantId, (q) => expireStaleCards(q, s1))).toBe(0);
    await admin.withTenant(A.tenantId, async (q) => {
      await q.execute("ALTER TABLE pay_cards DISABLE TRIGGER pay_cards_guard");
      try {
        await q.execute(
          "UPDATE pay_cards SET created_at = now() - interval '2 minutes' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [id],
        );
      } finally {
        await q.execute("ALTER TABLE pay_cards ENABLE TRIGGER pay_cards_guard");
      }
    });
    // Past the lease: shown as could not check before anyone closes it.
    expect((await app.withTenant(A.tenantId, (q) => readSettlementCards(q, s1)))[0]).toMatchObject({
      status: "unavailable",
      category: "unknown",
    });
    answers = [{ text: JSON.stringify(readOf(spec)) }];
    expect(await check(s1)).toMatchObject({ ok: true, attempt: 2, status: "checked" });
    expect((await cardsOf(A, s1)).map((c) => [c.attempt, c.status, c.category])).toEqual([
      [1, "unavailable", "unknown"],
      [2, "checked", null],
    ]);
  });

  it("refuses a fourth attempt, a finished card's change and an image on any card but a checked one, in the table itself", async () => {
    const spec = await specOf(A, s1);
    const trace = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const attempts = await app.withTenant(A.tenantId, async (q) => {
      const out: (number | null)[] = [];
      for (const id of ids) out.push(await reserveCard(q, { id, settlementId: s1, art: spec.art, spec, traceId: trace, createdBy: A.memberId }));
      return out;
    });
    expect(attempts).toEqual([1, 2, 3, null]);
    const insert = (attempt: number, status = "checking") =>
      app.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO pay_cards (id, tenant_id, settlement_id, attempt, status, art, spec, trace_id, created_by)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, CAST($6 AS jsonb),
             CAST($7 AS uuid), CAST($8 AS uuid))`,
          [randomUUID(), s1, attempt, status, spec.art, JSON.stringify(spec), trace, A.memberId],
        ),
      );
    expect(await sqlStateOf(insert(4))).toBe("23514");
    expect(await sqlStateOf(insert(3))).toBe("23505");
    // A new row is only ever a bare reservation.
    await clearCards(A);
    expect(await sqlStateOf(insert(1, "checked"))).toBe("23514");

    await app.withTenant(A.tenantId, (q) =>
      reserveCard(q, { id: ids[0], settlementId: s1, art: spec.art, spec, traceId: trace, createdBy: A.memberId }),
    );
    const update = (sql: string, params: unknown[] = []) =>
      app.withTenant(A.tenantId, (q) =>
        q.execute(`UPDATE pay_cards SET ${sql} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`, [ids[0], ...params] as never),
      );
    // An image on a card that did not pass, or a pass with no image, is refused.
    expect(
      await sqlStateOf(update("status = 'mismatch', category = 'number_mismatch', checked_at = now(), mime = 'image/png', byte_length = 2, bytes = '\\x0102', content_hash = repeat('a', 64)")),
    ).toBe("23514");
    expect(await sqlStateOf(update("status = 'checked', checked_at = now()"))).toBe("23514");
    // The app role cannot change the figures at all; the guard refuses them for every role.
    expect(await sqlStateOf(update("spec = CAST('{}' AS jsonb)"))).toBe("42501");
    expect(
      await sqlStateOf(
        admin.withTenant(A.tenantId, (q) =>
          q.execute("UPDATE pay_cards SET spec = CAST('{}' AS jsonb) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [ids[0]]),
        ),
      ),
    ).toBe("23514");
    // Finished once; a finished card never changes, not even to another outcome.
    const finish = (status: "mismatch" | "unavailable") =>
      app.withTenant(A.tenantId, (q) =>
        finishCard(q, ids[0], status === "mismatch"
          ? { status, category: "number_mismatch", read: readOf(spec), callId: null as never }
          : { status, category: "unknown", callId: null }),
      );
    expect(await finish("unavailable")).toBe(true);
    expect(await finish("unavailable")).toBe(false);
    expect(await sqlStateOf(update("category = 'timeout'"))).toBe("23514");
  });

  it("works out on the cards page the same card the check works out, and never reads an image for a list", async () => {
    const sqls: string[] = [];
    const page = await app.withTenant(A.tenantId, (q) => {
      const spy: Queryable = {
        query: (sql, params) => {
          sqls.push(sql);
          return q.query(sql, params);
        },
        execute: (sql, params) => {
          sqls.push(sql);
          return q.execute(sql, params);
        },
      };
      return readPeriodCards(spy, period1);
    });
    if (!page) throw new Error("no page");
    expect(page.period).toEqual({ id: period1, periodStart: "2026-10-19", periodEnd: "2026-10-25" });
    // The draft is left out; the rows are in driver code order.
    expect(page.rows.map((r) => r.settlementId)).toEqual([s1, s2]);
    for (const row of page.rows) expect(row.spec).toEqual(await specOf(A, row.settlementId));
    expect(page.rows.map((r) => [r.pill, r.attemptsUsed, r.checkedId])).toEqual([
      ["none", 0, null],
      ["none", 0, null],
    ]);
    // The Spanish card with a carried shortfall and no earlier week.
    expect(page.rows[1].spec).toMatchObject({
      language: "es",
      firstName: "José",
      netCents: 0,
      carriedCents: 5_000,
      changeCents: null,
      miles: null,
      loads: 1,
    });
    expect(page.rows[0].spec).toMatchObject({ changeCents: 7_750, miles: 1_950, topChange: { kind: "load_pay", deltaCents: 11_200 } });

    answers = [{ text: JSON.stringify(readOf(page.rows[0].spec)) }, { text: JSON.stringify({ ...readOf(page.rows[1].spec), loads: 3 }) }];
    const first = await check(s1);
    await check(s2);
    const again = await app.withTenant(A.tenantId, (q) => {
      const spy: Queryable = {
        query: (sql, params) => {
          sqls.push(sql);
          return q.query(sql, params);
        },
        execute: (sql, params) => {
          sqls.push(sql);
          return q.execute(sql, params);
        },
      };
      return readPeriodCards(spy, period1);
    });
    expect(again?.rows.map((r) => [r.pill, r.reason, r.attemptsUsed, r.checkedId])).toEqual([
      ["checked", null, 1, first.ok ? first.cardId : "x"],
      ["mismatch", "number_mismatch", 1, null],
    ]);
    await app.withTenant(A.tenantId, async (q) => {
      const spy: Queryable = {
        query: (sql, params) => {
          sqls.push(sql);
          return q.query(sql, params);
        },
        execute: (sql, params) => {
          sqls.push(sql);
          return q.execute(sql, params);
        },
      };
      await readDriverCard(spy, s1);
      await readSettlementCards(spy, s1);
    });
    expect(sqls.length).toBeGreaterThan(5);
    for (const sql of sqls) expect(sql).not.toMatch(/\bbytes\b/);
  });

  it("calls a checked card out of date, and serves no image, once the paystub changes", async () => {
    const spec = await specOf(A, s1);
    answers = [{ text: JSON.stringify(readOf(spec)) }];
    const result = await check(s1);
    if (!result.ok) throw new Error("not ok");
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE settlements SET status = 'paid', paid_at = now() WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [s1],
      ),
    );
    try {
      const page = await app.withTenant(A.tenantId, (q) => readPeriodCards(q, period1));
      expect(page?.rows[0]).toMatchObject({ pill: "stale", checkedId: null, attemptsUsed: 1 });
      expect(await app.withTenant(A.tenantId, (q) => readCardFile(q, result.cardId))).toBeNull();
      expect(await app.withTenant(A.tenantId, (q) => readDriverCard(q, s1))).toBeNull();
      // The new figures can be checked again, on the next attempt.
      answers = [{ text: JSON.stringify(readOf(await specOf(A, s1))) }];
      expect(await check(s1)).toMatchObject({ ok: true, attempt: 2, status: "checked" });
    } finally {
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          "UPDATE settlements SET status = 'approved', paid_at = NULL WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [s1],
        ),
      );
    }
  });

  it("shows another carrier none of it", async () => {
    answers = [{ text: JSON.stringify(readOf(await specOf(A, s1))) }];
    const result = await check(s1);
    if (!result.ok) throw new Error("not ok");
    const seen = await app.withTenant(B.tenantId, async (q) => ({
      rows: await q.query<{ n: number | string }>("SELECT count(*) AS n FROM pay_cards"),
      file: await readCardFile(q, result.cardId),
      page: await readPeriodCards(q, period1),
      driver: await readDriverCard(q, s1),
    }));
    expect(Number(seen.rows[0].n)).toBe(0);
    expect(seen).toMatchObject({ file: null, page: null, driver: null });
    // Nor can it write a card naming carrier A.
    expect(
      await sqlStateOf(
        app.withTenant(B.tenantId, (q) =>
          q.execute(
            `INSERT INTO pay_cards (id, tenant_id, settlement_id, attempt, status, art, spec, trace_id, created_by)
             VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), 2, 'checking', 'art-01', CAST('{}' AS jsonb),
               CAST($4 AS uuid), CAST($5 AS uuid))`,
            [randomUUID(), A.tenantId, s1, randomUUID(), A.memberId],
          ),
        ),
      ),
    ).toBe("42501");
  });
});
