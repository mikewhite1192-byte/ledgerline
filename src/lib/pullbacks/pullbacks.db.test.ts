import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createCardPuller } from "../adapters/payment/fuel-card-sim";
import type { CardPuller } from "../adapters/types";
import { takeBackAdvance } from "../advances/takeback";
import { cardPullbackLimit } from "../agent/gateway/limits";
import { dedupeKey } from "../agent/gateway/store/proposals";
import type { GatewayContext } from "../agent/gateway/types";
import { autopilotSession, autopilotSub } from "../autopilot/session";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addAdvance, clearLedger, dropTenant, makeTenant, setCardBehavior, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal } from "../proposals/execute";
import { checkPendingPull, type PullbackDeps } from "./execute";
import { planPull, type PullAsk, type PullPlanned } from "./facts";

// The card pull-back against a real database, as the app's own role, with the registered executor
// (EXECUTORS) and the simulated card provider (test mode; never a real card). The card's balance is
// ours: hand loads on the statement less its fuel and earlier pulls. A person's approval writes the
// one pull row and reserves the one ledger row before the one call, however many times it is
// pressed; a breakdown the card cannot cover books the rest as a named deficit; a take-back pulls
// what the card holds and records it on the advance, and the rest stays owed; a pull with no
// answer stays open until Check pending reads it back; the autopilot never runs one; a switch off
// refuses at every path; another carrier sees nothing. Every tenant made here is removed after
// each test.

const saved = structuredClone(flags);
// Monday November 2, 2026, 10:00 in Chicago (the fixture carrier's zone), the switch's start day.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let calls: number;
let puller: CardPuller;

function switchesOn() {
  flags.payoutsEnabled = true;
  flags.advancesEnabled = true;
  flags.advanceTakeback = { enabled: true, maxCents: 150_000 };
  flags.cardPullback = { enabled: true, startDate: "2026-11-02" };
}

// The simulated provider, counting its pulls (reads are not pulls).
function countingPuller(): CardPuller {
  const sim = createCardPuller({ log: () => {} });
  return {
    ...sim,
    pullBack: async (r, ctx) => {
      calls += 1;
      return sim.pullBack(r, ctx);
    },
  };
}

async function cardOf(f: Fixture, driverId: string): Promise<{ id: string; token: string; last4: string }> {
  const [c] = await admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; token: string; last4: string }>(
      `SELECT CAST(id AS text) AS id, provider_token AS token, last4 FROM driver_cards
        WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND is_default`,
      [driverId],
    ),
  );
  return c;
}

