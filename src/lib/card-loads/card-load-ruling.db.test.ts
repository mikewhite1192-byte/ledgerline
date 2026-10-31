import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { loadId } from "../adapters/payment/fuel-card-sim";
import { getCardLoads } from "../agent/gateway/tools/read/get-card-loads";
import type { Session } from "../auth/claims";
import { autopilotSub } from "../autopilot/session";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { deskHandlers } from "../desk/handlers";
import type { OpenEvent } from "../desk/log";
import { requestIdOf } from "../money/keys";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal, type ApproveOptions, type Executor } from "../proposals/execute";
import { cardLoadRulingExecutor } from "../proposals/executors/card-load-ruling";
import { serviceSession } from "../sweep/service-session";
import { assertMembership } from "../tenant/context";
import { simLoadIdSql } from "./facts";
import { proposeCardLoadRuling } from "./ruling";

// The card load ruling against the real database, as the app's role, with a fixed clock: a load on
// the card statement with no payment record behind it drafts one card for a person, Yes books one
// deficit for the full load, owes_nothing books none, the autopilot never rules, and another
// carrier sees none of it. Only this file's two carriers are made, and they are removed after.

// Monday Nov 2, 2026, 10:00 in Chicago (the fixture carriers' zone), after the start date.
const NOW = new Date("2026-11-02T16:00:00.000Z");
const clock = () => NOW;
const WRITTEN = "2026-11-02T14:00:00.000Z";
const CENTS = 40_000;
const saved = structuredClone(flags);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let serviceA: Session;
let serviceB: Session;

async function addService(f: Fixture): Promise<Session> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@ruling-test.invalid', 'staff')`,
    ),
  );
  const s = await serviceSession(app, f.tenantId);
  if (!s) throw new Error("no service login");
  return s;
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
  A = await makeTenant(admin, `ruling-a-${randomUUID().slice(0, 8)}`);
  B = await makeTenant(admin, `ruling-b-${randomUUID().slice(0, 8)}`);
  serviceA = await addService(A);
  serviceB = await addService(B);
});

afterAll(async () => {
  await dropTenant(admin, A);
  await dropTenant(admin, B);
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  flags.cardLoadRuling = { enabled: true, startDate: "2026-10-31" };
  flags.cardRecon.enabled = false;
  flags.agentAsks.enabled = true;
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
});

// The driver's default card, as the statement names it.
async function cardOf(f: Fixture, driverId: string): Promise<{ token: string; last4: string }> {
  const [c] = await admin.withTenant(f.tenantId, (q) =>
    q.query<{ token: string; last4: string }>(
      `SELECT provider_token AS token, last4 FROM driver_cards
        WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND is_default`,
      [driverId],
    ),
  );
  return c;
}

type Load = { id: string; ref: string; last4: string };

// A statement load on a card, written at a fixed instant (the seed writes the statement).
async function load(
  f: Fixture,
  over: { driverId?: string; token?: string; last4?: string; createdAt?: string; cents?: number; ref?: string } = {},
): Promise<Load> {
  const card = over.token ? { token: over.token, last4: over.last4 ?? "0000" } : await cardOf(f, over.driverId ?? f.driverId);
  const id = randomUUID();
  const ref = over.ref ?? `fcs_load_${randomBytes(12).toString("hex")}`;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
         posted_at, posted_on, amount_cents, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel_card_sim', $2, 'load', $3, $4, 'TEST',
         CAST($5 AS timestamptz), CAST('2026-11-02' AS date), CAST($6 AS bigint), 'seed', CAST($5 AS timestamptz))`,
      [id, ref, card.token, card.last4, over.createdAt ?? WRITTEN, over.cents ?? CENTS],
    ),
  );
  return { id, ref, last4: card.last4 };
}

type LedgerState = "reserved" | "sent" | "unknown" | "confirmed";

// An advance payout's ledger row, moved the way the ledger moves one: reserved, then sent, then
// either left unknown or confirmed by the card provider with the load's reference (only a settle
// writes the outside columns). id: the row's id (its request id is the id without dashes);
// advanceId: the advance it pays. Returns the row's id.
async function ledgerRow(
  f: Fixture,
  ref: string,
  to: LedgerState = "confirmed",
  over: { id?: string; advanceId?: string } = {},
): Promise<string> {
  const id = over.id ?? randomUUID();
  const advance = over.advanceId ?? randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, idempotency_key,
         request_id, amount_cents, counterparty_table, counterparty_id, proposed_by, approver_membership_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'advance_payout', 'payment', 'advances', CAST($2 AS uuid), $3,
         $4, $5, 'drivers', CAST($6 AS uuid), 'person', CAST($7 AS uuid))`,
      [id, advance, `advance_payout:${advance}:1`, requestIdOf(id), CENTS, f.driverId, f.memberId],
    );
    if (to === "reserved") return;
    await q.execute("UPDATE money_actions SET state = 'sent', sent_at = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)", [
      id,
      WRITTEN,
    ]);
    if (to === "unknown") {
      await q.execute("UPDATE money_actions SET state = 'unknown' WHERE id = CAST($1 AS uuid)", [id]);
    } else if (to === "confirmed") {
      await q.execute(
        `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = CAST($2 AS timestamptz),
                outside_system = 'fuel_card_sim', outside_type = 'load', outside_id = $3, outside_amount_cents = amount_cents
          WHERE id = CAST($1 AS uuid)`,
        [id, WRITTEN, ref],
      );
    }
  });
  return id;
}

