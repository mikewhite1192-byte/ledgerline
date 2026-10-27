import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { CarrierPlan } from "../../../seed/plan";
import { loadsOf } from "../../../data/records";
import { readAdvanceInput } from "../../../data/read";
import { advanceEligibility, invoiceAmount } from "../../../rules-engine";
import { instantAt } from "../../../seed/calendar";
import { CASE_A_ASK_CENTS } from "../../../seed/untrusted-inputs";
import { addDays } from "../../../time/local-date";
import {
  advanceLimit,
  detentionChargeLimit,
  invoiceFixLimit,
  paymentReapplyLimit,
  payCorrectionLimit,
} from "../limits";
import type { GatewayContext } from "../types";
import { context, OTHER_ID, TENANT } from "./fake-db";
import { blueRidgePlan, LEDGER_BY_SUBJECT, planDb } from "./plan-db";

// The limits run on the real readers and the real rules engine, over a synthetic seed plan
// served by a fake database. The gateway only compares: every number here comes from the engine.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode)!;
const today = addDays(plan.anchor, -2);
const ctx: GatewayContext = context({
  now: new Date(instantAt(today, 12, 0, zone)),
  timeZone: zone,
});

const ASKED = /^SELECT max\(requested_cents\) AS asked FROM gateway_decisions/;

async function engineFor(driverId: string, amountCents: number) {
  const db = planDb(plan);
  return db.withTenant(ctx.session.tenantId, async (q) =>
    advanceEligibility(await readAdvanceInput(q, driverId, ctx.now.toISOString(), amountCents)),
  );
}

function limitWith(asked: number | null | "throw" = null) {
  return planDb(plan, (sql) => {
    if (!ASKED.test(sql)) return undefined;
    if (asked === "throw") throw new Error("read failed");
    return [{ asked }];
  });
}

describe("advance limit", () => {
  it("refuses case A's ask as over the limit and names the engine's maximum", async () => {
    const engine = await engineFor(hero.id, CASE_A_ASK_CENTS);
    expect(engine.eligible).toBe(false);
    expect(engine.maxCents).toBeGreaterThan(0);
    expect(engine.maxCents).toBeLessThan(CASE_A_ASK_CENTS);
    const db = limitWith();
    const out = await db.withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: hero.id, amountCents: CASE_A_ASK_CENTS, requestedOn: today }),
    );
    expect(out).toEqual({
      ok: false,
      reason: "amount_over_limit",
      limitCents: engine.maxCents,
      requestedCents: CASE_A_ASK_CENTS,
    });
  });

  it("allows an ask at the engine's maximum, with no exception on a first ask", async () => {
    const { maxCents } = await engineFor(hero.id, CASE_A_ASK_CENTS);
    const engine = await engineFor(hero.id, maxCents);
    expect(engine.eligible).toBe(true);
    const out = await limitWith().withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: hero.id, amountCents: maxCents, requestedOn: today }),
    );
    expect(out).toMatchObject({
      ok: true,
      limitCents: maxCents,
      requestedCents: maxCents,
      exceptions: [],
      reasons: engine.reasons,
    });
    if (out.ok) expect(out.sources.length).toBeGreaterThan(0);
  });

  it("marks the ask capped_to_eligible after a larger ask in the same trace was refused", async () => {
    const { maxCents } = await engineFor(hero.id, CASE_A_ASK_CENTS);
    const db = limitWith(CASE_A_ASK_CENTS);
    const out = await db.withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: hero.id, amountCents: maxCents, requestedOn: today }),
    );
    expect(out).toMatchObject({ ok: true, exceptions: ["capped_to_eligible"] });
    const asked = db.statements.find((s) => ASKED.test(s.sql))!;
    expect(asked.params).toEqual([ctx.traceId, hero.id]);
  });

  it("refuses an ask dated after today", async () => {
    const out = await limitWith().withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: hero.id, amountCents: 100, requestedOn: addDays(today, 1) }),
    );
    expect(out).toMatchObject({ ok: false, reason: "engine_refused" });
  });

  it("is limit_unavailable when the driver cannot be read or the trace cannot be checked", async () => {
    const missing = await limitWith().withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: OTHER_ID, amountCents: 100, requestedOn: today }),
    );
    expect(missing).toEqual({
      ok: false,
      reason: "limit_unavailable",
      limitCents: null,
      requestedCents: 100,
    });
    const { maxCents } = await engineFor(hero.id, CASE_A_ASK_CENTS);
    const unreadable = await limitWith("throw").withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: hero.id, amountCents: maxCents, requestedOn: today }),
    );
    expect(unreadable).toMatchObject({ ok: false, reason: "limit_unavailable" });
  });

  it("calls a refusal for any reason besides the amount engine_refused", async () => {
    // The planted duplicate-advance driver already has advances open in the seed.
    const victim = plan.rows.drivers.find((d) => d.code === plan.victims.duplicateAdvance)!;
    const engine = await engineFor(victim.id, 100);
    const overOnly =
      engine.reasons.length > 0 &&
      engine.reasons.every((r) => r === "over_driver_limit" || r === "exceeds_earned_share") &&
      engine.maxCents > 0;
    const out = await limitWith().withTenant(ctx.session.tenantId, (q) =>
      advanceLimit(q, ctx, { driverId: victim.id, amountCents: 100, requestedOn: today }),
    );
    if (engine.eligible) expect(out.ok).toBe(true);
    else expect(out).toMatchObject({ ok: false, reason: overOnly ? "amount_over_limit" : "engine_refused" });
  });
});