// A statement row on the driver's default card: a hand load or a fuel purchase.
async function post(f: Fixture, driverId: string, kind: "load" | "fuel", cents: number, on = "2026-10-30") {
  const card = await cardOf(f, driverId);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
         posted_at, posted_on, amount_cents, state, gallons_milli, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel_card_sim', $2, $3, $4, $5, 'TEST',
         CAST($6 AS timestamptz), CAST($6 AS date), CAST($7 AS bigint), $8, $9, 'seed', CAST($6 AS timestamptz))`,
      [
        randomUUID(),
        `fcs_${kind}_${randomBytes(12).toString("hex")}`,
        kind,
        card.token,
        card.last4,
        on,
        cents,
        kind === "fuel" ? "TX" : null,
        kind === "fuel" ? 12_500 : null,
      ],
    ),
  );
}

// A paid advance on the driver's default card, with no fee and nothing recovered yet.
async function paidAdvance(f: Fixture, cents: number): Promise<string> {
  const id = await addAdvance(admin, f, cents, "approved");
  const card = await cardOf(f, f.driverId);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE advances SET status = 'paid', paid_at = CAST('2026-11-01T15:00:00Z' AS timestamptz), card_id = CAST($2 AS uuid)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, card.id],
    ),
  );
  return id;
}

const planOf = async (ask: PullAsk, f: Fixture = A): Promise<PullPlanned> => {
  const facts = await app.withTenant(f.tenantId, (q) => planPull(q, ask, flags.advanceTakeback.maxCents, new Date(NOW)));
  if (!facts.ok) throw new Error(`no plan: ${facts.refusal}`);
  return facts.plan;
};

// A waiting card_pullback proposal shaped like the propose tool's: the plan as args, the driver
// (a breakdown) or the advance (a take-back) as the subject, the gateway's dedupe key and the
// auditor's pass. Written by the admin login so created_at and the verdict can be set.
async function addProposal(plan: PullPlanned, f: Fixture = A): Promise<string> {
  const args = { ...plan };
  const subjectTable = plan.advanceId === null ? "drivers" : "advances";
  const subjectId = plan.advanceId ?? plan.driverId;
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
      [conversation, f.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Just take it off the card', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_card_pullback',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
         created_at, updated_at, auditor_verdict, auditor_agrees, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'card_pullback',
         $4, CAST($5 AS uuid), $6, 'in', 'Pull money back off a fuel card', CAST($7 AS jsonb), 'not_given',
         CAST($8 AS uuid), $9, $10, CAST($11 AS timestamptz), CAST($11 AS timestamptz), 'pass', TRUE,
         CAST($11 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        subjectTable,
        subjectId,
        plan.requestedCents,
        JSON.stringify(args),
        decision,
        dedupeKey("card_pullback", subjectId, args),
        trace,
        created,
      ],
    );
  });
  return id;
}

const breakdown = (requestedCents: number, f: Fixture = A): PullAsk => ({
  driverId: f.driverId,
  advanceId: null,
  reason: "breakdown",
  requestedCents,
});

const deps = (): PullbackDeps => ({
  db: app,
  clock,
  puller,
  money: { timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: () => {} },
});

const approve = (id: string, session = A.session) => executeProposal(session, id, { confirmed: false }, deps());

type PullDb = { id: string; status: string; pull_cents: string; shortfall_cents: string; money_action_id: string | null };

const pulls = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<PullDb>(
      `SELECT CAST(id AS text) AS id, status, CAST(pull_cents AS text) AS pull_cents,
              CAST(shortfall_cents AS text) AS shortfall_cents, CAST(money_action_id AS text) AS money_action_id
         FROM card_pullbacks WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );

const ledger = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; kind: string; state: string; amount_cents: string; idempotency_key: string; subject_id: string }>(
      `SELECT CAST(id AS text) AS id, kind, state, CAST(amount_cents AS text) AS amount_cents, idempotency_key,
              CAST(subject_id AS text) AS subject_id
         FROM money_actions WHERE tenant_id = current_tenant_id() AND kind = 'card_pullback' ORDER BY created_at, attempt`,
    ),
  );

const deficits = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ amount_cents: string; source_kind: string; source_id: string; note: string }>(
      `SELECT CAST(amount_cents AS text) AS amount_cents, source_kind, CAST(source_id AS text) AS source_id, note
         FROM driver_deficits WHERE tenant_id = current_tenant_id() ORDER BY created_at`,
    ),
  );

const proposalStatus = async (id: string, f: Fixture = A) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ status: string }>("SELECT status FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
    )
  )[0]?.status;