// A load whose reference is the one the card provider makes for a ledger row with this id.
const loadFor = (f: Fixture, actionId: string) => load(f, { ref: loadId(requestIdOf(actionId)) });

// The card check's open difference on a load, as a finished check leaves it.
async function openBreak(f: Fixture, l: Load): Promise<void> {
  const run = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO card_recon_runs (id, tenant_id, membership_id, status, phase, window_from, window_to, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'done', 'done', CAST('2026-10-20' AS date),
         CAST('2026-11-02' AS date), CAST($3 AS timestamptz), CAST($3 AS timestamptz))`,
      [run, f.memberId, WRITTEN],
    );
    await q.execute(
      `INSERT INTO card_recon_breaks (id, tenant_id, fingerprint, category, severity, outside_system, card_transaction_id,
         outside_cents, fix_kind, first_seen_run_id, last_seen_run_id)
       VALUES (gen_random_uuid(), current_tenant_id(), $1, 'load_not_in_ledger', 'high', 'fuel_card_sim', CAST($2 AS uuid),
         CAST($3 AS bigint), 'by_hand', CAST($4 AS uuid), CAST($4 AS uuid))`,
      [randomBytes(32).toString("hex"), l.id, CENTS, run],
    );
  });
}

const draft = (session: Session, id: string, f: Fixture = A) =>
  app.withTenant(f.tenantId, async (q) => {
    await assertMembership(q, session);
    return proposeCardLoadRuling(q, session, id, NOW);
  });

async function drafted(l: Load, f: Fixture = A, session: Session = f === A ? serviceA : serviceB): Promise<string> {
  const r = await draft(session, l.id, f);
  if (r.kind !== "proposed") throw new Error(`nothing drafted: ${r.category}`);
  // The auditor's pass, as a finished audit stores it.
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [r.proposalId, NOW.toISOString()],
    ),
  );
  return r.proposalId;
}

const approve = (session: Session, id: string, opts: ApproveOptions = { confirmed: false }, executors?: Record<string, Executor>) =>
  executeProposal(session, id, opts, { db: app, clock, ...(executors ? { executors } : {}) });

async function count(f: Fixture, sql: string, params: Param[] = []): Promise<number> {
  const [r] = await admin.withTenant(f.tenantId, (q) => q.query<{ n: string }>(sql, params));
  return Number(r.n);
}

const proposalsOn = (f: Fixture, l: Load) =>
  count(f, "SELECT count(*) AS n FROM proposals WHERE tenant_id = current_tenant_id() AND subject_id = CAST($1 AS uuid)", [l.id]);
const deficitsOn = (f: Fixture, l: Load) =>
  count(f, "SELECT count(*) AS n FROM driver_deficits WHERE tenant_id = current_tenant_id() AND source_id = CAST($1 AS uuid)", [l.id]);

async function proposalRow(f: Fixture, id: string) {
  const [r] = await admin.withTenant(f.tenantId, (q) =>
    q.query<{ status: string; decision_note: string | null; kind: string; amount_cents: string; direction: string }>(
      "SELECT status, decision_note, kind, CAST(amount_cents AS text) AS amount_cents, direction FROM proposals WHERE id = CAST($1 AS uuid)",
      [id],
    ),
  );
  return r;
}

describe("drafting the ruling card", () => {
  it("drafts one card and one question for a load with no record, however many times the row is read", async () => {
    const l = await load(A);
    const first = await draft(serviceA, l.id);
    expect(first).toMatchObject({ kind: "proposed", amountCents: CENTS });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "already" });
    expect(await proposalsOn(A, l)).toBe(1);
    const p = await proposalRow(A, (first as { proposalId: string }).proposalId);
    expect(p).toMatchObject({ kind: "card_load_ruling", status: "proposed", amount_cents: String(CENTS), direction: "none" });
    const asks = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ text: string }>("SELECT text FROM agent_asks WHERE tenant_id = current_tenant_id() AND subject_id = CAST($1 AS uuid)", [l.id]),
    );
    expect(asks).toEqual([
      {
        text:
          "Test Driver's fuel card got a $400.00 load I have no record of. Yes books it as money Test Driver owes; " +
          "open the card to rule otherwise.",
      },
    ]);
  });

  it("drafts nothing while the switch is off, and writes no row", async () => {
    flags.cardLoadRuling = { enabled: false, startDate: "2026-10-31" };
    const l = await load(A);
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "switched_off" });
    expect(await proposalsOn(A, l)).toBe(0);
  });

  it("drafts nothing for a row written before the start date (backlog)", async () => {
    const l = await load(A, { createdAt: "2026-10-30T15:00:00.000Z" });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "before_start" });
    expect(await proposalsOn(A, l)).toBe(0);
  });

  it("drafts nothing for a load a payment record names", async () => {
    const l = await load(A);
    await ledgerRow(A, l.ref);
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "ledger_row" });
    expect(await proposalsOn(A, l)).toBe(0);
  });

  it("drafts nothing for a card on no driver's file", async () => {
    const l = await load(A, { token: `fcs_card_${randomBytes(12).toString("hex")}`, last4: "1234" });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "no_driver" });
    expect(await proposalsOn(A, l)).toBe(0);
  });
});

describe("ruling on the card", () => {
  it("books one deficit for the full load on Yes, resolves the difference, and books no second on another Yes", async () => {
    const l = await load(A);
    await openBreak(A, l);
    const id = await drafted(l);
    expect(await approve(A.session, id)).toMatchObject({ ok: true, status: "done" });
    const rows = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ driver_id: string; amount_cents: string; named_by: string; source_kind: string; proposal_id: string; note: string }>(
        `SELECT CAST(driver_id AS text) AS driver_id, CAST(amount_cents AS text) AS amount_cents,
                CAST(named_by AS text) AS named_by, source_kind, CAST(proposal_id AS text) AS proposal_id, note
           FROM driver_deficits WHERE tenant_id = current_tenant_id() AND source_id = CAST($1 AS uuid)`,
        [l.id],
      ),
    );
    expect(rows).toEqual([
      {
        driver_id: A.driverId,
        amount_cents: String(CENTS),
        named_by: A.memberId,
        source_kind: "card_load",
        proposal_id: id,
        note: `Card load $400.00 on card ending ${l.last4}, posted 2026-11-02, no payment record.`,
      },
    ]);
    expect(await proposalRow(A, id)).toMatchObject({ status: "done", decision_note: "deficit" });
    expect(
      await count(A, "SELECT count(*) AS n FROM card_recon_breaks WHERE tenant_id = current_tenant_id() AND card_transaction_id = CAST($1 AS uuid) AND status = 'resolved'", [l.id]),
    ).toBe(1);
    expect(await approve(A.session, id)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await deficitsOn(A, l)).toBe(1);
    // The row is decided: reading it again drafts nothing new.
    expect((await draft(serviceA, l.id)).kind).toBe("nothing");
    expect(await proposalsOn(A, l)).toBe(1);
  });

  it("books nothing on owes_nothing with the second confirm, and asks for the confirm without it", async () => {
    const l = await load(A);
    const id = await drafted(l);
    expect(await approve(A.session, id, { confirmed: false, edits: { ruling: "owes_nothing" } })).toMatchObject({
      ok: false,
      category: "needs_confirm",
    });
    expect(await proposalRow(A, id)).toMatchObject({ status: "proposed" });
    expect(await approve(A.session, id, { confirmed: true, edits: { ruling: "owes_nothing" } })).toMatchObject({ ok: true, status: "done" });
    expect(await proposalRow(A, id)).toMatchObject({ status: "done", decision_note: "owes_nothing" });
    expect(await deficitsOn(A, l)).toBe(0);
  });

  it("refuses an edit outside the ruling", async () => {
    const l = await load(A);
    const id = await drafted(l);
    expect(await approve(A.session, id, { confirmed: true, edits: { ruling: "owes_half" } })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    expect(await approve(A.session, id, { confirmed: true, edits: { amountCents: "1" } })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    expect(await proposalRow(A, id)).toMatchObject({ status: "proposed" });
    expect(await deficitsOn(A, l)).toBe(0);
  });

  it("never lets the autopilot rule, and its rules table refuses the kind", async () => {
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, 'autopilot@ruling-test.invalid', 'staff')`,
        [autopilotSub(A.tenantId)],
      ),
    );
    const auto: Session = { sub: autopilotSub(A.tenantId), email: "", tenantId: A.tenantId };
    const l = await load(A);
    const id = await drafted(l);
    expect(await approve(auto, id, { confirmed: false, autopilot: { ruleId: randomUUID(), version: 1 } })).toMatchObject({
      ok: false,
      category: "kind_never_alone",
    });
    expect(await proposalRow(A, id)).toMatchObject({ status: "proposed" });
    expect(await deficitsOn(A, l)).toBe(0);
    expect(
      await sqlStateOf(
        admin.withTenant(A.tenantId, (q) =>
          q.execute(
            `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
             VALUES (current_tenant_id(), 'card_load_ruling', 'auto', 1, 1, 1, 'test')`,
          ),
        ),
      ),
    ).toBe("23514");
  });

  it("goes stale when a payment record shows up: before the approval the card waits, after it the card fails with no deficit", async () => {
    const l = await load(A);
    const id = await drafted(l);
    await ledgerRow(A, l.ref);
    expect(await approve(A.session, id)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalRow(A, id)).toMatchObject({ status: "proposed" });

    // A record that lands between the approval and the booking: the executor's own re-check.
    const late = await load(A);
    const lateId = await drafted(late);
    const racing: Executor = async (db, session, proposal, opts, deps) => {
      await ledgerRow(A, late.ref);
      return cardLoadRulingExecutor(db, session, proposal, opts, deps);
    };
    expect(await approve(A.session, lateId, { confirmed: false }, { card_load_ruling: racing })).toMatchObject({ ok: false });
    expect(await proposalRow(A, lateId)).toMatchObject({ status: "failed", decision_note: "stale" });
    expect(await deficitsOn(A, late)).toBe(0);
  });
});

