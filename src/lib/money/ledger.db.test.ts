import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import { ForbiddenError } from "../tenant/context";
import { approvalFrom } from "./approval";
import { bumpCheck, markSent, mustReadAction, reserve, settle } from "./ledger";
import { readBySubject, readPending, readTenantZone } from "./read";
import {
  addAdvance,
  clearLedger,
  dropTenant,
  makeTenant,
  sqlStateOf,
  type Fixture,
} from "./test-db";
import type { MoneyAction, MoneyActionKind, MoneyDraft } from "./types";

// The money ledger as the app role sees it: tenant walls, the trigger's state machine, the
// dedupe keys and the pending read. Every test removes its ledger rows; the tenants go at the end.

const saved = { ...flags };
let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let advance: string;

const OUTSIDE = { system: "mock" as const, type: "payout", id: "mock_0000000000000001" };

function draft(over: Partial<MoneyDraft> = {}): MoneyDraft {
  return {
    kind: "advance_payout",
    subjectId: advance,
    counterpartyId: A.driverId,
    amountCents: 25_000,
    proposedBy: "agent",
    subjectStatuses: ["requested"],
    ...over,
  };
}

// Reserve as the app, approved by A's own member.
function reserveA(over: Partial<MoneyDraft> = {}) {
  return app.withTenant(A.tenantId, async (q) => {
    const approval = await approvalFrom(q, A.session);
    return reserve(q, approval, draft(over));
  });
}

const inA = <T>(fn: (q: Queryable) => Promise<T>) => app.withTenant(A.tenantId, fn);

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `ledger-a-${tag}`);
  B = await makeTenant(admin, `ledger-b-${tag}`);
});

beforeEach(async () => {
  flags.payoutsEnabled = true;
  advance = await addAdvance(admin, A);
});

afterEach(async () => {
  Object.assign(flags, saved);
  await clearLedger(admin, A);
  await clearLedger(admin, B);
});

afterAll(async () => {
  Object.assign(flags, saved);
  await dropTenant(admin, A);
  await dropTenant(admin, B);
  await app?.close();
  await admin?.close();
});

describe("0006 money_actions", () => {
  it("gives the app role select, insert and update, and no delete", async () => {
    const rows = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(
        `SELECT has_table_privilege('payday_app', 'money_actions', 'SELECT') AS s,
                has_table_privilege('payday_app', 'money_actions', 'INSERT') AS i,
                has_table_privilege('payday_app', 'money_actions', 'UPDATE') AS u,
                has_table_privilege('payday_app', 'money_actions', 'DELETE') AS d,
                EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'money_actions_guard') AS t`,
      ),
    );
    expect(rows).toEqual([{ s: true, i: true, u: true, d: false, t: true }]);
    const { action } = await reserveA();
    expect(
      await sqlStateOf(
        inA((q) => q.execute("DELETE FROM money_actions WHERE id = CAST($1 AS uuid)", [action.id])),
      ),
    ).toBe("42501");
  });
});