describe("pay correction limit", () => {
  const open = plan.rows.settlement_periods.find((p) => p.status === "open")!;
  const paid = plan.rows.settlement_periods.find((p) => p.status === "paid")!;
  const driver = plan.rows.drivers.find(
    (d) =>
      d.id !== hero.id &&
      !plan.rows.settlements.some((s) => s.driver_id === d.id && s.period_id === open.id && s.status !== "draft"),
  )!;

  const run = (args: Parameters<typeof payCorrectionLimit>[2]) =>
    planDb(plan).withTenant(ctx.session.tenantId, (q) => payCorrectionLimit(q, ctx, args));

  it("refuses a correction above the carrier's cap before reading anything", async () => {
    expect(await run({ driverId: driver.id, periodId: open.id, deltaCents: -50_001 })).toEqual({
      ok: false,
      reason: "amount_over_limit",
      limitCents: 50_000,
      requestedCents: -50_001,
    });
  });

  it("allows a correction in an open period the engine can settle", async () => {
    const out = await run({ driverId: driver.id, periodId: open.id, deltaCents: 12_500 });
    expect(out).toMatchObject({ ok: true, limitCents: 50_000, requestedCents: 12_500, exceptions: [] });
  });

  it("refuses a correction in a paid period", async () => {
    expect(await run({ driverId: driver.id, periodId: paid.id, deltaCents: 100 })).toMatchObject({
      ok: false,
      reason: "engine_refused",
    });
  });

  it("refuses a pay item that belongs to another driver", async () => {
    const item = plan.rows.pay_items.find((i) => i.driver_id !== driver.id && i.settlement_id === null)!;
    expect(
      await run({ driverId: driver.id, periodId: open.id, payItemId: item.id, deltaCents: 100 }),
    ).toMatchObject({ ok: false, reason: "engine_refused" });
  });

  it("is limit_unavailable for a period it cannot read", async () => {
    expect(await run({ driverId: driver.id, periodId: OTHER_ID, deltaCents: 100 })).toMatchObject({
      ok: false,
      reason: "limit_unavailable",
      limitCents: null,
    });
  });
});

