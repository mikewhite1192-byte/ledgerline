import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { AiResult } from "../ai";
import { acknowledgeTold, readShowingAsks } from "../asks/store";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { splitSql } from "../db/sql-split";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable, TenantDb } from "../db/types";
import { deskHandlers, type Handler, type Handlers } from "../desk/handlers";
import { DESK_SOURCES } from "../desk/keys";
import type { OpenEvent } from "../desk/log";
import { wakeDesk } from "../desk/loop";
import { requestIdOf } from "../money/keys";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { persistEngineProposal } from "../proposals/engine";
import { serviceSession } from "../sweep/service-session";
import { NOT_READ, readDigestFacts, type DigestFact, type FactId } from "./facts";
import type { CompleteFn } from "./write";

// The morning digest against the real database, as the app's role: each fact read from seeded rows
// (in and out of yesterday's window, a hand load with and without a ledger row, a parked advance, a
// posted unsent invoice, a past-due invoice) and a group that throws says not read; one digest row
// and one done line per carrier day, a second run covered with no second model call, a crashed
// try's row adopted, yesterday's open digest done once today's lands, nothing before the start
// date; the 0082 checks (a digest and only a digest has no proposal and has a date; a digest may
// be done, an ask still may not); row security keeps each carrier to its own digests; the ask card
// reads a digest with no proposal and Got it closes it; and an upgrade probe proves 0082 and its
// validate file pass the rows 0001 to 0081 left. A fixed clock in Chicago; every carrier and the
// probe's database made here are removed after.

// Wednesday Nov 4, 2026, 06:30 in Chicago (CST, UTC-6): the digest is due.
const NOW = Date.parse("2026-11-04T12:30:00.000Z");
const PERIOD = "2026-11-04";
const START = "2026-11-02";
const savedDigest = { ...flags.morningDigest };
const savedDesk = structuredClone(flags.deskLoop);
const savedAsks = structuredClone(flags.agentAsks);

let admin: Db;
let app: Db;
const made: Fixture[] = [];

type Carrier = { fixture: Fixture; service: Session };

async function carrier(slug: string): Promise<Carrier> {
  const fixture = await makeTenant(admin, `${slug}-${randomUUID().slice(0, 8)}`);
  made.push(fixture);
  await admin.withTenant(fixture.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@digest-test.invalid', 'staff')`,
    ),
  );
  const service = await serviceSession(app, fixture.tenantId);
  if (!service) throw new Error("no service login");
  return { fixture, service };
}

const asAdmin = <T>(c: Carrier, fn: (q: Queryable) => Promise<T>) => admin.withTenant(c.fixture.tenantId, fn);

// An advance card as the desk makes one (a sketch of the args only).
async function advanceCard(c: Carrier, subjectId: string): Promise<string> {
  const r = await asAdmin(c, (q) =>
    persistEngineProposal(
      q,
      {
        kind: "advance_payout",
        subjectTable: "advances",
        subjectId,
        amountCents: 30_000,
        args: { driverId: c.fixture.driverId, percent: 70 },
        exceptions: [],
        reasons: ["paperwork_complete"],
        sources: [{ table: "drivers", id: c.fixture.driverId }],
      },
      c.fixture.session,
      new Date(NOW - 3_600_000),
    ),
  );
  if (r.kind !== "created") throw new Error(`card not created: ${r.kind}`);
  return r.proposalId;
}

