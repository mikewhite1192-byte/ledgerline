import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { readTenantRows } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { EXECUTORS, executeProposal, type ProposalRow } from "../proposals/execute";
import { executeBillDefer } from "../proposals/executors/cash-friday";
import { DEMO_ANCHOR } from "../seed/anchor";
import { DEMO_CARRIERS } from "../seed/carriers";
import { cashPositionOf, PLANTED_GAP_CENTS } from "../seed/cash-plan";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { runPayPeriod } from "../settlements/run";
import { runCashCheck, type CheckDeps } from "./check";
import type { Explained } from "./explain";
import { readCashHome, readCashView, readVendorBill } from "./view";

// Cash Friday against the real database, as the app's role: a press stores the engine's figures
// and its cards; a second press, or two at once, makes no new cards; a covered carrier gets none;
// a failed explanation keeps the figures and stores only its category; a refusal writes nothing.
// Approvals: a delayed bill moves once, a bill paid after its card was made fails as stale,
// factoring and a chase record the decision and write nothing else, the switch off leaves every
// card waiting, and another carrier reads and changes nothing. Only the model's paragraph is a
// stand-in. Both demo carriers are seeded from their plans (the seed checks the tenant is the
// carrier); the two tenants are removed after.

const [BR, PW] = DEMO_CARRIERS;
const planA = buildCarrierPlan(BR, DEMO_ANCHOR);
const planB = buildCarrierPlan(PW, DEMO_ANCHOR);
const expectedA = cashPositionOf(planA.rows, BR, DEMO_ANCHOR, flags.cashFridayLimits);
const expectedB = cashPositionOf(planB.rows, PW, DEMO_ANCHOR, flags.cashFridayLimits);

// Noon on the anchor in every US zone; the check's "today" is the anchor itself.
const NOW = new Date(`${DEMO_ANCHOR}T18:00:00.000Z`);
const clock = () => NOW;
const A = randomUUID();
const B = randomUUID();
const ADMIN_A: Session = { sub: `sub-admin-${A}`, email: "admin@cash-a.example", tenantId: A };
const STAFF_A: Session = { sub: `sub-staff-${A}`, email: "staff@cash-a.example", tenantId: A };
const STAFF_B: Session = { sub: `sub-staff-${B}`, email: "staff@cash-b.example", tenantId: B };
const saved = { ...flags, cashFridayLimits: { ...flags.cashFridayLimits } };

let admin: Db;
let app: Db;

const PARAGRAPH = "Blue Ridge is short for Friday; the cards below close it.";
const explainOk = async (): Promise<Explained> => ({ ok: true, text: PARAGRAPH, callId: randomUUID(), costNanocents: 1 });
const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({ db: app, explain: explainOk, ...over });

type CardRow = { id: string; kind: string; subject_id: string; status: string; decision_note: string | null; args: string };

async function cards(tenantId: string): Promise<CardRow[]> {
  return admin.withTenant(tenantId, (q) =>
    q.query<CardRow>(
      `SELECT CAST(id AS text) AS id, kind, CAST(subject_id AS text) AS subject_id, status, decision_note,
              CAST(args AS text) AS args
         FROM proposals WHERE tenant_id = current_tenant_id() AND origin = 'engine'
        ORDER BY kind, created_at, id`,
    ),
  );
}