describe("invoice fix limit", () => {
  const engineAmount = (loadId: string) => {
    const loads = plan.rows.loads.filter((l) => l.id === loadId);
    const miles = plan.rows.load_state_miles.filter((m) => m.load_id === loadId);
    const acc = plan.rows.load_accessorials.filter((a) => a.load_id === loadId);
    return invoiceAmount(loadsOf(loads, miles, acc)[0]);
  };
  const open = plan.rows.invoices.filter(
    (i) => i.source === "load" && i.load_id !== null && (i.status === "open" || i.status === "partially_paid"),
  );
  const right = open.find((i) => {
    const e = engineAmount(i.load_id!);
    return e.ok && e.amountCents === i.amount_cents;
  })!;
  // The same invoice billed 41.25 short, in a copy of the plan.
  const short = { ...right, amount_cents: right.amount_cents - 4_125 };
  const shortPlan = {
    ...plan,
    rows: { ...plan.rows, invoices: plan.rows.invoices.map((i) => (i.id === right.id ? short : i)) },
  };

  const run = (invoiceId: string, newAmountCents: number) =>
    planDb(plan).withTenant(ctx.session.tenantId, (q) =>
      invoiceFixLimit(q, ctx, { invoiceId, newAmountCents }),
    );

  it("refuses a new total the engine does not compute", async () => {
    expect(await run(right.id, right.amount_cents + 100)).toMatchObject({
      ok: false,
      reason: "engine_refused",
      requestedCents: 100,
    });
  });

  it("refuses no change and a change above the cap", async () => {
    expect(await run(right.id, right.amount_cents)).toMatchObject({ reason: "engine_refused" });
    expect(await run(right.id, right.amount_cents + 250_001)).toMatchObject({
      reason: "amount_over_limit",
      limitCents: 250_000,
    });
  });

  it("allows the engine's own total for an invoice billed short", async () => {
    const out = await planDb(shortPlan).withTenant(ctx.session.tenantId, (q) =>
      invoiceFixLimit(q, ctx, { invoiceId: right.id, newAmountCents: right.amount_cents }),
    );
    expect(out).toMatchObject({ ok: true, limitCents: 250_000, requestedCents: 4_125 });
    if (out.ok) expect(out.sources[0]).toEqual({ table: "invoices", id: right.id });
  });

  it("is limit_unavailable for an invoice it cannot read", async () => {
    expect(await run(OTHER_ID, 1000)).toMatchObject({ ok: false, reason: "limit_unavailable" });
  });
});