async function loadRow(c: Carrier, status: string): Promise<string> {
  const id = randomUUID();
  await asAdmin(c, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), $5, 'Joliet', 'IL',
         'Gary', 'IN', CAST('2026-11-02' AS date), 420, 150000)`,
      [id, `DG-L${id.slice(0, 6)}`, c.fixture.customerId, c.fixture.driverId, status],
    ),
  );
  return id;
}

async function cancelledAt(c: Carrier, at: string): Promise<void> {
  const load = await loadRow(c, "cancelled");
  await asAdmin(c, (q) =>
    q.execute(
      `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'planned', 'cancelled', 'staff', CAST($3 AS timestamptz))`,
      [randomUUID(), load, at],
    ),
  );
}

// A statement load on a card; with a ledger row, the card provider's confirmed payout names it.
async function cardLoad(c: Carrier, postedOn: string, cents: number, withLedger: boolean): Promise<void> {
  const ref = `fcs_load_${randomBytes(12).toString("hex")}`;
  await asAdmin(c, async (q) => {
    await q.execute(
      `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
         posted_at, posted_on, amount_cents, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel_card_sim', $2, 'load', $6, '0001', 'TEST',
         CAST($3 AS timestamptz), CAST($4 AS date), CAST($5 AS bigint), 'seed', CAST($3 AS timestamptz))`,
      [randomUUID(), ref, `${postedOn}T18:00:00.000Z`, postedOn, cents, `fcs_card_${"d".repeat(24)}`],
    );
    if (!withLedger) return;
    const id = randomUUID();
    const advance = randomUUID();
    await q.execute(
      `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, idempotency_key,
         request_id, amount_cents, counterparty_table, counterparty_id, proposed_by, approver_membership_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'advance_payout', 'payment', 'advances', CAST($2 AS uuid), $3,
         $4, $5, 'drivers', CAST($6 AS uuid), 'person', CAST($7 AS uuid))`,
      [id, advance, `advance_payout:${advance}:1`, requestIdOf(id), cents, c.fixture.driverId, c.fixture.memberId],
    );
    await q.execute("UPDATE money_actions SET state = 'sent', sent_at = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)", [
      id,
      `${postedOn}T18:00:00.000Z`,
    ]);
    await q.execute(
      `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = CAST($2 AS timestamptz),
              outside_system = 'fuel_card_sim', outside_type = 'load', outside_id = $3, outside_amount_cents = amount_cents
        WHERE id = CAST($1 AS uuid)`,
      [id, `${postedOn}T18:00:00.000Z`, ref],
    );
  });
}

async function paidAdvance(c: Carrier, paidAt: string, cents: number): Promise<void> {
  const id = randomUUID();
  await asAdmin(c, (q) =>
    q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on, amount_cents, status, source, paid_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz), CAST('2026-11-02' AS date),
         CAST($5 AS bigint), 'paid', 'ui', CAST($4 AS timestamptz))`,
      [id, c.fixture.driverId, `REQ-DG-${id.slice(0, 8)}`, paidAt, cents],
    ),
  );
}