async function countOf(tenantId: string, table: "cash_checks" | "proposals" | "money_actions"): Promise<number> {
  const [row] = await admin.withTenant(tenantId, (q) =>
    q.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = current_tenant_id()`),
  );
  return Number(row.n);
}

type CheckRow = { gap_cents: string; figures: string; lines: string; options: string; explanation: string | null; explain_category: string | null };

async function checkRow(tenantId: string, id: string): Promise<CheckRow> {
  const [row] = await admin.withTenant(tenantId, (q) =>
    q.query<CheckRow>(
      `SELECT CAST(gap_cents AS text) AS gap_cents, CAST(figures AS text) AS figures, CAST(lines AS text) AS lines,
              CAST(options AS text) AS options, explanation, explain_category
         FROM cash_checks WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  return row;
}

type BillState = { status: string; deferred_to: string | null; paid_on: string | null; proposal_id: string | null };

async function bill(tenantId: string, id: string): Promise<BillState> {
  const [row] = await admin.withTenant(tenantId, (q) =>
    q.query<BillState>(
      `SELECT status, CAST(deferred_to AS text) AS deferred_to, CAST(paid_on AS text) AS paid_on,
              CAST(proposal_id AS text) AS proposal_id
         FROM vendor_bills WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  return row;
}

// The auditor's pass on a card, as the real auditor stores one.
async function storePass(tenantId: string, id: string): Promise<void> {
  await admin.withTenant(tenantId, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, NOW.toISOString()],
    ),
  );
}

const approve = (s: Session, id: string) =>
  executeProposal(s, id, { confirmed: false }, { db: app, clock, executors: EXECUTORS });

function cardOf(rows: CardRow[], kind: string): CardRow {
  const row = rows.find((r) => r.kind === kind && r.status === "proposed");
  if (!row) throw new Error(`no waiting ${kind} card`);
  return row;
}

async function press(s: Session, over: Partial<CheckDeps> = {}) {
  const r = await runCashCheck(s, NOW, deps(over));
  if (!r.ok) throw new Error(`the check refused: ${r.category}`);
  return r;
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  for (const [id, plan] of [
    [A, planA],
    [B, planB],
  ] as const) {
    await admin.withTenant(id, (q) =>
      q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        plan.carrier.slug,
        plan.carrier.name,
        plan.carrier.timezone,
      ]),
    );
    await replaceTenantData(app, id, plan);
  }
  await admin.withTenant(A, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
         (current_tenant_id(), $1, $2, 'admin'), (current_tenant_id(), $3, $4, 'staff')`,
      [ADMIN_A.sub, ADMIN_A.email, STAFF_A.sub, STAFF_A.email],
    ),
  );
  await admin.withTenant(B, (q) =>
    q.execute("INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')", [
      STAFF_B.sub,
      STAFF_B.email,
    ]),
  );
});

afterEach(() => {
  Object.assign(flags, saved, { cashFridayLimits: { ...saved.cashFridayLimits } });
  flags.cashFridayEnabled = true;
});

