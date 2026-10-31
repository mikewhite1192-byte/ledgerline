import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { PaymentAdapter, ReadBack } from "../adapters/types";
import { readEngineProposalViews, readProposalViews } from "../agent/gateway/store/views";
import type { CompleteFn } from "../agent/gateway/types";
import type { AiResult } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import { readBreak, readLastSeenRunCents, readRun } from "../data/card-recon";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, Queryable, TenantDb } from "../db/types";
import { deskHandlers } from "../desk/handlers";
import { eventKey } from "../desk/keys";
import { readSentInWindow } from "../money/read";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal } from "../proposals/execute";
import { SEVERITY_OF, fingerprintOf, sentInWindow, type BreakCategory } from "../rules-engine/card-recon";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { instantAt } from "../seed/calendar";
import {
  MAX_LEDGER_ROWS,
  WRITE_BATCH,
  advanceCardCheck,
  dismissBreak,
  startCardCheck,
  statementVerdict,
  type CardCheckDeps,
} from "./run";
import { readHandPick, verdictLine } from "./view";

// The card check against the real database, as the app's role: the seeded statement compared with
// the seeded records, payment records read back through a stand-in adapter, one sentence and one
// pick per difference through a stand-in model call (no network, no spend), and the match card
// approved through the real gate and executor. One tenant seeded with the demo plan under its own
// slug, removed after; every test starts with no check, no difference and no match card.

const ANCHOR = "2026-11-02";
const CARRIER = { ...DEMO_CARRIERS[0], slug: "card-recon-test", name: "Card Recon Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const planted = plan.planted.cardRecon;
const NOW = new Date(instantAt(ANCHOR, 12, 0, CARRIER.timezone));
const clock = () => NOW;
const SLICE = 20_000;
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@card-recon-test.example", tenantId: T };
const SENT_AT = "2026-10-30T15:00:00.000Z";
const saved = { ...flags, cardRecon: { ...flags.cardRecon, limits: { ...flags.cardRecon.limits } } };

let admin: Db;
let app: Db;
let memberId: string;
let other: Fixture;

// ---- The stand-ins ----

const calls: { purpose: string }[] = [];

function answer(text: string): AiResult {
  return {
    callId: randomUUID(),
    status: "ok",
    text,
    toolCalls: [],
    usage: { input: 100, cached: 0, output: 20, reasoning: 0 },
    costNanocents: NANOCENTS_PER_CENT,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

// The sentence names no figure; the pick is the first driver code ranked.
const complete: CompleteFn = async (_target, request) => {
  calls.push({ purpose: request.purpose });
  if (request.purpose === "card_recon_explain") {
    return answer(JSON.stringify({ sentence: "The card provider and our records differ here." }));
  }
  const user = request.messages.find((m) => m.role === "user");
  const facts = JSON.parse(String(user?.content)) as { candidates: { driverCode: string }[] };
  return answer(JSON.stringify({ driverCode: facts.candidates[0].driverCode, reasons: ["on_load_in_state"] }));
};

// A payment rail that only reads back: the answer is set per test, and a send fails the test.
let readBackAnswer: () => Promise<ReadBack> = async () => ({ found: false });
const sends: unknown[] = [];
const payment: PaymentAdapter = {
  system: "mock",
  ready: async () => ({ ok: true }),
  sendPayout: async (p) => {
    sends.push(p);
    throw new Error("the card check never sends");
  },
  readBack: async () => readBackAnswer(),
};

const deps = (over: CardCheckDeps = {}): CardCheckDeps => ({
  db: app,
  clock,
  complete,
  money: { payment, log: () => undefined },
  ...over,
});

async function runToEnd(d: CardCheckDeps = deps(), max = 40) {
  const s = await startCardCheck(SESSION, d);
  if (!s.ok) throw new Error(`start refused: ${s.category}`);
  // Each slice's deadline counts from the check's own clock, so a test can move the check's day.
  const at = (d.clock ?? clock)().getTime();
  for (let i = 0; i < max; i++) {
    const a = await advanceCardCheck(SESSION, s.runId, at + SLICE, d);
    if (!a.ok) throw new Error(`advance refused: ${a.category}`);
    if (a.run.status !== "running") return a.run;
  }
  throw new Error("the check did not finish");
}

// ---- Reads ----

type BreakRow = {
  id: string;
  category: string;
  status: string;
  card_transaction_id: string | null;
  money_action_id: string | null;
  fix_kind: string;
  proposal_id: string | null;
  explanation: string | null;
  our_cents: string | null;
  outside_cents: string | null;
  first_seen_run_id: string;
  last_seen_run_id: string;
  fingerprint: string;
};

async function breaks(): Promise<BreakRow[]> {
  return admin.withTenant(T, (q) =>
    q.query<BreakRow>(
      `SELECT CAST(id AS text) AS id, category, status, CAST(card_transaction_id AS text) AS card_transaction_id,
              CAST(money_action_id AS text) AS money_action_id, fix_kind, CAST(proposal_id AS text) AS proposal_id,
              explanation, CAST(our_cents AS text) AS our_cents, CAST(outside_cents AS text) AS outside_cents,
              CAST(first_seen_run_id AS text) AS first_seen_run_id, CAST(last_seen_run_id AS text) AS last_seen_run_id,
              fingerprint
         FROM card_recon_breaks WHERE tenant_id = current_tenant_id() ORDER BY category, id`,
    ),
  );
}

const byTxn = (rows: BreakRow[], id: string) => rows.filter((b) => b.card_transaction_id === id);

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await admin.withTenant(T, (q) => q.query<{ n: string }>(sql, params as never[]));
  return Number(rows[0].n);
}

async function proposalStatus(id: string): Promise<string> {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ status: string }>("SELECT status FROM proposals WHERE id = CAST($1 AS uuid)", [id]),
  );
  return rows[0].status;
}