async function parkedAdvance(c: Carrier): Promise<string> {
  const id = randomUUID();
  const proposal = await advanceCard(c, id);
  await asAdmin(c, (q) =>
    q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on, amount_cents, status, source,
         proposal_id, park_reason, parked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST('2026-11-03T15:00:00Z' AS timestamptz),
         CAST('2026-11-03' AS date), 30000, 'parked', 'ui', CAST($4 AS uuid), 'no_room', CAST('2026-11-03T15:00:00Z' AS timestamptz))`,
      [id, c.fixture.driverId, `REQ-DG-${id.slice(0, 8)}`, proposal],
    ),
  );
  return proposal;
}

async function openingInvoice(
  c: Carrier,
  o: { number: string; cents: number; issuedOn: string; dueOn: string; qboId?: string },
): Promise<void> {
  await asAdmin(c, (q) =>
    q.execute(
      `INSERT INTO invoices (id, tenant_id, source, customer_id, invoice_number, amount_cents, issued_on, due_on, status,
         qbo_id, qbo_amount_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'opening', CAST($2 AS uuid), $3, CAST($4 AS bigint),
         CAST($5 AS date), CAST($6 AS date), 'open', $7, $8)`,
      [randomUUID(), c.fixture.customerId, o.number, o.cents, o.issuedOn, o.dueOn, o.qboId ?? null, o.qboId ? o.cents : null],
    ),
  );
}

const valueOf = (facts: readonly DigestFact[], id: FactId) => {
  const f = facts.find((x) => x.id === id);
  if (!f) throw new Error(`no fact ${id}`);
  return f.known ? f.value : NOT_READ;
};

type DigestRow = { id: string; status: string; text: string; period_date: string; proposal_id: string | null; subject_table: string; subject_id: string };
const digestsOf = (c: Carrier) =>
  asAdmin(c, (q) =>
    q.query<DigestRow>(
      `SELECT CAST(id AS text) AS id, status, text, to_char(period_date, 'YYYY-MM-DD') AS period_date,
              CAST(proposal_id AS text) AS proposal_id, subject_table, CAST(subject_id AS text) AS subject_id
         FROM agent_asks WHERE tenant_id = current_tenant_id() AND kind = 'digest' ORDER BY period_date`,
    ),
  );

const doneLines = (c: Carrier) =>
  asAdmin(c, (q) =>
    q.query<{ event_key: string; kind: string; detail: Record<string, unknown> }>(
      `SELECT event_key, kind, detail FROM desk_log
        WHERE tenant_id = current_tenant_id() AND source = 'digest' AND kind IN ('done', 'skipped', 'failed')
        ORDER BY at, event_key`,
    ),
  );

function answer(text: string): AiResult {
  return {
    callId: randomUUID(),
    status: "ok",
    text,
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 120, reasoning: 40 },
    costNanocents: 2_500_000_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

// An empty carrier's facts: f3 is trips cancelled yesterday, 0.
const QUIET_DRAFT = JSON.stringify({ text: "No card breaks wait for you, and 0 [f3] trips were cancelled yesterday." });

function counting(text = QUIET_DRAFT): { calls: number; complete: CompleteFn } {
  const out = {
    calls: 0,
    complete: (async () => {
      out.calls += 1;
      return answer(text);
    }) as CompleteFn,
  };
  return out;
}

// Only the digest runs; every other piece of work is switched off for these wakes.
function digestOnly(complete: CompleteFn): Handlers {
  const off: Handler = {
    switchOn: () => false,
    needsMs: 1_000,
    run: async () => {
      throw new Error("not run");
    },
  };
  const out = {} as Handlers;
  for (const source of DESK_SOURCES) out[source] = off;
  out.digest = deskHandlers({ db: app, complete }).digest;
  return out;
}

let now = NOW;
const clock = () => new Date(now);
const wake = (c: Carrier, handlers: Handlers) =>
  wakeDesk(c.service, { wakeId: randomUUID(), by: "schedule", deadlineMs: now + 60_000 }, { db: app, clock, handlers, newId: randomUUID, log: () => {} });

const event = (date: string): OpenEvent => ({
  eventKey: `digest:${date}`,
  source: "digest",
  subjectId: null,
  state: "claimed",
  attempts: 1,
  carries: 0,
  threw: 0,
  runId: null,
  found: null,
  firstAt: new Date(now).toISOString(),
});

let A: Carrier;
let B: Carrier;

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
  A = await carrier("digest-a");
  B = await carrier("digest-b");
  // Yesterday (Nov 3 in Chicago) is [06:00Z Nov 3, 06:00Z Nov 4).
  await cancelledAt(A, "2026-11-03T15:00:00.000Z");
  await cancelledAt(A, "2026-11-04T07:00:00.000Z");
  await cancelledAt(A, "2026-11-03T05:59:00.000Z");
  await cardLoad(A, "2026-11-03", 15_000, false);
  await cardLoad(A, "2026-11-03", 9_000, true);
  await cardLoad(A, "2026-11-02", 7_000, false);
  await paidAdvance(A, "2026-11-03T18:00:00.000Z", 40_000);
  await paidAdvance(A, "2026-11-02T18:00:00.000Z", 25_000);
  await parkedAdvance(A);
  await openingInvoice(A, { number: "DG-1", cents: 50_000, issuedOn: "2026-10-30", dueOn: "2026-11-29", qboId: "qbo-dg-1" });
  await openingInvoice(A, { number: "DG-2", cents: 120_000, issuedOn: "2026-09-01", dueOn: "2026-10-01" });
});

afterAll(async () => {
  for (const f of made) await dropTenant(admin, f);
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  now = NOW;
  flags.morningDigest = { ...savedDigest, enabled: true, startDate: START };
  flags.deskLoop.enabled = true;
  flags.deskLoop.armed = true;
  flags.deskLoop.startDate = START;
  flags.agentAsks.enabled = true;
});

afterEach(() => {
  flags.morningDigest = { ...savedDigest };
  Object.assign(flags.deskLoop, structuredClone(savedDesk));
  Object.assign(flags.agentAsks, structuredClone(savedAsks));
});

describe("the facts", () => {
  it("reads each fact from the carrier's rows, yesterday by the carrier's own clock", async () => {
    const facts = await readDigestFacts(app, A.service, PERIOD, "America/Chicago");
    expect(facts.map((f) => f.key)).toEqual(facts.map((_, i) => `f${i + 1}`));
    expect(Object.fromEntries(facts.map((f) => [f.id, f.known ? f.value : NOT_READ]))).toEqual({
      card_check: "no check yet",
      card_breaks: 0,
      cancelled: 1,
      hand_loads: 1,
      hand_load_cents: 15_000,
      rulings_waiting: 0,
      parked: 1,
      parked_reasons: "no room",
      advance_cards: 1,
      advances_paid: 1,
      advances_paid_cents: 40_000,
      send: 1,
      fix: 0,
      add: 0,
      past_due: 1,
      past_due_cents: 120_000,
    });
  });

  it("adds the Friday and the 1st-of-month facts on those days", async () => {
    const friday = await readDigestFacts(app, A.service, "2026-11-06", "America/Chicago");
    expect(valueOf(friday, "paystubs_paid")).toBe(0);
    expect(valueOf(friday, "paystubs_net_cents")).toBe(0);
    const first = await readDigestFacts(app, A.service, "2026-11-01", "America/Chicago");
    // October: DG-1 (posted); DG-2 was issued in September.
    expect(valueOf(first, "month_invoices")).toBe(1);
    expect(valueOf(first, "month_invoice_cents")).toBe(50_000);
    expect(valueOf(first, "month_not_posted")).toBe(0);
    expect(valueOf(first, "ledger_unknown")).toBe(0);
    expect(typeof valueOf(first, "approval_breaks")).toBe("number");
  });

  it("says not read for a group whose read throws, logging only the error's name, and reads the rest", async () => {
    let n = 0;
    const flaky: TenantDb = {
      withTenant: (tenantId, fn) => {
        n += 1;
        // The third group is trips cancelled.
        if (n === 3) throw new Error("connection reset by 10.0.0.1");
        return app.withTenant(tenantId, fn);
      },
    };
    const logs: string[] = [];
    const facts = await readDigestFacts(flaky, A.service, PERIOD, "America/Chicago", { log: (l) => logs.push(l) });
    expect(facts.find((f) => f.id === "cancelled")).toMatchObject({ kind: "text", value: NOT_READ, known: false });
    expect(valueOf(facts, "hand_loads")).toBe(1);
    expect(logs).toEqual(["digest: cancelled not read (Error)"]);
  });

  it("reads only inside a read-only transaction", async () => {
    const writes: string[] = [];
    const watching: TenantDb = {
      withTenant: (tenantId, fn) =>
        app.withTenant(tenantId, (q) =>
          fn({
            query: (sql, params) => q.query(sql, params),
            execute: (sql, params) => {
              writes.push(sql);
              return q.execute(sql, params);
            },
          }),
        ),
    };
    await readDigestFacts(watching, A.service, PERIOD, "America/Chicago");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((sql) => sql === "SET TRANSACTION READ ONLY")).toBe(true);
  });
});

describe("the desk's digest", () => {
  it("writes one row and one done line, a second run is covered with no second call, and another carrier sees none of it", async () => {
    const c = await carrier("digest-run");
    const model = counting();
    const first = await wake(c, digestOnly(model.complete));
    expect(first.ok).toBe(true);
    expect(model.calls).toBe(1);
    const rows = await digestsOf(c);
    expect(rows).toEqual([
      {
        id: expect.any(String),
        status: "open",
        text: "No card breaks wait for you, and 0 trips were cancelled yesterday.",
        period_date: PERIOD,
        proposal_id: null,
        subject_table: "tenants",
        subject_id: c.fixture.tenantId,
      },
    ]);
    expect(await doneLines(c)).toEqual([
      { event_key: `digest:${PERIOD}`, kind: "done", detail: expect.objectContaining({ found: 0, cents: 3, category: "drafted" }) },
    ]);

    // A later wake finds it done; the handler run again is covered and calls nothing.
    now += 15 * 60_000;
    await wake(c, digestOnly(model.complete));
    const again = await deskHandlers({ db: app, complete: model.complete }).digest.run(c.service, event(PERIOD), {
      deadlineMs: now + 25_000,
      clock,
    });
    expect(again).toEqual({ outcome: "done", detail: { category: "covered" } });
    expect(model.calls).toBe(1);
    expect(await digestsOf(c)).toHaveLength(1);
    expect(await doneLines(c)).toHaveLength(1);

    // Row security: the other carrier reads none of it and cannot write one for it.
    const seen = await app.withTenant(B.fixture.tenantId, (q) =>
      q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM agent_asks WHERE kind = 'digest'"),
    );
    expect(seen[0].n).toBe(0);
    expect((await app.withTenant(B.fixture.tenantId, (q) => readShowingAsks(q, { nowIso: clock().toISOString(), sinceIso: null, limit: 10 }))).asks).toEqual([]);
    const intrude = app.withTenant(B.fixture.tenantId, (q) =>
      q.execute(
        `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text, period_date)
         VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'digest', NULL, 'tenants', CAST($2 AS uuid), 'x', CAST('2026-11-05' AS date))`,
        [randomUUID(), c.fixture.tenantId],
      ),
    );
    expect(await sqlStateOf(intrude)).toBe("42501");
  });

  it("adopts a crashed try's row, closes yesterday's open digest once today's lands, and lands the words line on a refused draft", async () => {
    const c = await carrier("digest-days");
    const model = counting();
    await wake(c, digestOnly(model.complete));
    // Nov 5: an earlier try stored its row and died before its done line.
    await asAdmin(c, (q) =>
      q.execute(
        `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text, period_date, created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'digest', NULL, 'tenants', current_tenant_id(), 'Morning digest. Needs you: nothing.',
           CAST('2026-11-05' AS date), CAST('2026-11-05T12:30:00Z' AS timestamptz), CAST('2026-11-05T12:30:00Z' AS timestamptz))`,
        [randomUUID()],
      ),
    );
    now = Date.parse("2026-11-05T12:40:00.000Z");
    await wake(c, digestOnly(model.complete));
    expect(model.calls).toBe(1);
    expect((await doneLines(c)).map((l) => [l.event_key, l.detail.category])).toEqual([
      [`digest:${PERIOD}`, "drafted"],
      ["digest:2026-11-05", "covered"],
    ]);

    // Nov 6: a draft with a number not in the list lands the code's words; both open days go done.
    now = Date.parse("2026-11-06T12:30:00.000Z");
    const wrong = counting(JSON.stringify({ text: "7 [f2] card breaks wait for you." }));
    await wake(c, digestOnly(wrong.complete));
    expect(wrong.calls).toBe(1);
    const rows = await digestsOf(c);
    expect(rows.map((r) => [r.period_date, r.status])).toEqual([
      [PERIOD, "done"],
      ["2026-11-05", "done"],
      ["2026-11-06", "open"],
    ]);
    expect(rows[2].text).toMatch(/^Morning digest\. Needs you: nothing\. Card check: no check yet\. /);
    expect(rows[2].text).toContain("This week: 0 paystubs paid ($0.00).");
    expect((await doneLines(c)).at(-1)).toMatchObject({ event_key: "digest:2026-11-06", detail: { category: "check_number_mismatch", cents: 3 } });

    // The ask card reads it with no proposal; Got it closes it once.
    const showing = await app.withTenant(c.fixture.tenantId, (q) =>
      readShowingAsks(q, { nowIso: clock().toISOString(), sinceIso: null, limit: 10 }),
    );
    expect(showing.openCount).toBe(1);
    expect(showing.asks[0]).toMatchObject({ id: rows[2].id, kind: "digest", proposalId: null, proposalKind: null, subjectTable: "tenants" });
    expect(await app.withTenant(c.fixture.tenantId, (q) => acknowledgeTold(q, rows[2].id, clock()))).toBe(true);
    expect(await app.withTenant(c.fixture.tenantId, (q) => acknowledgeTold(q, rows[2].id, clock()))).toBe(false);
    expect((await digestsOf(c))[2].status).toBe("done");
  });

  it("writes nothing before the start date or switched off, and calls nothing", async () => {
    const c = await carrier("digest-before");
    const model = counting();
    flags.morningDigest = { ...flags.morningDigest, startDate: "2026-11-10" };
    const handler = deskHandlers({ db: app, complete: model.complete }).digest;
    const ctx = { deadlineMs: now + 25_000, clock };
    expect(await handler.run(c.service, event(PERIOD), ctx)).toEqual({ outcome: "skipped", detail: { category: "before_start" } });
    flags.morningDigest = { ...flags.morningDigest, enabled: false, startDate: START };
    expect(handler.switchOn()).toBe(false);
    expect(await handler.run(c.service, event(PERIOD), ctx)).toEqual({ outcome: "skipped", detail: { category: "switched_off" } });
    expect(model.calls).toBe(0);
    expect(await digestsOf(c)).toEqual([]);
  });
});

describe("the 0082 checks", () => {
  it("allows one digest per carrier day, with no proposal and a date, done once seen; an ask still never done", async () => {
    const c = await carrier("digest-checks");
    const proposal = await advanceCard(c, randomUUID());
    const insert = (kind: string, proposalId: string | null, periodDate: string | null) =>
      asAdmin(c, (q) =>
        q.execute(
          `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text, period_date)
           VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), 'tenants', current_tenant_id(), 'x',
             CAST($4 AS date))`,
          [randomUUID(), kind, proposalId, periodDate],
        ),
      );
    const constraintOf = async (work: Promise<unknown>) =>
      work.then(
        () => "no error",
        (e: { constraint?: string }) => e.constraint,
      );
    expect(await constraintOf(insert("digest", proposal, PERIOD))).toBe("agent_asks_digest_shape");
    expect(await constraintOf(insert("digest", null, null))).toBe("agent_asks_digest_shape");
    expect(await constraintOf(insert("ask", null, null))).toBe("agent_asks_digest_shape");
    expect(await constraintOf(insert("told", proposal, PERIOD))).toBe("agent_asks_digest_shape");
    // A row starts open (0072's guard); an ask moved to done is refused by the check 0082 widened.
    const askId = randomUUID();
    await asAdmin(c, (q) =>
      q.execute(
        `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'ask', CAST($2 AS uuid), 'advances', current_tenant_id(), 'Send it?')`,
        [askId, proposal],
      ),
    );
    const askDone = asAdmin(c, (q) => q.execute("UPDATE agent_asks SET status = 'done' WHERE id = CAST($1 AS uuid)", [askId]));
    expect(await constraintOf(askDone)).toBe("agent_asks_check3");
    expect(await constraintOf(insert("note", proposal, null))).toBe("agent_asks_kind_check");
    expect(await constraintOf(insert("digest", null, PERIOD))).toBe("no error");
    expect(await sqlStateOf(insert("digest", null, PERIOD))).toBe("23505");
    // The app may move it open to done (Got it), as 0072's guard allows any row.
    const [row] = await digestsOf(c);
    expect(await app.withTenant(c.fixture.tenantId, (q) => acknowledgeTold(q, row.id, clock()))).toBe(true);
    // The desk log takes the digest source.
    const line = asAdmin(c, (q) =>
      q.execute(
        `INSERT INTO desk_log (id, tenant_id, wake_id, kind, event_key, source, by, at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'seen', 'digest:2026-11-09', 'digest', 'schedule', now())`,
        [randomUUID(), randomUUID()],
      ),
    );
    expect(await sqlStateOf(line)).toBe("no error");
  });
});

describe("the upgrade from 0081", () => {
  const DIR = path.join(process.cwd(), "db/migrations");
  const files = readdirSync(DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const before = files.filter((f) => f < "0082");
  const digestFiles = files.filter((f) => f.startsWith("0082_"));
  const name = `digest_probe_${randomBytes(6).toString("hex")}`;
  const server = () => new Client({ connectionString: adminUrl() });
  let probe: Db | undefined;

  async function apply(db: Db, file: string): Promise<void> {
    const statements = splitSql(readFileSync(path.join(DIR, file), "utf8"));
    await db.withoutTenant(async (q) => {
      for (const s of statements) await q.execute(s);
    });
  }

  afterAll(async () => {
    await probe?.close();
    const c = server();
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  });

  it("passes every ask, told and desk log row 0001 to 0081 left, then holds a digest to its shape", async () => {
    expect(digestFiles).toEqual(["0082_morning_digest.sql", "0082_morning_digest_validate.sql"]);
    const c = server();
    await c.connect();
    try {
      await c.query(`CREATE DATABASE ${name}`);
    } finally {
      await c.end();
    }
    const url = new URL(adminUrl());
    url.pathname = `/${name}`;
    probe = createPgDb({ connectionString: url.toString() });
    for (const f of before) await apply(probe, f);

    const f = await makeTenant(probe, `digest-probe-${randomUUID().slice(0, 8)}`);
    const db = probe;
    const card = await db.withTenant(f.tenantId, (q) =>
      persistEngineProposal(
        q,
        {
          kind: "advance_payout",
          subjectTable: "advances",
          subjectId: randomUUID(),
          amountCents: 30_000,
          args: { driverId: f.driverId, percent: 70 },
          exceptions: [],
          reasons: ["paperwork_complete"],
          sources: [{ table: "drivers", id: f.driverId }],
        },
        f.session,
        new Date(NOW - 3_600_000),
      ),
    );
    if (card.kind !== "created") throw new Error(`card not created: ${card.kind}`);
    const proposal = card.proposalId;
    const ask = randomUUID();
    const told = randomUUID();
    await db.withTenant(f.tenantId, async (q) => {
      await q.execute(
        `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text) VALUES
           (CAST($1 AS uuid), current_tenant_id(), 'ask', CAST($3 AS uuid), 'advances', CAST($4 AS uuid), 'Send it?'),
           (CAST($2 AS uuid), current_tenant_id(), 'told', CAST($3 AS uuid), 'advances', CAST($4 AS uuid), 'Sent it.')`,
        [ask, told, proposal, randomUUID()],
      );
      // A told line the owner has seen, as acknowledgeTold leaves it.
      await q.execute("UPDATE agent_asks SET status = 'done' WHERE id = CAST($1 AS uuid)", [told]);
      await q.execute(
        `INSERT INTO desk_log (id, tenant_id, wake_id, kind, event_key, source, by, at) VALUES
           (CAST($1 AS uuid), current_tenant_id(), CAST($3 AS uuid), 'wake', NULL, NULL, 'schedule', now()),
           (CAST($2 AS uuid), current_tenant_id(), CAST($3 AS uuid), 'seen', 'sweep:2026-11-02', 'sweep', 'schedule', now())`,
        [randomUUID(), randomUUID(), randomUUID()],
      );
    });

    for (const file of digestFiles) await apply(probe, file);
    const validated = await probe.withoutTenant((q) =>
      q.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conname IN ('desk_log_source_check', 'agent_asks_kind_check', 'agent_asks_digest_shape', 'agent_asks_check3')
          ORDER BY conname`,
      ),
    );
    expect(validated).toEqual([
      { conname: "agent_asks_check3", convalidated: true },
      { conname: "agent_asks_digest_shape", convalidated: true },
      { conname: "agent_asks_kind_check", convalidated: true },
      { conname: "desk_log_source_check", convalidated: true },
    ]);
    const kept = await probe.withTenant(f.tenantId, (q) =>
      q.query<{ kind: string; status: string; period_date: string | null }>(
        "SELECT kind, status, CAST(period_date AS text) AS period_date FROM agent_asks ORDER BY kind",
      ),
    );
    expect(kept).toEqual([
      { kind: "ask", status: "open", period_date: null },
      { kind: "told", status: "done", period_date: null },
    ]);

    const digest = (proposalId: string | null, periodDate: string | null) =>
      probe!.withTenant(f.tenantId, (q) =>
        q.execute(
          `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text, period_date)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'digest', CAST($2 AS uuid), 'tenants', current_tenant_id(), 'x', CAST($3 AS date))`,
          [randomUUID(), proposalId, periodDate],
        ),
      );
    expect(await sqlStateOf(digest(proposal, PERIOD))).toBe("23514");
    expect(await sqlStateOf(digest(null, null))).toBe("23514");
    expect(await sqlStateOf(digest(null, PERIOD))).toBe("no error");
  }, 120_000);
});