describe("payment reapply limit", () => {
  const w = plan.planted.wrongInvoice;
  const ids = {
    paymentId: w.paymentId,
    applicationId: w.applicationId,
    fromInvoiceId: w.appliedToInvoiceId,
    toInvoiceId: w.meantForInvoiceId,
  };
  const applied = plan.rows.payment_applications.find((a) => a.id === w.applicationId)!;
  const run = (p: typeof plan, args: typeof ids) =>
    planDb(p).withTenant(ctx.session.tenantId, (q) => paymentReapplyLimit(q, ctx, args));

  // A customer_payment ledger row for the planted payment, as money/read.ts reads it back.
  const postRow = (state: string) => {
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    const settled = state === "failed" || state === "confirmed";
    return {
      id,
      tenant_id: TENANT,
      kind: "customer_payment",
      channel: "accounting",
      subject_table: "customer_payments",
      subject_id: ids.paymentId,
      attempt: 1,
      idempotency_key: `customer_payment:${ids.paymentId}:1`,
      request_id: id.replace(/-/g, ""),
      amount_cents: applied.amount_cents,
      counterparty_table: "customers",
      counterparty_id: w.customerId,
      state,
      failure_category: state === "failed" ? "timeout" : null,
      settled_via: settled ? "read_back" : null,
      outside_system: state === "confirmed" ? "qbo_sandbox" : null,
      outside_type: null,
      outside_id: state === "confirmed" ? "9001" : null,
      outside_ref: null,
      outside_amount_cents: state === "confirmed" ? applied.amount_cents : null,
      proposed_by: "person",
      proposal_id: null,
      trace_id: null,
      approver_membership_id: OTHER_ID,
      batch_id: null,
      check_count: 0,
      created_at: "2026-10-30T15:00:00.000Z",
      sent_at: state === "reserved" ? null : "2026-10-30T15:00:01.000Z",
      settled_at: settled ? "2026-10-30T15:05:00.000Z" : null,
      last_checked_at: null,
      sent_seconds_ago: state === "reserved" ? null : 60,
    };
  };
  const withLedger = (rows: ReturnType<typeof postRow>[]) =>
    planDb(plan, (sql, params) => {
      if (!LEDGER_BY_SUBJECT.test(sql)) return undefined;
      expect(params).toEqual(["customer_payments", ids.paymentId]);
      return rows;
    }).withTenant(ctx.session.tenantId, (q) => paymentReapplyLimit(q, ctx, ids));

  beforeEach(() => {
    flags.customerPaymentsEnabled = true;
  });
  afterEach(() => {
    flags.customerPaymentsEnabled = false;
  });

  it("is limit_unavailable with customer payments switched off", async () => {
    flags.customerPaymentsEnabled = false;
    expect(await run(plan, ids)).toMatchObject({ ok: false, reason: "limit_unavailable" });
  });

  it("allows exactly the engine's planted finding, for the application's amount", async () => {
    const out = await run(plan, ids);
    expect(out).toMatchObject({
      ok: true,
      limitCents: applied.amount_cents,
      requestedCents: applied.amount_cents,
      reasons: ["payment_on_wrong_invoice"],
    });
    if (out.ok) {
      expect(out.sources).toEqual([
        { table: "customer_payments", id: ids.paymentId },
        { table: "payment_applications", id: ids.applicationId },
        { table: "invoices", id: ids.fromInvoiceId },
        { table: "invoices", id: ids.toInvoiceId },
      ]);
    }
  });

  it("refuses any target the engine did not name, and the reverse move", async () => {
    const other = plan.rows.invoices.find(
      (i) => i.customer_id === w.customerId && i.id !== ids.fromInvoiceId && i.id !== ids.toInvoiceId,
    );
    expect(other).toBeDefined();
    expect(await run(plan, { ...ids, toInvoiceId: other!.id })).toMatchObject({ ok: false, reason: "engine_refused" });
    expect(
      await run(plan, { ...ids, fromInvoiceId: ids.toInvoiceId, toInvoiceId: ids.fromInvoiceId }),
    ).toMatchObject({ ok: false, reason: "engine_refused" });
  });

  it("refuses a payment already posted to QuickBooks", async () => {
    const posted = {
      ...plan,
      rows: {
        ...plan.rows,
        customer_payments: plan.rows.customer_payments.map((p) =>
          p.id === ids.paymentId ? { ...p, qbo_id: "9001" } : p,
        ),
      },
    };
    expect(await run(posted, ids)).toMatchObject({ ok: false, reason: "engine_refused" });
  });

  it("refuses a payment whose post is reserved, sent or not yet known, and allows one that failed", async () => {
    for (const state of ["unknown", "reserved", "sent", "confirmed"]) {
      expect(await withLedger([postRow(state)]), state).toMatchObject({ ok: false, reason: "engine_refused" });
    }
    // A post that failed made nothing outside, so the move may go.
    expect(await withLedger([postRow("failed")])).toMatchObject({ ok: true, reasons: ["payment_on_wrong_invoice"] });
    expect(await withLedger([])).toMatchObject({ ok: true });
  });

  it("is limit_unavailable for an application or payment it cannot read", async () => {
    expect(await run(plan, { ...ids, applicationId: OTHER_ID })).toMatchObject({
      ok: false,
      reason: "limit_unavailable",
    });
    expect(await run(plan, { ...ids, paymentId: OTHER_ID })).toMatchObject({
      ok: false,
      reason: "limit_unavailable",
    });
  });
});