describe("a payout not yet settled", () => {
  it("makes the same load id in SQL as the card provider makes from the row's request id", async () => {
    const id = await ledgerRow(A, "unused", "reserved");
    const [r] = await app.withTenant(A.tenantId, (q) =>
      q.query<{ request_id: string; load_id: string }>(
        `SELECT m.request_id, ${simLoadIdSql("m.request_id")} AS load_id FROM money_actions m
          WHERE m.tenant_id = current_tenant_id() AND m.id = CAST($1 AS uuid)`,
        [id],
      ),
    );
    expect(r.request_id).toBe(requestIdOf(id));
    expect(r.load_id).toBe(loadId(r.request_id));
  });

  it("drafts nothing for a load whose payout is still sent, and the agent reads it as recorded", async () => {
    const id = randomUUID();
    const l = await loadFor(A, id);
    await ledgerRow(A, l.ref, "sent", { id });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "ledger_row" });
    expect(await proposalsOn(A, l)).toBe(0);
    const ctx = { now: NOW, timeZone: "America/Chicago", session: A.session } as never;
    const out = await app.withTenant(A.tenantId, (q) => getCardLoads.run(q, ctx, { days: 7, limit: 50 }, { screen: null, limit: null }));
    const rows = (out.result as { rows: { id: string; record: string }[] }).rows;
    expect(rows.find((r) => r.id === l.id)).toMatchObject({ record: "recorded" });
  });

  it("drafts nothing for a load whose payout outcome is unknown", async () => {
    const id = randomUUID();
    const l = await loadFor(A, id);
    await ledgerRow(A, l.ref, "unknown", { id });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "ledger_row" });
    expect(await proposalsOn(A, l)).toBe(0);
  });

  it("drafts nothing for a load whose payout is only reserved", async () => {
    const id = randomUUID();
    const l = await loadFor(A, id);
    await ledgerRow(A, l.ref, "reserved", { id });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "ledger_row" });
    expect(await proposalsOn(A, l)).toBe(0);
  });

  it("drafts nothing for a load on a card an advance payout not yet settled went to", async () => {
    // The second driver's card, so no other test's loads sit on it.
    const [c] = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ id: string }>(
        `SELECT CAST(id AS text) AS id FROM driver_cards
          WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND is_default`,
        [A.otherDriverId],
      ),
    );
    const advance = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on, amount_cents, status, source, card_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz), CAST('2026-11-02' AS date),
           CAST($5 AS bigint), 'approved', 'ui', CAST($6 AS uuid))`,
        [advance, A.otherDriverId, `REQ-RULING-${advance.slice(0, 8)}`, WRITTEN, CENTS, c.id],
      ),
    );
    // The load's reference is not the one the payout's request id makes: only the card ties them.
    const l = await load(A, { driverId: A.otherDriverId });
    await ledgerRow(A, "unused", "unknown", { advanceId: advance });
    expect(await draft(serviceA, l.id)).toEqual({ kind: "nothing", category: "ledger_row" });
    expect(await proposalsOn(A, l)).toBe(0);
  });

  it("goes stale when a payout not yet settled shows up, before the approval and between the approval and the booking", async () => {
    const early = randomUUID();
    const l = await loadFor(A, early);
    const id = await drafted(l);
    await ledgerRow(A, l.ref, "sent", { id: early });
    expect(await approve(A.session, id)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalRow(A, id)).toMatchObject({ status: "proposed" });
    expect(await deficitsOn(A, l)).toBe(0);

    const lateAction = randomUUID();
    const late = await loadFor(A, lateAction);
    const lateId = await drafted(late);
    const racing: Executor = async (db, session, proposal, opts, deps) => {
      await ledgerRow(A, late.ref, "unknown", { id: lateAction });
      return cardLoadRulingExecutor(db, session, proposal, opts, deps);
    };
    expect(await approve(A.session, lateId, { confirmed: false }, { card_load_ruling: racing })).toMatchObject({ ok: false });
    expect(await proposalRow(A, lateId)).toMatchObject({ status: "failed", decision_note: "stale" });
    expect(await deficitsOn(A, late)).toBe(0);
  });
});

describe("the deficits table", () => {
  const insert = (over: { amount?: number; note?: string; namedBy?: string; proposalId?: string }) =>
    app.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by, proposal_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS bigint), $4, 'ruling', CAST($5 AS uuid),
           CAST($6 AS uuid), CAST($7 AS uuid))`,
        [randomUUID(), A.driverId, over.amount ?? 100, over.note ?? "A note.", randomUUID(), over.namedBy ?? A.memberId, over.proposalId ?? null],
      ),
    );

  it("refuses a zero amount, a long note and another carrier's member", async () => {
    expect(await sqlStateOf(insert({ amount: 0 }))).toBe("23514");
    expect(await sqlStateOf(insert({ note: "x".repeat(201) }))).toBe("23514");
    expect(await sqlStateOf(insert({ namedBy: B.memberId }))).toBe("23503");
  });

  it("refuses a card load deficit with no proposal behind it", async () => {
    const write = app.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by)
         VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 100, 'A note.', 'card_load', gen_random_uuid(), CAST($2 AS uuid))`,
        [A.driverId, A.memberId],
      ),
    );
    expect(await sqlStateOf(write)).toBe("23514");
  });

  it("keeps the app from changing or deleting a deficit, beyond the week that settles it", async () => {
    expect(
      await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("UPDATE driver_deficits SET amount_cents = 1 WHERE tenant_id = current_tenant_id()"))),
    ).toBe("42501");
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM driver_deficits WHERE tenant_id = current_tenant_id()")))).toBe(
      "42501",
    );
  });
});

describe("another carrier", () => {
  it("reads none of the deficits and cannot rule on the card", async () => {
    const l = await load(A);
    const id = await drafted(l);
    expect(await approve(A.session, id)).toMatchObject({ ok: true });
    const seen = await app.withTenant(B.tenantId, (q) => q.query<{ n: string }>("SELECT count(*) AS n FROM driver_deficits"));
    expect(Number(seen[0].n)).toBe(0);
    const other = await load(A);
    const otherId = await drafted(other);
    expect(await approve(B.session, otherId)).toMatchObject({ ok: false, category: "not_found" });
    expect(await proposalRow(A, otherId)).toMatchObject({ status: "proposed" });
  });
});

describe("the desk's card statement line", () => {
  it("drafts the card once with the card check off, and reads it as already drafted the second time", async () => {
    const l = await load(A);
    const handler = deskHandlers({ db: app }).card_transaction;
    expect(handler.switchOn()).toBe(true);
    const event: OpenEvent = {
      eventKey: `card_transaction:${l.id}`,
      source: "card_transaction",
      subjectId: l.id,
      state: "claimed",
      attempts: 1,
      carries: 0,
      threw: 0,
      runId: null,
      found: null,
      firstAt: WRITTEN,
    };
    const ctx = { deadlineMs: NOW.getTime() + 14_000, clock };
    expect(await handler.run(serviceA, event, ctx)).toEqual({ outcome: "done", detail: { found: 1, category: "ruling_drafted" } });
    expect(await handler.run(serviceA, event, ctx)).toEqual({ outcome: "done", detail: { found: 0, category: "ruling_already" } });
    expect(await proposalsOn(A, l)).toBe(1);
    flags.cardLoadRuling = { enabled: false, startDate: "2026-10-31" };
    expect(handler.switchOn()).toBe(false);
  });
});

describe("get_card_loads", () => {
  const ctx = (f: Fixture) => ({ now: NOW, timeZone: "America/Chicago", session: f.session }) as never;
  const EXTRAS = { screen: null, limit: null };
  const rowsOf = async (f: Fixture) => {
    const out = await app.withTenant(f.tenantId, (q) => getCardLoads.run(q, ctx(f), { days: 7, limit: 50 }, EXTRAS));
    return (out.result as { rows: { id: string; record: string; ruling: unknown; driver: unknown }[] }).rows;
  };

  it("lists a load as no record, then as ruled, and another carrier sees none of it", async () => {
    const l = await load(A);
    const before = (await rowsOf(A)).find((r) => r.id === l.id);
    expect(before).toMatchObject({ record: "no_record", ruling: null, driver: { id: A.driverId, code: "DRV-1" } });
    const id = await drafted(l);
    expect(await approve(A.session, id)).toMatchObject({ ok: true });
    const after = (await rowsOf(A)).find((r) => r.id === l.id);
    expect(after).toMatchObject({
      record: "no_record",
      ruling: { proposalId: id, status: "done", ruling: "deficit", decidedBy: "staff", deficitCents: CENTS },
    });
    expect((await rowsOf(B)).find((r) => r.id === l.id)).toBeUndefined();
  });

  it("is offered only while the switch is on, and refuses a call with it off", async () => {
    expect(getCardLoads.enabled?.()).toBe(true);
    flags.cardLoadRuling = { enabled: false, startDate: "2026-10-31" };
    expect(getCardLoads.enabled?.()).toBe(false);
    await expect(app.withTenant(A.tenantId, (q) => getCardLoads.run(q, ctx(A), {}, EXTRAS))).rejects.toThrow("switched off");
  });
});