// ---- Payment records written the way the ledger writes them: reserved, sent, then settled ----

type Pick = { advanceId: string; driverId: string; amountCents: number };
let picks: Pick[] = [];
const madeActions: string[] = [];

async function ledgerRow(p: Pick, to: "unknown" | "confirmed"): Promise<string> {
  const id = randomUUID();
  madeActions.push(id);
  await admin.withTenant(T, async (q) => {
    await q.execute(
      `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, idempotency_key,
         request_id, amount_cents, counterparty_table, counterparty_id, proposed_by, approver_membership_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'advance_payout', 'payment', 'advances', CAST($2 AS uuid), $3,
         $4, $5, 'drivers', CAST($6 AS uuid), 'person', CAST($7 AS uuid))`,
      [id, p.advanceId, `advance_payout:${p.advanceId}:1`, id.replace(/-/g, ""), p.amountCents, p.driverId, memberId],
    );
    await q.execute("UPDATE money_actions SET state = 'sent', sent_at = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)", [
      id,
      SENT_AT,
    ]);
    if (to === "unknown") {
      await q.execute("UPDATE money_actions SET state = 'unknown', failure_category = 'timeout' WHERE id = CAST($1 AS uuid)", [id]);
    } else {
      await q.execute(
        `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = CAST($2 AS timestamptz),
                outside_system = 'mock', outside_type = 'payout', outside_id = $3, outside_amount_cents = amount_cents
          WHERE id = CAST($1 AS uuid)`,
        [id, SENT_AT, `po_${id.slice(0, 8)}`],
      );
    }
  });
  return id;
}