describe("detention charge limit", () => {
  // The seed's four planted loads and the cents the seed golden records for them.
  const ids = plan.planted.detentionLoadIds;
  const GOLDEN = [41_250, 30_000, 37_500, 26_250];
  const [first] = ids;
  const firstInvoice = plan.rows.invoices.find((i) => i.load_id === first)!;

  type Rows = CarrierPlan["rows"];
  const planWith = (change: (rows: Rows) => Partial<Rows>): CarrierPlan => ({
    ...plan,
    rows: { ...plan.rows, ...change(plan.rows) },
  });
  const withInvoice = (over: Partial<Rows["invoices"][number]>) =>
    planWith((r) => ({ invoices: r.invoices.map((i) => (i.id === firstInvoice.id ? { ...i, ...over } : i)) }));
  const withLoad = (over: Partial<Rows["loads"][number]>) =>
    planWith((r) => ({ loads: r.loads.map((l) => (l.id === first ? { ...l, ...over } : l)) }));

  const run = (amountCents: number, loadId: string = first, p: CarrierPlan = plan) =>
    planDb(p).withTenant(ctx.session.tenantId, (q) => detentionChargeLimit(q, ctx, { loadId, amountCents }));

  const on = () => {
    flags.detentionEnabled = true;
  };
  afterEach(() => {
    flags.detentionEnabled = false;
  });

  it("allows exactly the engine's cents for each planted load, citing the load, customer and invoice", async () => {
    on();
    for (const [i, loadId] of ids.entries()) {
      const out = await run(GOLDEN[i], loadId);
      expect(out, loadId).toMatchObject({ ok: true, limitCents: GOLDEN[i], requestedCents: GOLDEN[i] });
      if (out.ok) expect(out.sources.map((s) => s.table)).toEqual(["loads", "customers", "invoices"]);
    }
  });

  it("refuses any other cents and names the engine's figure", async () => {
    on();
    expect(await run(GOLDEN[0] + 1)).toMatchObject({ ok: false, reason: "engine_refused", limitCents: GOLDEN[0] });
    expect(await run(GOLDEN[0] - 1)).toMatchObject({ ok: false, reason: "engine_refused", limitCents: GOLDEN[0] });
  });

  it("refuses a load that already carries a detention charge", async () => {
    on();
    const billed = planWith((r) => ({
      load_accessorials: [
        ...r.load_accessorials,
        {
          id: "0d7c1f9e-2a4b-4c6d-8e0f-1a2b3c4d5e6f",
          load_id: first,
          kind: "detention",
          seq: 1,
          amount_cents: GOLDEN[0],
          paid_by_driver: false,
          description: "Detention",
        },
      ],
    }));
    expect(await run(GOLDEN[0], first, billed)).toMatchObject({ ok: false, reason: "engine_refused", limitCents: null });
  });

  it("refuses an invoice posted to accounting, paid, or already different from the engine", async () => {
    on();
    for (const p of [
      withInvoice({ qbo_id: "1042" }),
      withInvoice({ status: "paid" }),
      withInvoice({ amount_cents: firstInvoice.amount_cents + 100 }),
      planWith((r) => ({ invoices: r.invoices.filter((i) => i.id !== firstInvoice.id) })),
    ]) {
      expect(await run(GOLDEN[0], first, p)).toMatchObject({ ok: false, reason: "engine_refused", limitCents: null });
    }
  });

  it("refuses a load whose stop times are not known: unknown is not zero", async () => {
    on();
    const none = withLoad({ pickup_arrived_at: null, pickup_departed_at: null });
    expect(await run(GOLDEN[0], first, none)).toMatchObject({ ok: false, reason: "engine_refused" });
    // One time of a stop missing is malformed: the limit cannot be computed.
    const half = withLoad({ delivery_departed_at: null });
    expect(await run(GOLDEN[0], first, half)).toMatchObject({ ok: false, reason: "limit_unavailable" });
  });

  it("refuses above the cap even when it is the engine's figure", async () => {
    on();
    const cap = flags.gatewayLimits.detentionChargeMaxCents;
    flags.gatewayLimits.detentionChargeMaxCents = 30_000;
    try {
      expect(await run(GOLDEN[0])).toMatchObject({ ok: false, reason: "amount_over_limit", limitCents: 30_000 });
    } finally {
      flags.gatewayLimits.detentionChargeMaxCents = cap;
    }
  });

  it("is unavailable while switched off and for a load it cannot read", async () => {
    expect(await run(GOLDEN[0])).toMatchObject({ ok: false, reason: "limit_unavailable" });
    on();
    expect(await run(1000, OTHER_ID)).toMatchObject({ ok: false, reason: "limit_unavailable" });
  });
});