const advanceRow = async (id: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string; taken_back_cents: string; takeback_reason: string | null }>(
        `SELECT status, CAST(taken_back_cents AS text) AS taken_back_cents, takeback_reason FROM advances
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

const makeAdmin = () =>
  admin.withTenant(A.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
      A.memberId,
    ]),
  );

const gatewayCtx = (f: Fixture = A): GatewayContext => ({
  session: f.session,
  role: "operator",
  model: "spark",
  turnId: null,
  traceId: "trace-pullback",
  now: new Date(NOW),
  deadlineAt: NOW + 60_000,
  timeZone: "America/Chicago",
});

describe("card pull-back", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    switchesOn();
    calls = 0;
    puller = countingPuller();
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `pull-a-${tag}`);
    B = await makeTenant(admin, `pull-b-${tag}`);
    // DRV-1's card: $300.00 loaded by hand, $50.00 of fuel bought, so it holds $250.00.
    await post(A, A.driverId, "load", 30_000);
    await post(A, A.driverId, "fuel", 5_000, "2026-10-31");
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    vi.restoreAllMocks();
    for (const f of [A, B]) {
      try {
        // The pulls first: they name ledger rows, and the app role has no DELETE.
        if (f) {
          await admin.withTenant(f.tenantId, (q) => q.execute("DELETE FROM card_pullbacks WHERE tenant_id = current_tenant_id()"));
          await clearLedger(admin, f);
        }
      } finally {
        await dropTenant(admin, f);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("reads the card's balance from our own records, as of its last statement day, less earlier live pulls", async () => {
    const plan = await planOf(breakdown(10_000));
    expect(plan).toMatchObject({ balanceCents: 25_000, pullCents: 10_000, shortfallCents: 0, balanceAsOf: "2026-10-31" });
    expect(plan.cardLast4).toMatch(/^[0-9]{4}$/);
    // The other driver's card holds nothing.
    expect(
      await app.withTenant(A.tenantId, (q) => planPull(q, { ...breakdown(10_000), driverId: A.otherDriverId }, 150_000, new Date(NOW))),
    ).toEqual({ ok: false, refusal: "nothing_to_pull" });
    // Over the take-back bound is refused, never trimmed.
    expect(await app.withTenant(A.tenantId, (q) => planPull(q, breakdown(150_001), 150_000, new Date(NOW)))).toEqual({
      ok: false,
      refusal: "over_bound",
    });
  });

  it("pulls a breakdown's ask off a card that holds it once, however many times it is approved", async () => {
    const id = await addProposal(await planOf(breakdown(20_000)));
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await approve(id)).toMatchObject({ ok: false });
    const [pull] = await pulls();
    expect(pull).toMatchObject({ status: "pulled", pull_cents: "20000", shortfall_cents: "0" });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "confirmed", amount_cents: "20000", idempotency_key: `card_pullback:${pull.id}:1` });
    expect(pull.money_action_id).toBe(rows[0].id);
    expect(calls).toBe(1);
    expect(await deficits()).toEqual([]);
    expect(await proposalStatus(id)).toBe("done");
    // The pulled money has left the card.
    expect((await planOf(breakdown(1_000))).balanceCents).toBe(5_000);
  });

  it("books what the card could not give back on a breakdown as a named deficit, once", async () => {
    const plan = await planOf(breakdown(40_000));
    expect(plan).toMatchObject({ pullCents: 25_000, shortfallCents: 15_000 });
    const id = await addProposal(plan);
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [pull] = await pulls();
    expect(pull).toMatchObject({ status: "pulled", pull_cents: "25000", shortfall_cents: "15000" });
    const owed = await deficits();
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ amount_cents: "15000", source_kind: "pullback_shortfall", source_id: pull.id });
    expect(owed[0].note).toBe(`Breakdown pull-back: card ending ${plan.cardLast4} held $250.00 of $400.00.`);
  });

  it("ends a declined pull failed with nothing moved, and leaves the balance whole", async () => {
    await setCardBehavior(admin, A, A.driverId, "declined");
    const id = await addProposal(await planOf(breakdown(40_000)));
    expect(await approve(id)).toMatchObject({ ok: false, category: "pull_failed" });
    expect((await pulls())[0].status).toBe("failed");
    expect((await ledger())[0].state).toBe("failed");
    expect(await deficits()).toEqual([]);
    expect(await proposalStatus(id)).toBe("failed");
    expect((await planOf(breakdown(1_000))).balanceCents).toBe(25_000);
  });

  it("keeps a pull with no answer open until Check pending reads it back, then settles it once", async () => {
    await setCardBehavior(admin, A, A.driverId, "slow");
    const id = await addProposal(await planOf(breakdown(40_000)));
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    const [open] = await pulls();
    expect(open.status).toBe("issuing");
    expect((await ledger())[0].state).toBe("unknown");
    expect(await deficits()).toEqual([]);
    // An open pull still counts against the card, so no second card can pull the same money.
    expect(await app.withTenant(A.tenantId, (q) => planPull(q, breakdown(1_000), 150_000, new Date(NOW)))).toEqual({
      ok: false,
      refusal: "nothing_to_pull",
    });

    expect(await checkPendingPull(A.session, open.id, deps())).toMatchObject({ ok: true });
    expect((await pulls())[0].status).toBe("pulled");
    expect((await ledger())[0].state).toBe("confirmed");
    expect(await deficits()).toHaveLength(1);
    expect(await proposalStatus(id)).toBe("done");
    // Again: nothing new, never a second pull.
    expect(await checkPendingPull(A.session, open.id, deps())).toMatchObject({ ok: true });
    expect(await ledger()).toHaveLength(1);
    expect(await deficits()).toHaveLength(1);
    expect(calls).toBe(1);
    // Another carrier cannot check it.
    expect(await checkPendingPull(B.session, open.id, deps())).toMatchObject({ ok: false, category: "not_found" });
  });

  it("leaves an offline pull open when the read-back fails, and settles it once the provider answers", async () => {
    await setCardBehavior(admin, A, A.driverId, "offline");
    const id = await addProposal(await planOf(breakdown(20_000)));
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    const [open] = await pulls();
    await checkPendingPull(A.session, open.id, deps()).catch(() => null);
    expect((await pulls())[0].status).toBe("issuing");
    await setCardBehavior(admin, A, A.driverId, "ok");
    expect(await checkPendingPull(A.session, open.id, deps())).toMatchObject({ ok: true });
    expect((await pulls())[0].status).toBe("pulled");
    expect(await proposalStatus(id)).toBe("done");
    expect(calls).toBe(1);
  });

  it("makes one pull and one call when two approvals race", async () => {
    const id = await addProposal(await planOf(breakdown(20_000)));
    const results = await Promise.all([approve(id), approve(id)]);
    expect(results.filter((r) => r.ok)).not.toHaveLength(0);
    expect(await pulls()).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
    expect(calls).toBe(1);
    expect((await pulls())[0].status).toBe("pulled");
  });

  it("never lets the autopilot run a pull", async () => {
    const id = await addProposal(await planOf(breakdown(20_000)));
    // The autopilot's own login, as 0070 makes it, with no rule: a card pull-back can never have one.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, 'autopilot@pullback.invalid', 'staff')`,
        [autopilotSub(A.tenantId)],
      ),
    );
    const robot = await autopilotSession(app, A.tenantId);
    expect(robot).not.toBeNull();
    const r = await executeProposal(robot!, id, { confirmed: false, autopilot: { ruleId: randomUUID(), version: 1 } }, deps());
    expect(r).toMatchObject({ ok: false, category: "kind_never_alone" });
    expect(await pulls()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await proposalStatus(id)).toBe("proposed");
    expect(calls).toBe(0);
    // No rule can put a card pull-back on Auto.
    expect(
      await sqlStateOf(
        admin.withTenant(A.tenantId, (q) =>
          q.execute(
            `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, driver_day_max_cents, updated_by)
             VALUES (current_tenant_id(), 'card_pullback', 'auto', 30000, 150000, 10, 30000, 'setup')`,
          ),
        ),
      ),
    ).toBe("23514");
  });

  it("refuses at every path with a switch off, before anything is written", async () => {
    const plan = await planOf(breakdown(20_000));
    const id = await addProposal(plan);
    flags.cardPullback.enabled = false;
    expect(await approve(id)).toMatchObject({ ok: false });
    expect(
      await app.withTenant(A.tenantId, (q) => cardPullbackLimit(q, gatewayCtx(), { driverId: A.driverId, amountCents: 20_000, reason: "breakdown" })),
    ).toMatchObject({ ok: false });
    expect(await checkPendingPull(A.session, randomUUID(), deps())).toMatchObject({ ok: false, category: "pullback_off" });
    flags.cardPullback.enabled = true;
    flags.payoutsEnabled = false;
    expect(await approve(id)).toMatchObject({ ok: false, category: "pullback_payouts_off" });
    flags.payoutsEnabled = true;
    // A card made before the start day is never acted on.
    flags.cardPullback.startDate = "2026-11-03";
    expect(await approve(id)).toMatchObject({ ok: false, category: "not_executable" });
    expect(await pulls()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await proposalStatus(id)).toBe("proposed");
    expect(calls).toBe(0);
  });

  it("needs an admin above the approver line, and another carrier cannot approve", async () => {
    flags.approverRole = { adminAboveCents: 10_000 };
    const id = await addProposal(await planOf(breakdown(20_000)));
    expect(await approve(id)).toMatchObject({ ok: false, category: "role" });
    expect(await approve(id, B.session)).toMatchObject({ ok: false });
    expect(await pulls()).toEqual([]);
    await makeAdmin();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await pulls(B)).toEqual([]);
    expect(await app.withTenant(B.tenantId, (q) => q.query("SELECT 1 AS one FROM card_pullbacks"))).toEqual([]);
  });

  it("keeps a pull's numbers fixed and its rows undeletable for the app's role", async () => {
    const id = await addProposal(await planOf(breakdown(20_000)));
    await approve(id);
    const [pull] = await pulls();
    expect(
      await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM card_pullbacks WHERE id = CAST($1 AS uuid)", [pull.id]))),
    ).toBe("42501");
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) => q.execute("UPDATE card_pullbacks SET pull_cents = 1 WHERE id = CAST($1 AS uuid)", [pull.id])),
      ),
    ).toBe("42501");
  });

  it("has the propose tool's limit name the plan, the cap and an empty card", async () => {
    const limit = (driverId: string, amountCents: number) =>
      app.withTenant(A.tenantId, (q) => cardPullbackLimit(q, gatewayCtx(), { driverId, amountCents, reason: "breakdown" }));
    expect(await limit(A.driverId, 20_000)).toMatchObject({ ok: true, limitCents: 20_000 });
    expect(await limit(A.driverId, 150_001)).toMatchObject({ ok: false, reason: "amount_over_limit" });
    expect(await limit(A.otherDriverId, 20_000)).toMatchObject({ ok: false, reason: "engine_refused", category: "nothing_to_pull" });
    flags.cardPullback.startDate = "2026-11-03";
    expect(await limit(A.driverId, 20_000)).toMatchObject({ ok: false, reason: "engine_refused", category: "pullback_before_start" });
  });

  describe("a take-back of a paid advance", () => {
    const services = () => ({ db: app, clock });

    it("makes a card to approve; the approval pulls what the card holds and the rest stays owed", async () => {
      const adv = await paidAdvance(A, 30_000);
      const made = await takeBackAdvance(A.session, adv, { amountCents: 30_000, reason: "duplicate" }, services());
      expect(made).toMatchObject({ ok: true, changed: true });
      const proposalId = (made as { proposalId: string }).proposalId;
      expect(await takeBackAdvance(A.session, adv, { amountCents: 30_000, reason: "duplicate" }, services())).toEqual({
        ok: true,
        changed: false,
        proposalId,
      });
      // Nothing recorded yet: the card waits for a person.
      expect(await advanceRow(adv)).toMatchObject({ status: "paid", taken_back_cents: "0", takeback_reason: null });
      const [p] = await admin.withTenant(A.tenantId, (q) =>
        q.query<{ kind: string; subject_table: string; amount_cents: string; status: string; args: PullPlanned }>(
          `SELECT kind, subject_table, CAST(amount_cents AS text) AS amount_cents, status, args FROM proposals
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [proposalId],
        ),
      );
      expect(p).toMatchObject({ kind: "card_pullback", subject_table: "advances", amount_cents: "30000", status: "proposed" });
      expect(p.args).toMatchObject({ advanceId: adv, pullCents: 25_000, shortfallCents: 0 });
      // The engine's card is audited by the sweep; stood in for here.
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = TRUE, auditor_checked_at = CAST($2 AS timestamptz)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [proposalId, new Date(NOW).toISOString()],
        ),
      );
      expect(await approve(proposalId)).toMatchObject({ ok: true, status: "done" });
      expect(await advanceRow(adv)).toMatchObject({ status: "paid", taken_back_cents: "25000", takeback_reason: "duplicate" });
      expect(await deficits()).toEqual([]);
      expect((await pulls())[0]).toMatchObject({ status: "pulled", pull_cents: "25000", shortfall_cents: "0" });
    });

    it("records the amount as before, with no card, while the pull-back switch is off", async () => {
      flags.cardPullback.enabled = false;
      const adv = await paidAdvance(A, 30_000);
      expect(await takeBackAdvance(A.session, adv, { amountCents: 20_000, reason: "duplicate" }, services())).toEqual({
        ok: true,
        changed: true,
        status: "paid",
        takenBackCents: 20_000,
      });
      expect(await pulls()).toEqual([]);
    });

    it("says when the card holds nothing to pull", async () => {
      await admin.withTenant(A.tenantId, (q) => q.execute("DELETE FROM card_transactions WHERE tenant_id = current_tenant_id()"));
      const adv = await paidAdvance(A, 30_000);
      expect(await takeBackAdvance(A.session, adv, { amountCents: 20_000, reason: "duplicate" }, services())).toEqual({
        ok: false,
        category: "nothing_to_pull",
        retryable: false,
      });
      expect(await advanceRow(adv)).toMatchObject({ taken_back_cents: "0" });
    });
  });
});