// n payment records sent at one instant and never settled, each for its own made-up advance: the
// bulk a check's read limit is measured against. A sent record is clean to the check, so none of
// them makes a difference of its own. Given another end state, each then settles the way
// ledgerRow settles one: unknown (a difference of its own) or confirmed (left for the read step).
async function sentRows(n: number, sentAt: string, to: "sent" | "unknown" | "confirmed" = "sent"): Promise<string[]> {
  const ids = await admin.withTenant(T, async (q) => {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, idempotency_key,
         request_id, amount_cents, counterparty_table, counterparty_id, proposed_by, approver_membership_id)
       SELECT g.id, current_tenant_id(), 'advance_payout', 'payment', 'advances', g.subject_id,
              'advance_payout:' || CAST(g.subject_id AS text) || ':1', replace(CAST(g.id AS text), '-', ''),
              100, 'drivers', CAST($2 AS uuid), 'person', CAST($3 AS uuid)
         FROM (SELECT gen_random_uuid() AS id, gen_random_uuid() AS subject_id
                 FROM generate_series(1, CAST($1 AS integer))) AS g
       RETURNING CAST(id AS text) AS id`,
      [n, picks[0].driverId, memberId],
    );
    const made = rows.map((r) => r.id);
    madeActions.push(...made);
    await q.execute(
      `UPDATE money_actions SET state = 'sent', sent_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id()
          AND id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)`,
      [JSON.stringify(made), sentAt],
    );
    const these = `tenant_id = current_tenant_id()
          AND id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)`;
    if (to === "unknown") {
      await q.execute(`UPDATE money_actions SET state = 'unknown', failure_category = 'timeout' WHERE ${these}`, [
        JSON.stringify(made),
      ]);
    } else if (to === "confirmed") {
      await q.execute(
        `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = CAST($2 AS timestamptz),
                outside_system = 'mock', outside_type = 'payout', outside_id = 'po_' || request_id,
                outside_amount_cents = amount_cents
          WHERE ${these}`,
        [JSON.stringify(made), sentAt],
      );
    }
    return made;
  });
  expect(ids).toHaveLength(n);
  return ids;
}

const LIMIT_LINE = { system: "payment_records", category: "too_many_records" };

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
  memberId = await admin.withTenant(T, async (q) => {
    await q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')",
      [SESSION.sub, SESSION.email],
    );
    const rows = await q.query<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
      [SESSION.sub],
    );
    return rows[0].id;
  });
  // Two seeded advances of two drivers who hold a default card; the card goes on the advance so a
  // read-back has the card it was paid to.
  picks = await admin.withTenant(T, async (q) => {
    const rows = await q.query<{ advance_id: string; driver_id: string; amount_cents: string; card_id: string }>(
      `SELECT DISTINCT ON (a.driver_id) CAST(a.id AS text) AS advance_id, CAST(a.driver_id AS text) AS driver_id,
              CAST(a.amount_cents AS text) AS amount_cents, CAST(c.id AS text) AS card_id
         FROM advances a
         JOIN driver_cards c ON c.tenant_id = a.tenant_id AND c.driver_id = a.driver_id AND c.is_default AND c.status = 'active'
        WHERE a.tenant_id = current_tenant_id()
        ORDER BY a.driver_id, a.id
        LIMIT 2`,
    );
    for (const r of rows) {
      await q.execute("UPDATE advances SET card_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid)", [r.advance_id, r.card_id]);
    }
    return rows.map((r) => ({ advanceId: r.advance_id, driverId: r.driver_id, amountCents: Number(r.amount_cents) }));
  });
  other = await makeTenant(admin, `card-recon-other-${T.slice(0, 8)}`);
});

beforeEach(async () => {
  Object.assign(flags, saved, { cardRecon: { ...saved.cardRecon, enabled: true, limits: { ...saved.cardRecon.limits } } });
  flags.payoutsEnabled = false;
  flags.auditorRequired = false;
  calls.length = 0;
  sends.length = 0;
  readBackAnswer = async () => ({ found: false });
  await clearTenantAgent(admin, T);
  await admin.withTenant(T, async (q) => {
    await q.execute("DELETE FROM card_recon_breaks WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM card_recon_runs WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'card_match'");
    await q.execute(
      `DELETE FROM fuel_purchases WHERE tenant_id = current_tenant_id()
          AND purchase_ref = (SELECT provider_ref FROM card_transactions WHERE id = CAST($1 AS uuid))`,
      [planted.cardUnknownId],
    );
    await q.execute("DELETE FROM driver_cards WHERE tenant_id = current_tenant_id() AND source = 'recon'");
    await q.execute(
      `DELETE FROM driver_cards WHERE tenant_id = current_tenant_id()
          AND provider_token = (SELECT card_token FROM card_transactions WHERE id = CAST($1 AS uuid))`,
      [planted.cardUnknownId],
    );
    await q.execute(
      `DELETE FROM money_actions WHERE tenant_id = current_tenant_id()
          AND id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)`,
      [JSON.stringify(madeActions)],
    );
  });
});

afterAll(async () => {
  Object.assign(flags, saved);
  if (admin) {
    await clearTenantAgent(admin, T).catch(() => undefined);
    await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    await dropTenant(admin, other);
  }
  await app?.close();
  await admin?.close();
});

describe("a card check of the seeded statement", () => {
  it("finds each planted difference once, explains each, and makes one match card for the unknown card", async () => {
    expect(planted.candidateDriverId).not.toBeNull();
    const run = await runToEnd();
    expect(run.status).toBe("done");
    expect(run.counts.statement).toBe(plan.rows.card_transactions.length);
    const rows = await breaks();
    const open = rows.filter((b) => b.status === "open");
    expect(byTxn(open, planted.fuelAmountDiffersId).map((b) => b.category)).toEqual(["fuel_amount_differs"]);
    expect(byTxn(open, planted.purchaseNotRecordedId).map((b) => b.category)).toEqual(["purchase_not_recorded"]);
    expect(byTxn(open, planted.loadNotInLedgerId).map((b) => b.category)).toEqual(["load_not_in_ledger"]);
    const unknown = byTxn(open, planted.cardUnknownId);
    expect(unknown.map((b) => [b.category, b.fix_kind])).toEqual([["card_unknown", "card_match"]]);
    expect(open.length).toBe(4);
    // Whole cents on both sides; the fuel gap is the planted one.
    const fuel = byTxn(open, planted.fuelAmountDiffersId)[0];
    expect(Number(fuel.outside_cents) - Number(fuel.our_cents)).toBe(340);
    // One sentence per difference and one pick, all counted against the run's cap.
    expect(open.every((b) => b.explanation === "The card provider and our records differ here.")).toBe(true);
    expect(calls.filter((c) => c.purpose === "card_recon_explain").length).toBe(4);
    expect(calls.filter((c) => c.purpose === "card_recon_match").length).toBe(1);
    expect(run.modelCents).toBe(5);
    // The match card names the planted candidate and never the card's token.
    const card = await admin.withTenant(T, (q) =>
      q.query<{ id: string; args: string; subject_id: string; amount_cents: string; status: string }>(
        `SELECT CAST(id AS text) AS id, CAST(args AS text) AS args, CAST(subject_id AS text) AS subject_id,
                CAST(amount_cents AS text) AS amount_cents, status
           FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'card_match'`,
      ),
    );
    expect(card.length).toBe(1);
    expect(card[0].id).toBe(unknown[0].proposal_id);
    expect(card[0].subject_id).toBe(planted.cardUnknownId);
    expect(card[0].status).toBe("proposed");
    expect(JSON.parse(card[0].args).driverId).toBe(planted.candidateDriverId);
    const token = plan.rows.card_transactions.find((t) => t.id === planted.cardUnknownId)?.card_token;
    expect(token).toBeTruthy();
    expect(card[0].args).not.toContain(String(token));
  });

  it("keeps the same differences on a second check: no new rows, no second card, no second sentence", async () => {
    await runToEnd();
    const first = await breaks();
    calls.length = 0;
    const again = await runToEnd();
    const second = await breaks();
    expect(second.map((b) => [b.id, b.fingerprint, b.first_seen_run_id, b.status])).toEqual(
      first.map((b) => [b.id, b.fingerprint, b.first_seen_run_id, b.status]),
    );
    expect(second.every((b) => b.last_seen_run_id === again.id)).toBe(true);
    expect(calls).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'card_match'")).toBe(1);
  });

  it("carries a check on across slices and lets only one worker hold it", async () => {
    const s = await startCardCheck(SESSION, deps());
    if (!s.ok) throw new Error("start refused");
    // No time left: the slice does nothing and hands the lease back.
    const idle = await advanceCardCheck(SESSION, s.runId, NOW.getTime(), deps());
    expect(idle.ok && idle.run.status).toBe("running");
    expect(calls).toEqual([]);
    // Another worker holds the lease: this one reads where it is and does no work.
    await admin.withTenant(T, (q) =>
      q.execute(
        "UPDATE card_recon_runs SET lease_token = CAST($2 AS uuid), lease_until = CAST($3 AS timestamptz) WHERE id = CAST($1 AS uuid)",
        [s.runId, randomUUID(), new Date(NOW.getTime() + 30_000).toISOString()],
      ),
    );
    const busy = await advanceCardCheck(SESSION, s.runId, NOW.getTime() + SLICE, deps());
    expect(busy.ok && busy.run.status).toBe("running");
    expect(calls).toEqual([]);
    // A second press while it runs carries the same check on, never a second one.
    const again = await startCardCheck(SESSION, deps());
    expect(again).toEqual({ ok: true, runId: s.runId, resumed: true });
    // The lease runs out; the next slice finishes it.
    await admin.withTenant(T, (q) =>
      q.execute("UPDATE card_recon_runs SET lease_until = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)", [
        s.runId,
        NOW.toISOString(),
      ]),
    );
    let status = "running";
    for (let i = 0; i < 40 && status === "running"; i++) {
      const a = await advanceCardCheck(SESSION, s.runId, NOW.getTime() + SLICE, deps());
      if (!a.ok) throw new Error(a.category);
      status = a.run.status;
    }
    expect(status).toBe("done");
  });

  it("writes plain sentences from code once the run's model cap is spent", async () => {
    flags.cardRecon.limits.maxRunCents = 3;
    const run = await runToEnd();
    expect(run.modelCents).toBeLessThanOrEqual(3);
    const open = (await breaks()).filter((b) => b.status === "open");
    expect(open.filter((b) => b.explanation !== null).length).toBe(1);
    // No pick past the cap either: the unknown card is fixed by hand.
    expect(byTxn(open, planted.cardUnknownId)[0].fix_kind).toBe("by_hand");
    expect(calls.filter((c) => c.purpose === "card_recon_match")).toEqual([]);
  });

  it("shows the unknown card's page the ranked drivers and the spent budget, to this carrier only", async () => {
    flags.cardRecon.limits.maxRunCents = 3;
    await runToEnd();
    const id = byTxn(await breaks(), planted.cardUnknownId)[0].id;
    const pick = await app.withTenant(T, async (q) => {
      const brk = await readBreak(q, id);
      return brk ? readHandPick(q, brk) : null;
    });
    expect(pick?.why).toBe("budget");
    expect(pick?.candidates[0].driverId).toBe(planted.candidateDriverId);
    expect(pick?.candidates.length).toBeLessThanOrEqual(3);
    expect(await app.withTenant(other.tenantId, (q) => readLastSeenRunCents(q, id))).toBeNull();
    expect(await app.withTenant(other.tenantId, (q) => readBreak(q, id))).toBeNull();
  });
});

describe("approving the match card", () => {
  async function matchCard(): Promise<string> {
    await runToEnd();
    const unknown = byTxn(await breaks(), planted.cardUnknownId)[0];
    expect(unknown.proposal_id).not.toBeNull();
    return String(unknown.proposal_id);
  }
  const approve = (id: string) => executeProposal(SESSION, id, { confirmed: true }, { db: app, clock });
  const token = () => String(plan.rows.card_transactions.find((t) => t.id === planted.cardUnknownId)?.card_token);

  it("refuses as stale when the card reached a driver's file since, and writes nothing", async () => {
    const id = await matchCard();
    const otherDriver = plan.rows.drivers.find((d) => d.id !== planted.candidateDriverId);
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO driver_cards (id, tenant_id, driver_id, provider, provider_token, last4, status, sim_behavior, source, is_default)
         VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'fuel_card_sim', $2, '0000', 'active', 'ok', 'ui', false)`,
        [String(otherDriver?.id), token()],
      ),
    );
    expect(await approve(id)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalStatus(id)).toBe("proposed");
    expect(await count("SELECT count(*) AS n FROM driver_cards WHERE tenant_id = current_tenant_id() AND source = 'recon'")).toBe(0);
  });

  it("puts the card on the driver's file and records the purchase, once, and closes the difference", async () => {
    const id = await matchCard();
    const done = await approve(id);
    expect(done).toMatchObject({ ok: true, status: "done", moneyActionId: null });
    expect(await approve(id)).toMatchObject({ ok: false });
    expect(
      await count(
        `SELECT count(*) AS n FROM driver_cards WHERE tenant_id = current_tenant_id() AND provider_token = $1
            AND source = 'recon' AND driver_id = CAST($2 AS uuid) AND NOT is_default AND holder_kind = 'generic'`,
        [token(), planted.candidateDriverId],
      ),
    ).toBe(1);
    const ref = plan.rows.card_transactions.find((t) => t.id === planted.cardUnknownId)?.provider_ref;
    expect(
      await count(
        `SELECT count(*) AS n FROM fuel_purchases WHERE tenant_id = current_tenant_id() AND purchase_ref = $1
            AND driver_id = CAST($2 AS uuid) AND paid_with = 'company_card' AND amount_cents = $3`,
        [ref, planted.candidateDriverId, 21_240],
      ),
    ).toBe(1);
    expect(byTxn(await breaks(), planted.cardUnknownId)[0].status).toBe("resolved");
    // No money moved and nothing was sent.
    expect(sends).toEqual([]);
    // The next check finds the purchase on file: the difference stays closed and nothing reopens.
    await runToEnd();
    const after = byTxn(await breaks(), planted.cardUnknownId);
    expect(after.map((b) => b.status)).toEqual(["resolved"]);
  });

  it("shows the person who approves it the card's last four, the day and the driver picked", async () => {
    const id = await matchCard();
    const txn = plan.rows.card_transactions.find((t) => t.id === planted.cardUnknownId);
    const code = plan.rows.drivers.find((d) => d.id === planted.candidateDriverId)?.code;
    expect(txn && code).toBeTruthy();
    const [onPage, byId] = await app.withTenant(T, async (q) => [
      await readEngineProposalViews(q, "card_match", 5, planted.cardUnknownId),
      await readProposalViews(q, [id]),
    ]);
    for (const views of [onPage, byId]) {
      expect(views.map((v) => v.id)).toEqual([id]);
      expect(views[0].cardMatch).toMatchObject({ last4: txn?.card_last4, postedOn: txn?.posted_on, driverCode: code });
    }
  });

  it("refuses as stale once a person dismissed its difference, waiting or approved, and writes nothing", async () => {
    const id = await matchCard();
    const unknown = byTxn(await breaks(), planted.cardUnknownId)[0];
    expect(await dismissBreak(SESSION, unknown.id, "explained", { db: app, clock })).toEqual({ ok: true });
    // Still waiting: the gate's early check refuses it and the card stays as it was.
    expect(await approve(id)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalStatus(id)).toBe("proposed");
    // Approved before the dismissal landed (a resume): the executor refuses it and fails the card.
    await admin.withTenant(T, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz)
          WHERE id = CAST($1 AS uuid)`,
        [id, SESSION.sub, NOW.toISOString()],
      ),
    );
    expect(await approve(id)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalStatus(id)).toBe("failed");
    const ref = plan.rows.card_transactions.find((t) => t.id === planted.cardUnknownId)?.provider_ref;
    expect(await count("SELECT count(*) AS n FROM driver_cards WHERE tenant_id = current_tenant_id() AND source = 'recon'")).toBe(0);
    expect(
      await count("SELECT count(*) AS n FROM fuel_purchases WHERE tenant_id = current_tenant_id() AND purchase_ref = $1", [ref]),
    ).toBe(0);
    expect(byTxn(await breaks(), planted.cardUnknownId).map((b) => b.status)).toEqual(["dismissed"]);
  });

  it("refuses while the card check is switched off, before anything is read", async () => {
    const id = await matchCard();
    flags.cardRecon.enabled = false;
    expect(await approve(id)).toMatchObject({ ok: false, category: "not_executable" });
    expect(await proposalStatus(id)).toBe("proposed");
  });
});

describe("payment records read back", () => {
  it("lists a record not confirmed yet without reading it, and a switched-off rail as not connected", async () => {
    const unknown = await ledgerRow(picks[0], "unknown");
    const confirmed = await ledgerRow(picks[1], "confirmed");
    const run = await runToEnd();
    const rows = (await breaks()).filter((b) => b.money_action_id !== null);
    expect(rows.map((b) => [b.money_action_id, b.category, b.fix_kind])).toEqual([[unknown, "not_confirmed", "check_pending"]]);
    expect(run.counts.records).toBe(2);
    expect(run.unchecked).toContainEqual({ system: "mock", category: "not_connected" });
    expect(rows.some((b) => b.money_action_id === confirmed)).toBe(false);
    expect(sends).toEqual([]);
  });

  it("flags an amount the rail reads back differently, keeps it through a failed read, and closes it on a match", async () => {
    flags.payoutsEnabled = true;
    const p = picks[1];
    const id = await ledgerRow(p, "confirmed");
    const read = (amountCents: number): ReadBack => ({
      found: true,
      system: "mock",
      type: "payout",
      id: `po_${id.slice(0, 8)}`,
      amountCents,
      status: "succeeded",
    });
    readBackAnswer = async () => read(p.amountCents + 1);
    await runToEnd();
    const differs = (await breaks()).filter((b) => b.money_action_id === id);
    expect(differs.map((b) => [b.category, b.status, Number(b.our_cents), Number(b.outside_cents)])).toEqual([
      ["amount_differs_outside", "open", p.amountCents, p.amountCents + 1],
    ]);
    // A read that throws is unknown: listed as not checked, and the difference stays open.
    readBackAnswer = async () => {
      throw new Error("rail down");
    };
    const failed = await runToEnd();
    expect(failed.unchecked.length).toBeGreaterThan(0);
    expect((await breaks()).filter((b) => b.money_action_id === id).map((b) => b.status)).toEqual(["open"]);
    // The rail now agrees to the cent: the difference closes.
    readBackAnswer = async () => read(p.amountCents);
    const clean = await runToEnd();
    expect((await breaks()).filter((b) => b.money_action_id === id).map((b) => b.status)).toEqual(["resolved"]);
    expect(clean.counts.recordsClean).toBe(1);
    expect(sends).toEqual([]);
  });
});

describe("which payment records a check reads", () => {
  // The carrier is in New York and the check runs on 2026-11-02, so its window is 2026-10-19 to
  // 2026-11-02 local: from 2026-10-19 04:00 UTC (daylight time) up to 2026-11-03 05:00 UTC
  // (standard time, after the clocks went back on 2026-11-01).
  const zone = CARRIER.timezone;

  it("checks every record in the window when a thousand were sent just before it and a thousand after", async () => {
    expect(zone).toBe("America/New_York");
    // 22:00 local on the day before the window, which a read from that day's UTC midnight meets first.
    await sentRows(MAX_LEDGER_ROWS, "2026-10-19T02:00:00.000Z");
    // 01:00 local on the day after the window.
    await sentRows(MAX_LEDGER_ROWS, "2026-11-03T06:00:00.000Z");
    const inside = [
      ...(await sentRows(1, "2026-10-19T04:00:00.000Z")), // 00:00 on the window's first day
      ...(await sentRows(1, "2026-10-30T15:00:00.000Z")),
      ...(await sentRows(1, "2026-11-03T04:59:59.999Z")), // 23:59:59.999 on its last day
    ];
    const run = await runToEnd();
    expect([run.windowFrom, run.windowTo]).toEqual(["2026-10-19", "2026-11-02"]);
    expect(run.counts.records).toBe(inside.length);
    expect(run.unchecked).not.toContainEqual(LIMIT_LINE);
    const read = await app.withTenant(T, (q) => readSentInWindow(q, run.windowFrom, run.windowTo, zone, MAX_LEDGER_ROWS));
    expect(read.map((a) => a.id)).toEqual(inside);
  }, 60_000);

  it("still says the limit was reached when the window itself holds more records than one check reads", async () => {
    await sentRows(MAX_LEDGER_ROWS + 1, "2026-10-30T15:00:00.000Z");
    const run = await runToEnd();
    expect(run.counts.records).toBe(MAX_LEDGER_ROWS);
    expect(run.unchecked).toContainEqual(LIMIT_LINE);
  }, 60_000);

  it("writes a full window's records a set at a time, leaving what one record at a time left", async () => {
    // More than one statement's worth of each kind: not confirmed yet (a difference of its own),
    // sent and not settled (clean), and confirmed (left for the read step).
    const unknown = await sentRows(2 * WRITE_BATCH + 1, SENT_AT, "unknown");
    const sent = await sentRows(WRITE_BATCH + 1, SENT_AT);
    const confirmed = await sentRows(WRITE_BATCH + 1, SENT_AT, "confirmed");
    const fp = (category: BreakCategory, id: string) =>
      fingerprintOf({ category, cardTransactionId: null, moneyActionId: id, fuelPurchaseId: null });
    const OLD = "2026-10-20T12:00:00.000Z";
    const WAITING = "Still waiting on the rail.";
    type Earlier = { category: BreakCategory; id: string; status?: string; ourCents?: number; explanation?: string };
    // What an earlier check left on these records: the start reopens, keeps, resets or closes each.
    const earlier: Earlier[] = [
      { category: "not_confirmed", id: unknown[0], status: "dismissed" },
      { category: "not_confirmed", id: unknown[1], status: "resolved" },
      { category: "not_confirmed", id: unknown[2], explanation: WAITING },
      { category: "not_confirmed", id: unknown[3], ourCents: 99, explanation: WAITING },
      ...unknown.map((id) => ({ category: "amount_differs_outside" as const, id })),
      ...sent.map((id) => ({ category: "missing_outside" as const, id })),
      { category: "pending_outside", id: sent[0], status: "dismissed" },
      ...confirmed.map((id) => ({ category: "not_confirmed" as const, id })),
      ...confirmed.map((id) => ({ category: "amount_differs_outside" as const, id })),
    ];
    const plant = async (q: Queryable, run: string, member: string, rows: Earlier[]) => {
      await q.execute(
        `INSERT INTO card_recon_runs (id, tenant_id, membership_id, status, phase, window_from, window_to,
           started_at, finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'done', 'done', CAST('2026-10-06' AS date),
           CAST('2026-10-20' AS date), CAST($3 AS timestamptz), CAST($3 AS timestamptz))`,
        [run, member, OLD],
      );
      await q.execute(
        `INSERT INTO card_recon_breaks (id, tenant_id, fingerprint, category, severity, outside_system,
           money_action_id, our_cents, explanation, fix_kind, status, dismiss_category, first_seen_run_id,
           last_seen_run_id, resolved_at, created_at, updated_at)
         SELECT gen_random_uuid(), current_tenant_id(), r.fingerprint, r.category, r.severity, 'mock',
                r.money_action_id, r.our_cents, r.explanation, 'by_hand', r.status,
                CASE WHEN r.status = 'dismissed' THEN 'other' END, CAST($2 AS uuid), CAST($2 AS uuid),
                CASE WHEN r.status = 'open' THEN NULL ELSE CAST($3 AS timestamptz) END,
                CAST($3 AS timestamptz), CAST($3 AS timestamptz)
           FROM jsonb_to_recordset(CAST($1 AS jsonb))
             AS r(fingerprint text, category text, severity text, money_action_id uuid, our_cents bigint,
                  explanation text, status text)`,
        [
          JSON.stringify(
            rows.map((b) => ({
              fingerprint: fp(b.category, b.id),
              category: b.category,
              severity: SEVERITY_OF[b.category],
              money_action_id: b.id,
              our_cents: b.ourCents ?? 100,
              explanation: b.explanation ?? null,
              status: b.status ?? "open",
            })),
          ),
          run,
          OLD,
        ],
      );
    };
    const before = randomUUID();
    await admin.withTenant(T, (q) => plant(q, before, memberId, earlier));
    // Another carrier's break that names one of these records: never this carrier's to close.
    const theirRun = randomUUID();
    await admin.withTenant(other.tenantId, (q) =>
      plant(q, theirRun, other.memberId, [{ category: "not_confirmed", id: confirmed[0] }]),
    );
    // The app's database, counting the statements the start sends.
    let statements = 0;
    const db: TenantDb = {
      withTenant<R>(tenantId: string, fn: (q: Queryable) => Promise<R>): Promise<R> {
        return app.withTenant(tenantId, (q) =>
          fn({
            query<Q>(sql: string, params?: Param[]) {
              statements += 1;
              return q.query<Q>(sql, params);
            },
            execute(sql: string, params?: Param[]) {
              statements += 1;
              return q.execute(sql, params);
            },
          }),
        );
      },
    };
    try {
      const s = await startCardCheck(SESSION, deps({ db }));
      if (!s.ok) throw new Error(`start refused: ${s.category}`);
      expect(s.resumed).toBe(false);
      // One record at a time, this start sent one or two statements per record (over 600); a set at
      // a time, a few per kind.
      expect(statements).toBeLessThan(30);
      const run = await app.withTenant(T, (q) => readRun(q, s.runId));
      expect(run?.counts).toMatchObject({
        records: unknown.length + sent.length + confirmed.length,
        recordBreaks: unknown.length,
      });
      const todo = await admin.withTenant(T, (q) =>
        q.query<{ todo: string }>("SELECT CAST(todo AS text) AS todo FROM card_recon_runs WHERE id = CAST($1 AS uuid)", [
          s.runId,
        ]),
      );
      expect([...(JSON.parse(todo[0].todo) as string[])].sort()).toEqual([...confirmed].sort());

      // Every break on these records, as one record at a time left it: each record not confirmed
      // yet has its one open difference (a dismissed one stays dismissed, a resolved one reopens,
      // its sentence kept unless an amount moved) and every other difference on it closed; each
      // clean record has every open difference closed; each confirmed record has only its "not
      // confirmed yet" closed.
      const want = (
        category: BreakCategory,
        id: string,
        status: string,
        o: { explanation?: string; fix?: string; first?: string; last?: string } = {},
      ) => [fp(category, id), status, o.explanation ?? null, "100", o.fix ?? "by_hand", o.first ?? before, o.last ?? before];
      const expected = [
        ...unknown.map((id, i) =>
          want("not_confirmed", id, i === 0 ? "dismissed" : "open", {
            explanation: i === 2 ? WAITING : undefined,
            fix: "check_pending",
            first: i < 4 ? before : s.runId,
            last: s.runId,
          }),
        ),
        ...unknown.map((id) => want("amount_differs_outside", id, "resolved")),
        ...sent.map((id) => want("missing_outside", id, "resolved")),
        want("pending_outside", sent[0], "dismissed"),
        ...confirmed.map((id) => want("not_confirmed", id, "resolved")),
        ...confirmed.map((id) => want("amount_differs_outside", id, "open")),
      ];
      const mine = new Set([...unknown, ...sent, ...confirmed]);
      const actual = (await breaks())
        .filter((b) => b.money_action_id !== null && mine.has(b.money_action_id))
        .map((b) => [b.fingerprint, b.status, b.explanation, b.our_cents, b.fix_kind, b.first_seen_run_id, b.last_seen_run_id]);
      const byPrint = (a: (string | null)[], b: (string | null)[]) => String(a[0]).localeCompare(String(b[0]));
      expect(actual.sort(byPrint)).toEqual(expected.sort(byPrint));
      // Each one closed now is closed at the start's time, and the reopened one is open again.
      const closedNow = await count(
        `SELECT count(*) AS n FROM card_recon_breaks
          WHERE tenant_id = current_tenant_id() AND status = 'resolved' AND resolved_at = CAST($1 AS timestamptz)`,
        [NOW.toISOString()],
      );
      expect(closedNow).toBe(unknown.length + sent.length + confirmed.length);
      const reopened = await count(
        `SELECT count(*) AS n FROM card_recon_breaks
          WHERE tenant_id = current_tenant_id() AND fingerprint = $1 AND status = 'open' AND resolved_at IS NULL`,
        [fp("not_confirmed", unknown[1])],
      );
      expect(reopened).toBe(1);
      // The other carrier's break is as it was.
      const theirs = await admin.withTenant(other.tenantId, (q) =>
        q.query<{ status: string; last: string }>(
          "SELECT status, CAST(last_seen_run_id AS text) AS last FROM card_recon_breaks WHERE tenant_id = current_tenant_id()",
        ),
      );
      expect(theirs).toEqual([{ status: "open", last: theirRun }]);
    } finally {
      await admin.withTenant(other.tenantId, async (q) => {
        await q.execute("DELETE FROM card_recon_breaks WHERE tenant_id = current_tenant_id()");
        await q.execute("DELETE FROM card_recon_runs WHERE tenant_id = current_tenant_id()");
      });
    }
  }, 60_000);

  it("puts a send on the local date it fell on when the clocks change, in the read and in the check", async () => {
    // Clocks go back at 02:00 on 2026-11-01 (a 25-hour day) and forward at 02:00 on 2027-03-14 (a
    // 23-hour day). Each pair is the last moment before the day and the first moment of it, then
    // the last moment of the day and the first moment after it.
    const fallBack = { start: "2026-11-01", end: "2026-11-01" };
    const springForward = { start: "2027-03-14", end: "2027-03-14" };
    const at = async (sentAt: string) => ({ id: (await sentRows(1, sentAt))[0], sentAt });
    const fb = [
      await at("2026-11-01T03:59:59.999Z"), // 2026-10-31 23:59:59.999 daylight time: before
      await at("2026-11-01T04:00:00.000Z"), // 2026-11-01 00:00 daylight time: in
      await at("2026-11-02T04:59:59.999Z"), // 2026-11-01 23:59:59.999 standard time: in
      await at("2026-11-02T05:00:00.000Z"), // 2026-11-02 00:00 standard time: after
    ];
    const sf = [
      await at("2027-03-14T04:59:59.999Z"), // 2027-03-13 23:59:59.999 standard time: before
      await at("2027-03-14T05:00:00.000Z"), // 2027-03-14 00:00 standard time: in
      await at("2027-03-15T03:59:59.999Z"), // 2027-03-14 23:59:59.999 daylight time: in
      await at("2027-03-15T04:00:00.000Z"), // 2027-03-15 00:00 daylight time: after
    ];
    for (const [window, rows] of [
      [fallBack, fb],
      [springForward, sf],
    ] as const) {
      const read = await app.withTenant(T, (q) => readSentInWindow(q, window.start, window.end, zone, MAX_LEDGER_ROWS));
      expect(read.map((a) => a.id)).toEqual([rows[1].id, rows[2].id]);
      // The read and the check's own filter agree on every send.
      for (const r of rows) {
        expect(sentInWindow(r.sentAt, zone, window)).toBe(read.some((a) => a.id === r.id));
      }
    }
    // A check on 2026-11-01 (window 2026-10-18 to 2026-11-01) counts the three fall-back sends up to
    // that day's last moment, and neither the one at midnight after it nor the spring ones.
    const noon = new Date(instantAt("2026-11-01", 12, 0, zone));
    const run = await runToEnd(deps({ clock: () => noon }));
    expect([run.windowFrom, run.windowTo]).toEqual(["2026-10-18", "2026-11-01"]);
    expect(run.counts.records).toBe(3);
  });

  it("refuses a window, zone or limit that is not well formed, before it reads", async () => {
    await app.withTenant(T, async (q) => {
      expect(() => readSentInWindow(q, "2026-11-02", "2026-11-01", zone, 10)).toThrow(RangeError);
      expect(() => readSentInWindow(q, "2026-11-1", "2026-11-02", zone, 10)).toThrow(RangeError);
      expect(() => readSentInWindow(q, "2026-11-01", "2026-11-02", "", 10)).toThrow(RangeError);
      expect(() => readSentInWindow(q, "2026-11-01", "2026-11-02", zone, 0)).toThrow(RangeError);
      expect(() => readSentInWindow(q, "2026-11-01", "2026-11-02", zone, 1001)).toThrow(RangeError);
    });
  });
});

describe("the statement's verdict", () => {
  const IN_WINDOW = `FROM card_transactions
    WHERE tenant_id = current_tenant_id() AND posted_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)`;
  const statementCents = (from: string, to: string) =>
    count(`SELECT coalesce(sum(amount_cents), 0) AS n ${IN_WINDOW}`, [from, to]);
  const statementLines = (from: string, to: string) => count(`SELECT count(*) AS n ${IN_WINDOW}`, [from, to]);

  it("holds on the planted differences by category, then is verified at the statement's total once each is closed", async () => {
    const first = await runToEnd();
    expect(statementVerdict(first)).toEqual({
      kind: "hold",
      breaks: 4,
      byCategory: [
        { category: "fuel_amount_differs", count: 1 },
        { category: "purchase_not_recorded", count: 1 },
        { category: "card_unknown", count: 1 },
        { category: "load_not_in_ledger", count: 1 },
      ],
      cut: false,
    });
    expect(verdictLine(first)).toMatch(/^Hold: 4 breaks on the statement: /);
    const total = await statementCents(first.windowFrom, first.windowTo);
    expect(total).toBeGreaterThan(0);
    expect(first.counts.statementCents).toBe(total);
    expect(first.counts.statementClosed).toBe(0);

    for (const b of (await breaks()).filter((x) => x.status === "open" && x.card_transaction_id !== null)) {
      expect(await dismissBreak(SESSION, b.id, "explained", { db: app, clock })).toEqual({ ok: true });
    }
    const verified = await runToEnd();
    const lines = await statementLines(verified.windowFrom, verified.windowTo);
    expect(lines).toBeGreaterThan(0);
    // Closed by a person, not matched: the line never says the card lines match.
    expect(statementVerdict(verified)).toEqual({ kind: "verified", cents: total, lines, closed: 4 });
    expect(verdictLine(verified)).toMatch(/ checked, 4 differences closed by a person\.$/);

    // The same window checked again: the same verdict, and no new difference.
    const before = await breaks();
    const again = await runToEnd();
    expect(statementVerdict(again)).toEqual(statementVerdict(verified));
    expect((await breaks()).map((b) => [b.id, b.status])).toEqual(before.map((b) => [b.id, b.status]));
    // Nothing was paid: the check made no payment record.
    expect(sends).toEqual([]);
  });

  it("names the verdict on the desk's line for a finished check, with nothing paid", async () => {
    const finished = await runToEnd();
    const subjectId = planted.fuelAmountDiffersId.toLowerCase();
    const out = await deskHandlers({ db: app }).card_transaction.run(
      SESSION,
      {
        eventKey: eventKey("card_transaction", subjectId),
        source: "card_transaction",
        subjectId,
        state: "carried",
        attempts: 1,
        carries: 1,
        threw: 0,
        runId: finished.id,
        found: null,
        firstAt: NOW.toISOString(),
      },
      { deadlineMs: NOW.getTime() + SLICE, clock },
    );
    expect(out).toEqual({
      outcome: "done",
      detail: {
        runId: finished.id,
        cents: finished.modelCents,
        found: Number(finished.counts.statementBreaks) + Number(finished.counts.recordBreaks),
        category: "statement_hold",
      },
    });
    expect(sends).toEqual([]);
  });
});

describe("dismissing and the switch", () => {
  it("closes an open difference with a reason, once, and a later check leaves it closed", async () => {
    await runToEnd();
    const target = byTxn(await breaks(), planted.fuelAmountDiffersId)[0];
    expect(await dismissBreak(SESSION, target.id, "made_up", { db: app, clock })).toEqual({ ok: false, category: "bad_request" });
    expect(await dismissBreak(SESSION, target.id, "explained", { db: app, clock })).toEqual({ ok: true });
    expect(await dismissBreak(SESSION, target.id, "explained", { db: app, clock })).toEqual({ ok: false, category: "not_found" });
    await runToEnd();
    expect(byTxn(await breaks(), planted.fuelAmountDiffersId).map((b) => b.status)).toEqual(["dismissed"]);
  });

  it("refuses every path while switched off, and a check of another carrier is not found", async () => {
    flags.cardRecon.enabled = false;
    expect(await startCardCheck(SESSION, deps())).toEqual({ ok: false, category: "disabled" });
    expect(await advanceCardCheck(SESSION, randomUUID(), NOW.getTime() + SLICE, deps())).toEqual({
      ok: false,
      category: "disabled",
    });
    expect(await dismissBreak(SESSION, randomUUID(), "explained", { db: app, clock })).toEqual({ ok: false, category: "disabled" });
    expect(await count("SELECT count(*) AS n FROM card_recon_runs WHERE tenant_id = current_tenant_id()")).toBe(0);
    flags.cardRecon.enabled = true;
    const s = await startCardCheck(SESSION, deps());
    if (!s.ok) throw new Error("start refused");
    expect(await advanceCardCheck(other.session, s.runId, NOW.getTime() + SLICE, deps())).toEqual({
      ok: false,
      category: "not_found",
    });
  });
});

describe("row security on the card check's tables", () => {
  it("shows another carrier none of this carrier's rows, and refuses a write into them", async () => {
    const mine = await runToEnd();
    const seen = await app.withTenant(other.tenantId, async (q) => {
      const out: number[] = [];
      for (const table of ["card_transactions", "card_recon_runs", "card_recon_breaks"]) {
        const rows = await q.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        out.push(Number(rows[0].n));
      }
      return out;
    });
    expect(seen).toEqual([0, 0, 0]);
    expect(await app.withTenant(other.tenantId, (q) => readRun(q, mine.id))).toBeNull();
    const write = app.withTenant(other.tenantId, (q) =>
      q.execute(
        `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
           posted_at, posted_on, amount_cents, state, gallons_milli, source)
         VALUES (gen_random_uuid(), CAST($1 AS uuid), 'fuel_card_sim', 'x-test-1', 'fuel', $3, '0000', 'TEST',
           CAST($2 AS timestamptz), CAST('2026-10-30' AS date), 100, 'OK', 1000, 'seed')`,
        [T, SENT_AT, `fcs_card_${"0".repeat(24)}`],
      ),
    );
    expect(await sqlStateOf(write)).toBe("42501");
  });
});
