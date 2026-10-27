import { describe, expect, it } from "vitest";
import { loadsOf } from "../../../data/records";
import { readAdvanceInput } from "../../../data/read";
import { advanceEligibility, invoiceAmount } from "../../../rules-engine";
import { instantAt } from "../../../seed/calendar";
import { CASE_A_ASK_CENTS } from "../../../seed/untrusted-inputs";
import { addDays } from "../../../time/local-date";
import { advanceLimit, invoiceFixLimit, paymentReapplyLimit, payCorrectionLimit } from "../limits";
import type { GatewayContext } from "../types";
import { context, OTHER_ID } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

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
    if (other) {
      expect(await run(plan, { ...ids, toInvoiceId: other.id })).toMatchObject({ ok: false, reason: "engine_refused" });
    }
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