afterAll(async () => {
  Object.assign(flags, saved, { cashFridayLimits: { ...saved.cashFridayLimits } });
  if (admin) {
    for (const id of [A, B]) {
      await clearTenantAgent(admin, id).catch(() => undefined);
      await admin.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
  }
  await app?.close();
  await admin?.close();
});

describe("Cash Friday on the real database", () => {
  it("does nothing while switched off", async () => {
    flags.cashFridayEnabled = false;
    expect(await runCashCheck(ADMIN_A, NOW, deps())).toEqual({ ok: false, category: "disabled" });
    expect([await countOf(A, "cash_checks"), await countOf(A, "proposals")]).toEqual([0, 0]);
  });

  it("stores Blue Ridge's figures and makes one card per way out", async () => {
    flags.cashFridayEnabled = true;
    expect(expectedA.figures.gapCents).toBe(PLANTED_GAP_CENTS["blue-ridge"]);
    const r = await press(ADMIN_A);
    expect(r.gapCents).toBe(expectedA.figures.gapCents);
    expect(r.explained).toBe(true);
    expect(r.options.map((o) => [o.kind, o.subjectId, o.amountCents, o.card])).toEqual(
      expectedA.options.map((o) => [o.kind, o.subjectId, o.amountCents, "created"]),
    );
    const row = await checkRow(A, r.checkId);
    expect(JSON.parse(row.figures)).toEqual(expectedA.figures);
    expect(Number(row.gap_cents)).toBe(expectedA.figures.gapCents);
    expect((JSON.parse(row.lines) as { invoiceId: string }[]).map((l) => l.invoiceId)).toEqual(
      expectedA.lines.map((l) => l.invoiceId),
    );
    expect((JSON.parse(row.options) as { proposalId: string }[]).map((o) => o.proposalId)).toEqual(
      r.options.map((o) => o.proposalId),
    );
    expect([row.explanation, row.explain_category]).toEqual([PARAGRAPH, null]);
    const made = await cards(A);
    expect(made.map((c) => [c.kind, c.status])).toEqual([
      ["bill_defer", "proposed"],
      ["collections_chase", "proposed"],
      ["collections_chase", "proposed"],
      ["factoring_request", "proposed"],
    ]);
  });

  it("makes no new cards on a second press, or on two presses at once", async () => {
    const before = await cards(A);
    const [one, two] = await Promise.all([press(ADMIN_A), press(STAFF_A)]);
    for (const r of [one, two]) {
      expect(r.gapCents).toBe(expectedA.figures.gapCents);
      expect(r.options.map((o) => o.card)).toEqual(expectedA.options.map(() => "duplicate"));
    }
    expect(await cards(A)).toEqual(before);
    expect(await countOf(A, "cash_checks")).toBe(3);
  });

  it("finds Prairie Wind covered and makes no cards", async () => {
    const r = await press(STAFF_B);
    expect(r.gapCents).toBe(expectedB.figures.gapCents);
    expect(r.gapCents).toBe(PLANTED_GAP_CENTS["prairie-wind"]);
    expect(r.options).toEqual([]);
    expect(await cards(B)).toEqual([]);
  });

  it("keeps the figures and stores only a category when the explanation fails", async () => {
    const timedOut = await press(STAFF_B, {
      explain: async () => ({ ok: false, category: "timeout", callId: null, costNanocents: null }),
    });
    expect(timedOut.explained).toBe(false);
    const t = await checkRow(B, timedOut.checkId);
    expect([t.explanation, t.explain_category, Number(t.gap_cents)]).toEqual([null, "timeout", expectedB.figures.gapCents]);
    const threw = await press(STAFF_B, {
      explain: async () => {
        throw new Error("socket hang up at 10.0.0.1");
      },
    });
    const u = await checkRow(B, threw.checkId);
    expect([u.explanation, u.explain_category]).toEqual([null, "unknown"]);
  });

  it("reads the latest check, the bills and the live cards back through the app role", async () => {
    const view = await app.withTenant(A, (q) => readCashView(q));
    expect(view.check?.figures.gapCents).toBe(expectedA.figures.gapCents);
    expect(view.check?.payDay).toBe(expectedA.payDay);
    expect(view.check?.explanation).toBe(PARAGRAPH);
    expect(view.check?.lines.every((l) => l.customerName !== null)).toBe(true);
    expect(view.bills).toHaveLength(planA.rows.vendor_bills.length);
    expect(view.cards.map((c) => c.kind)).toEqual([
      "factoring_request",
      "bill_defer",
      "collections_chase",
      "collections_chase",
    ]);
    const deferId = expectedA.options.find((o) => o.kind === "bill_defer")?.subjectId ?? "";
    expect((await app.withTenant(A, (q) => readVendorBill(q, deferId)))?.status).toBe("open");
    expect(await readCashHome(STAFF_A, { db: app })).toMatchObject({
      payDay: expectedA.payDay,
      gapCents: expectedA.figures.gapCents,
    });
  });

  it("lets another carrier read and change nothing of Blue Ridge's", async () => {
    const theirs = await app.withTenant(B, (q) => readCashView(q));
    expect(theirs.check?.figures.gapCents).toBe(expectedB.figures.gapCents);
    expect(theirs.cards).toEqual([]);
    expect(theirs.bills.map((b) => b.id).sort()).toEqual(planB.rows.vendor_bills.map((b) => b.id).sort());
    const defer = cardOf(await cards(A), "bill_defer");
    expect(await app.withTenant(B, (q) => readVendorBill(q, defer.subject_id))).toBeNull();
    expect(await approve(STAFF_B, defer.id)).toMatchObject({ ok: false, category: "not_found" });
    expect((await bill(A, defer.subject_id)).status).toBe("open");
    expect(await readCashHome(STAFF_B, { db: app })).toMatchObject({ gapCents: expectedB.figures.gapCents });
  });

  it("leaves every card waiting while switched off", async () => {
    const defer = cardOf(await cards(A), "bill_defer");
    await storePass(A, defer.id);
    flags.cashFridayEnabled = false;
    expect(await approve(ADMIN_A, defer.id)).toEqual({ ok: false, category: "not_executable", retryable: false });
    // Called directly on an approved row, the executor refuses before reading anything.
    const row = { id: defer.id, kind: "bill_defer", subjectId: defer.subject_id, status: "approved" } as ProposalRow;
    expect(await executeBillDefer(app, ADMIN_A, row, { confirmed: false }, { clock })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    expect(cardOf(await cards(A), "bill_defer").status).toBe("proposed");
    expect((await bill(A, defer.subject_id)).status).toBe("open");
  });

  it("keeps a delay over the admin line for an admin", async () => {
    const defer = cardOf(await cards(A), "bill_defer");
    const amount = expectedA.options.find((o) => o.kind === "bill_defer")?.amountCents ?? 0;
    expect(amount).toBeGreaterThan(flags.approverRole.adminAboveCents);
    expect(await approve(STAFF_A, defer.id)).toMatchObject({ ok: false, category: "role" });
    expect(cardOf(await cards(A), "bill_defer").status).toBe("proposed");
  });

  it("records a factoring or chase approval in test mode and writes nothing else while factoring is off", async () => {
    // Factoring off: Cash Friday's own test-mode decision (factoring.db.test.ts runs its executor).
    flags.factoring = { ...flags.factoring, enabled: false };
    const before = await admin.withTenant(A, (q) => readTenantRows(q));
    const money = await countOf(A, "money_actions");
    const factoring = cardOf(await cards(A), "factoring_request");
    const chase = cardOf(await cards(A), "collections_chase");
    for (const c of [factoring, chase]) await storePass(A, c.id);
    // Factoring's net is under the admin line, so staff may approve it; a chase names the whole
    // overdue balance, so it is an admin's.
    expect(await approve(STAFF_A, factoring.id)).toEqual({ ok: true, proposalId: factoring.id, status: "done", moneyActionId: null });
    expect(await approve(ADMIN_A, chase.id)).toEqual({ ok: true, proposalId: chase.id, status: "done", moneyActionId: null });
    const after = await cards(A);
    for (const c of [factoring, chase]) {
      expect(after.find((r) => r.id === c.id)).toMatchObject({ status: "done", decision_note: "test_mode" });
    }
    expect(await admin.withTenant(A, (q) => readTenantRows(q))).toEqual(before);
    expect(await countOf(A, "money_actions")).toBe(money);
  });

  it("moves an approved bill's date once, then a press finds Friday covered and retires the waiting card", async () => {
    const defer = cardOf(await cards(A), "bill_defer");
    const args = JSON.parse(defer.args) as { deferredTo: string };
    expect(await approve(ADMIN_A, defer.id)).toEqual({ ok: true, proposalId: defer.id, status: "done", moneyActionId: null });
    const moved = await bill(A, defer.subject_id);
    expect(moved).toEqual({ status: "deferred", deferred_to: args.deferredTo, paid_on: null, proposal_id: defer.id });
    // The same approval again, through the gate or straight to the executor, writes nothing.
    expect(await approve(ADMIN_A, defer.id)).toMatchObject({ ok: false, category: "already_decided" });
    const row = { id: defer.id, kind: "bill_defer", subjectId: defer.subject_id, status: "done" } as ProposalRow;
    expect(await executeBillDefer(app, ADMIN_A, row, { confirmed: false }, { clock })).toMatchObject({ ok: true, status: "done" });
    expect(await bill(A, defer.subject_id)).toEqual(moved);

    // The engine's own figures with that bill moved: the short is closed and no card is offered.
    const rows = {
      ...planA.rows,
      vendor_bills: planA.rows.vendor_bills.map((b) =>
        b.id === defer.subject_id ? { ...b, status: "deferred" as const, deferred_to: args.deferredTo } : b,
      ),
    };
    const covered = cashPositionOf(rows, BR, DEMO_ANCHOR, flags.cashFridayLimits);
    expect(covered.figures.gapCents).toBeGreaterThanOrEqual(0);
    const r = await press(ADMIN_A);
    expect(r.gapCents).toBe(covered.figures.gapCents);
    expect(r.options).toEqual([]);
    const after = await cards(A);
    expect(after.filter((c) => c.status === "proposed")).toEqual([]);
    expect(after.filter((c) => c.status === "expired").map((c) => [c.kind, c.decision_note])).toEqual([
      ["collections_chase", "superseded"],
    ]);
    expect(after.filter((c) => c.status === "done")).toHaveLength(3);
  });

  it("fails a delay as stale when the bill was paid after the card was made", async () => {
    // Start over: no cards, the bill open again.
    const billId = expectedA.options.find((o) => o.kind === "bill_defer")?.subjectId ?? "";
    await clearTenantAgent(admin, A);
    await admin.withTenant(A, (q) =>
      q.execute(
        `UPDATE vendor_bills SET status = 'open', deferred_to = NULL, proposal_id = NULL
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [billId],
      ),
    );
    const r = await press(ADMIN_A);
    expect(r.gapCents).toBe(expectedA.figures.gapCents);
    const defer = cardOf(await cards(A), "bill_defer");
    expect(defer.subject_id).toBe(billId);
    await storePass(A, defer.id);
    await admin.withTenant(A, (q) =>
      q.execute(
        `UPDATE vendor_bills SET status = 'paid', paid_on = CAST($2 AS date)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [billId, DEMO_ANCHOR],
      ),
    );
    expect(await approve(ADMIN_A, defer.id)).toEqual({ ok: false, category: "stale", retryable: false });
    expect((await cards(A)).find((c) => c.id === defer.id)).toMatchObject({ status: "failed", decision_note: "stale" });
    expect(await bill(A, billId)).toEqual({ status: "paid", deferred_to: null, paid_on: DEMO_ANCHOR, proposal_id: null });
  });

  it("writes nothing when the check cannot be worked out", async () => {
    const [checks, proposals] = [await countOf(B, "cash_checks"), await countOf(B, "proposals")];
    await admin.withTenant(B, (q) => q.execute("DELETE FROM cash_settings WHERE tenant_id = current_tenant_id()"));
    expect(await runCashCheck(STAFF_B, NOW, deps())).toEqual({ ok: false, category: "balance_missing" });
    expect([await countOf(B, "cash_checks"), await countOf(B, "proposals")]).toEqual([checks, proposals]);
  });

  it("reads a pay run stopped at its cap as unknown and writes nothing, then the whole run as stored", async () => {
    const period = planA.rows.settlement_periods.find((p) => p.status === "open");
    if (!period) throw new Error("no open week");
    const cap = flags.settlementLimits.driversPerRun;
    flags.settlementsEnabled = true;
    try {
      flags.settlementLimits.driversPerRun = 1;
      expect(await runPayPeriod(app, ADMIN_A, period.id, NOW)).toMatchObject({
        ok: true,
        counts: { drafts: 1, truncated: true },
      });
      const [checks, proposals] = [await countOf(A, "cash_checks"), await countOf(A, "proposals")];
      expect(await runCashCheck(ADMIN_A, NOW, deps())).toEqual({ ok: false, category: "pay_run_unknown" });
      expect([await countOf(A, "cash_checks"), await countOf(A, "proposals")]).toEqual([checks, proposals]);

      flags.settlementLimits.driversPerRun = cap;
      expect(await runPayPeriod(app, ADMIN_A, period.id, NOW)).toMatchObject({ ok: true, counts: { truncated: false } });
      const r = await press(ADMIN_A);
      const [stored] = await admin.withTenant(A, (q) =>
        q.query<{ source: string; figures: string; owed: string }>(
          `SELECT c.pay_run_source AS source, CAST(c.figures AS text) AS figures,
                  (SELECT CAST(sum(s.net_cents) AS text) FROM settlements s
                    WHERE s.tenant_id = c.tenant_id AND s.period_id = CAST($2 AS uuid)
                      AND s.status IN ('draft', 'approved')) AS owed
             FROM cash_checks c WHERE c.tenant_id = current_tenant_id() AND c.id = CAST($1 AS uuid)`,
          [r.checkId, period.id],
        ),
      );
      expect(stored.source).toBe("stored");
      expect((JSON.parse(stored.figures) as { payRunCents: number }).payRunCents).toBe(Number(stored.owed));
    } finally {
      flags.settlementLimits.driversPerRun = cap;
    }
  });
});