describe("reserve", () => {
  it("writes a bare reservation whose keys derive from stored values", async () => {
    const { action, created } = await reserveA({ traceId: randomUUID() });
    expect(created).toBe(true);
    expect(action).toMatchObject({
      tenantId: A.tenantId,
      kind: "advance_payout",
      channel: "payment",
      subjectTable: "advances",
      subjectId: advance,
      attempt: 1,
      idempotencyKey: `advance_payout:${advance}:1`,
      requestId: action.id.replace(/-/g, ""),
      amountCents: 25_000,
      counterpartyTable: "drivers",
      counterpartyId: A.driverId,
      state: "reserved",
      approverMembershipId: A.memberId,
      checkCount: 0,
      sentAt: null,
      sentSecondsAgo: null,
    });
    expect(action.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("replays the same key as created: false, and refuses a replay for another amount", async () => {
    const first = await reserveA();
    const again = await reserveA();
    expect(again.created).toBe(false);
    expect(again.action.id).toBe(first.action.id);
    expect(await sqlStateOf(reserveA({ amountCents: 25_001 }))).toBe("duplicate");
    const rows = await inA((q) => readBySubject(q, "advances", advance));
    expect(rows).toHaveLength(1);
  });

  it("refuses a subject in another status, of another driver, or of another tenant", async () => {
    expect(await sqlStateOf(reserveA({ subjectStatuses: ["approved"] }))).toBe("validation");
    expect(await sqlStateOf(reserveA({ counterpartyId: A.otherDriverId }))).toBe("validation");
    const theirs = await addAdvance(admin, B);
    expect(await sqlStateOf(reserveA({ subjectId: theirs, counterpartyId: B.driverId }))).toBe(
      "validation",
    );
  });

  it("refuses everything while the channel's switch is off", async () => {
    flags.payoutsEnabled = false;
    expect(await sqlStateOf(reserveA())).toBe("disabled");
  });

  it("locks a subject without a status (a customer payment) and reserves it", async () => {
    flags.accountingEnabled = true;
    const { action, created } = await reserveA({
      kind: "customer_payment",
      subjectId: A.paymentId,
      counterpartyId: A.customerId,
      amountCents: 50_000,
      subjectStatuses: undefined,
    });
    expect(created).toBe(true);
    expect(action.channel).toBe("accounting");
    expect(action.counterpartyTable).toBe("customers");
  });

  it("frees a definitely failed subject for attempt 2, never an unknown one", async () => {
    const one = await reserveA();
    await inA((q) => settle(q, one.action.id, { to: "failed", via: "refused", category: "disabled" }));
    const two = await reserveA({ attempt: 2 });
    expect(two.created).toBe(true);
    expect(two.action.idempotencyKey).toBe(`advance_payout:${advance}:2`);

    await inA(async (q) => {
      expect(await markSent(q, two.action.id)).toBe(true);
      expect(await settle(q, two.action.id, { to: "unknown", category: "timeout" })).toBe(true);
    });
    expect(await sqlStateOf(reserveA({ attempt: 3 }))).toBe("duplicate");
  });

  it("keeps a subject with an amount mismatch closed for a person", async () => {
    const one = await reserveA();
    await inA(async (q) => {
      await markSent(q, one.action.id);
      await settle(q, one.action.id, {
        to: "failed",
        via: "read_back",
        category: "amount_mismatch",
        outside: { ...OUTSIDE, amountCents: 2_500 },
      });
    });
    expect(await sqlStateOf(reserveA({ attempt: 2 }))).toBe("duplicate");
  });

  it("settles an unknown row as outside_failed by read-back, which frees the subject for attempt 2", async () => {
    const one = await reserveA();
    await inA(async (q) => {
      await markSent(q, one.action.id);
      await settle(q, one.action.id, { to: "unknown", category: "timeout" });
      expect(
        await settle(q, one.action.id, {
          to: "failed",
          via: "read_back",
          category: "outside_failed",
          outside: { ...OUTSIDE, amountCents: 25_000 },
        }),
      ).toBe(true);
    });
    expect(await inA((q) => mustReadAction(q, one.action.id))).toMatchObject({
      state: "failed",
      failureCategory: "outside_failed",
      settledVia: "read_back",
      checkCount: 1,
    });
    expect((await reserveA({ attempt: 2 })).created).toBe(true);
  });

  it("refuses a second live row for the subject whatever the key (23505 -> duplicate)", async () => {
    await reserveA();
    expect(await sqlStateOf(reserveA({ attempt: 2 }))).toBe("duplicate");
  });
});

describe("tenant walls", () => {
  it("hides tenant A's rows from tenant B and refuses B writing a row for A", async () => {
    const { action } = await reserveA();
    const seen = await app.withTenant(B.tenantId, (q) =>
      q.query<{ n: number }>("SELECT count(*) AS n FROM money_actions WHERE id = CAST($1 AS uuid)", [
        action.id,
      ]),
    );
    expect(seen).toEqual([{ n: 0 }]);
    const id = randomUUID();
    const insert = app.withTenant(B.tenantId, (q) =>
      q.execute(
        `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id,
           idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id,
           proposed_by, approver_membership_id)
         VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'advance_payout', 'payment', 'advances',
           CAST($3 AS uuid), $4, $5, 100, 'drivers', CAST($6 AS uuid), 'person', CAST($7 AS uuid))`,
        [id, A.tenantId, advance, `advance_payout:${advance}:1`, id.replace(/-/g, ""), A.driverId, A.memberId],
      ),
    );
    expect(await sqlStateOf(insert)).toBe("42501");
    const updated = await app.withTenant(B.tenantId, (q) =>
      q.execute("UPDATE money_actions SET check_count = 1 WHERE id = CAST($1 AS uuid)", [action.id]),
    );
    expect(updated).toBe(0);
  });

  it("refuses an approver from another tenant (composite foreign key)", async () => {
    const theirApproval = await app.withTenant(B.tenantId, (q) => approvalFrom(q, B.session));
    const work = inA((q) => reserve(q, theirApproval, draft()));
    expect(await sqlStateOf(work)).toBe("23503");
  });

  it("finds no membership for another tenant's person", async () => {
    await expect(inA((q) => approvalFrom(q, B.session))).rejects.toThrow(ForbiddenError);
    await expect(
      inA((q) => approvalFrom(q, { ...A.session, tenantId: B.tenantId })),
    ).rejects.toThrow(ForbiddenError);
    expect(await inA((q) => readTenantZone(q))).toBe("America/Chicago");
  });
});

describe("the trigger", () => {
  // Each attempt in its own transaction: a raise rolls it back.
  const tryA = (sql: string, params: (string | number)[]) =>
    sqlStateOf(inA((q) => q.execute(sql, params)));
  const upd = (set: string, id: string) =>
    tryA(`UPDATE money_actions SET ${set} WHERE id = CAST($1 AS uuid)`, [id]);

  it("refuses a new row that is not a bare reservation", async () => {
    const id = randomUUID();
    const work = tryA(
      `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id,
         idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id,
         proposed_by, approver_membership_id, state, sent_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'advance_payout', 'payment', 'advances',
         CAST($2 AS uuid), $3, $4, 100, 'drivers', CAST($5 AS uuid), 'person', CAST($6 AS uuid),
         'sent', now())`,
      [id, advance, `advance_payout:${advance}:1`, id.replace(/-/g, ""), A.driverId, A.memberId],
    );
    expect(await work).toBe("23514");
  });

  it("refuses every move the state machine does not allow", async () => {
    const { action } = await reserveA();
    const id = action.id;
    const confirm = `state = 'confirmed', settled_at = now(), outside_system = 'mock',
      outside_type = 'payout', outside_id = 'mock_1', outside_amount_cents = amount_cents`;
    // From reserved.
    expect(await upd(`${confirm}, settled_via = 'response', sent_at = now()`, id)).toBe("23514");
    expect(await upd("state = 'unknown', sent_at = now()", id)).toBe("23514");
    expect(
      await upd("state = 'failed', settled_at = now(), settled_via = 'response', failure_category = 'auth'", id),
    ).toBe("23514");
    // What was approved never changes.
    expect(await upd("amount_cents = amount_cents + 1", id)).toBe("23514");
    expect(await upd(`counterparty_id = CAST('${A.otherDriverId}' AS uuid)`, id)).toBe("23514");
    expect(await upd("proposed_by = 'person'", id)).toBe("23514");

    // To sent, then not back, and sent_at fixed.
    expect(await inA((q) => markSent(q, id))).toBe(true);
    expect(await upd("state = 'reserved'", id)).toBe("23514");
    expect(await upd("sent_at = sent_at - interval '1 hour'", id)).toBe("23514");

    // To unknown; only a read-back settles it.
    expect(await inA((q) => settle(q, id, { to: "unknown", category: "timeout" }))).toBe(true);
    expect(await upd(`${confirm}, settled_via = 'response'`, id)).toBe("23514");
    expect(
      await upd("state = 'failed', settled_at = now(), settled_via = 'response', failure_category = 'auth'", id),
    ).toBe("23514");
    expect(await inA((q) => bumpCheck(q, id, "network"))).toBe(true);
    expect(await upd("check_count = 0", id)).toBe("23514");
    expect(
      await inA((q) =>
        settle(q, id, { to: "confirmed", via: "read_back", outside: { ...OUTSIDE, amountCents: 25_000 } }),
      ),
    ).toBe(true);

    // Settled is final.
    const done = await inA((q) => mustReadAction(q, id));
    expect(done).toMatchObject({
      state: "confirmed",
      settledVia: "read_back",
      checkCount: 2,
      failureCategory: null,
      outsideAmountCents: 25_000,
    });
    expect(await upd("outside_ref = 'X1'", id)).toBe("23514");
    expect(await upd("state = 'unknown'", id)).toBe("23514");
    expect(await upd("check_count = check_count + 1", id)).toBe("23514");
  });

  it("refuses a confirmation for another amount (check constraint)", async () => {
    const { action } = await reserveA();
    await inA((q) => markSent(q, action.id));
    const work = inA((q) =>
      q.execute(
        `UPDATE money_actions SET state = 'confirmed', settled_at = now(), settled_via = 'response',
           outside_system = 'mock', outside_type = 'payout', outside_id = 'mock_1',
           outside_amount_cents = 1 WHERE id = CAST($1 AS uuid)`,
        [action.id],
      ),
    );
    expect(await sqlStateOf(work)).toBe("23514");
  });
});

describe("tenant removal", () => {
  it("takes the tenant's ledger rows with it (cascade through both foreign keys)", async () => {
    const C = await makeTenant(admin, `ledger-c-${randomUUID().slice(0, 8)}`);
    const theirs = await addAdvance(admin, C);
    await app.withTenant(C.tenantId, async (q) => {
      const approval = await approvalFrom(q, C.session);
      await reserve(q, approval, draft({ subjectId: theirs, counterpartyId: C.driverId }));
    });
    await dropTenant(admin, C);
    const left = await admin.withTenant(C.tenantId, (q) =>
      q.query<{ n: number }>(
        "SELECT count(*) AS n FROM money_actions WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(left).toEqual([{ n: 0 }]);
  });
});

describe("guarded writes and the pending read", () => {
  it("moves a row once: a second claim or settle changes nothing", async () => {
    const { action } = await reserveA();
    await inA(async (q) => {
      expect(await markSent(q, action.id)).toBe(true);
      expect(await markSent(q, action.id)).toBe(false);
      expect(
        await settle(q, action.id, { to: "failed", via: "refused", category: "disabled" }),
      ).toBe(false);
      const outside = { ...OUTSIDE, amountCents: 25_000 };
      expect(await settle(q, action.id, { to: "confirmed", via: "response", outside })).toBe(true);
      expect(await settle(q, action.id, { to: "confirmed", via: "response", outside })).toBe(false);
      expect(await bumpCheck(q, action.id, "unknown")).toBe(false);
    });
  });

  it("returns unknown rows and sent rows past the window, never fresh ones or rows at the limit", async () => {
    const sent = await reserveA();
    await inA((q) => markSent(q, sent.action.id));
    // A later transaction: the row was sent before this one's now().
    expect(await inA((q) => readPending(q, 120))).toEqual([]);
    const pending = await inA((q) => readPending(q, 0));
    expect(pending.map((a) => a.id)).toEqual([sent.action.id]);
    expect(pending[0].sentSecondsAgo).toBeGreaterThanOrEqual(0);

    await inA((q) => settle(q, sent.action.id, { to: "unknown", category: "timeout" }));
    expect((await inA((q) => readPending(q, 120))).map((a) => a.id)).toEqual([sent.action.id]);

    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE money_actions SET check_count = 49 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [sent.action.id],
      ),
    );
    expect(await inA((q) => bumpCheck(q, sent.action.id, "unknown"))).toBe(true);
    expect(await inA((q) => bumpCheck(q, sent.action.id, "unknown"))).toBe(false);
    expect(await inA((q) => readPending(q, 0))).toEqual([]);
    // Another tenant's pending read sees none of it.
    expect(await app.withTenant(B.tenantId, (q) => readPending(q, 0))).toEqual([]);
  });

  it("reads only the kinds asked for, never-checked rows first, so older rows cannot block a newer one", async () => {
    flags.accountingEnabled = true;
    // Each step in its own transaction, so sent_at and last_checked_at increase row by row.
    const sendRow = async (over: Partial<MoneyDraft>) => {
      const { action } = await reserveA(over);
      await inA((q) => markSent(q, action.id));
      return action.id;
    };
    const ids = (rows: MoneyAction[]) => rows.map((a) => a.id);
    const unserved: string[] = [];
    const checked: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const subject = await addAdvance(admin, A);
      // An accounting row left unknown and never checked: a kind the caller cannot serve.
      const expense = await sendRow({ kind: "advance_expense", subjectId: subject });
      await inA((q) => settle(q, expense, { to: "unknown", category: "timeout" }));
      unserved.push(expense);
      // An older payout checked once that read back nothing.
      const payout = await sendRow({ subjectId: subject });
      expect(await inA((q) => bumpCheck(q, payout, "unknown"))).toBe(true);
      checked.push(payout);
    }
    const newer = await sendRow({});
    await inA((q) => settle(q, newer, { to: "unknown", category: "timeout" }));

    // Every kind: the five never-checked accounting rows fill the page.
    expect(ids(await inA((q) => readPending(q, 0, 5)))).toEqual(unserved);
    // Payouts only: the never-checked newer row first, then the least recently checked.
    expect(ids(await inA((q) => readPending(q, 0, 5, ["advance_payout"])))).toEqual([
      newer,
      ...checked.slice(0, 4),
    ]);
    // A check moves a row behind the others.
    await inA((q) => bumpCheck(q, newer, "unknown"));
    await inA((q) => bumpCheck(q, checked[0], "unknown"));
    expect(ids(await inA((q) => readPending(q, 0, 5, ["advance_payout"])))).toEqual([
      ...checked.slice(1),
      newer,
    ]);
    // The kinds are checked whole before any SQL.
    await expect(inA((q) => readPending(q, 0, 5, []))).rejects.toBeInstanceOf(RangeError);
    await expect(
      inA((q) => readPending(q, 0, 5, ["advance" as MoneyActionKind])),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
