import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { requestIdOf } from "../../money/keys";
import { MoneyError } from "../../money/types";
import { factoringAdapter } from "../index";
import type { FactoringSubmission } from "../types";
import { advanceRef, createFactoringSim, factoringBehavior } from "./sim";

const savedPayouts = flags.payoutsEnabled;
const savedFactoring = { ...flags.factoring };
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CUSTOMER = "33333333-3333-4333-8333-333333333333";

// 10,000.00 balance at a 90% advance and a 3% fee: advance 9,000.00, fee 300.00, net 8,700.00,
// reserve 1,000.00. The balance's last two digits pick the partner's answer.
function submission(balanceCents = 1_000_000, over: Partial<FactoringSubmission> = {}): FactoringSubmission {
  const advanceCents = Math.round(balanceCents * 0.9);
  const feeCents = Math.round(balanceCents * 0.03);
  return {
    actionId: ACTION,
    invoiceNumber: "INV-1042",
    customerCode: CUSTOMER,
    balanceCents,
    advanceCents,
    feeCents,
    netCents: advanceCents - feeCents,
    reserveCents: balanceCents - advanceCents,
    ...over,
  };
}
const ctx = (requestId = requestIdOf(ACTION)) => ({ requestId, timeoutMs: 1_000, tenantZone: "America/Chicago" });

function make() {
  const lines: string[] = [];
  return { sim: createFactoringSim({ log: (l) => lines.push(l) }), lines };
}

const REF = `fsim_adv_${createHash("sha256").update(`adv:${requestIdOf(ACTION)}`).digest("hex").slice(0, 24)}`;

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.factoring = { ...savedFactoring, enabled: true, armed: true };
});

afterEach(() => {
  flags.payoutsEnabled = savedPayouts;
  flags.factoring = { ...savedFactoring };
});

describe("the simulated factoring partner", () => {
  it("derives the same reference from the same request id, and another from another", () => {
    expect(advanceRef(requestIdOf(ACTION))).toBe(REF);
    expect(advanceRef(requestIdOf(ACTION))).toBe(advanceRef(requestIdOf(ACTION)));
    expect(advanceRef("0".repeat(32))).not.toBe(REF);
    expect(REF).toMatch(/^fsim_adv_[0-9a-f]{24}$/);
  });

  it("reads the outcome from the balance's last two digits", () => {
    expect(factoringBehavior(1_000_000)).toBe("funded");
    expect(factoringBehavior(1_000_099)).toBe("declined");
    expect(factoringBehavior(1_000_098)).toBe("slow");
    expect(factoringBehavior(1_000_097)).toBe("funded");
  });

  it("funds an ordinary invoice with the advance less the fee", async () => {
    const { sim, lines } = make();
    const out = await sim.submitInvoice(submission(), ctx());
    expect(out).toEqual({ kind: "confirmed", system: "factoring_sim", type: "factoring_advance", id: REF, amountCents: 870_000 });
    expect(lines).toEqual([`factoring: invoice INV-1042 funded ${REF} 870000c of 1000000c`]);
  });

  it("declines a ..99 balance as a definite no, and reads it back failed", async () => {
    const { sim } = make();
    const s = submission(1_000_099);
    expect(await sim.submitInvoice(s, ctx())).toEqual({ kind: "failed", category: "declined" });
    expect(await sim.readBack({ requestId: requestIdOf(ACTION), request: s }, ctx())).toMatchObject({
      found: true,
      status: "failed",
      id: REF,
    });
  });

  it("answers a ..98 balance with a timeout, and the read-back finds it funded", async () => {
    const { sim } = make();
    const s = submission(1_000_098);
    expect(await sim.submitInvoice(s, ctx())).toEqual({ kind: "unknown", category: "timeout" });
    expect(await sim.readBack({ requestId: requestIdOf(ACTION), outsideId: null, request: s }, ctx())).toEqual({
      found: true,
      system: "factoring_sim",
      type: "factoring_advance",
      id: REF,
      amountCents: s.netCents,
      status: "succeeded",
    });
  });

  it("refuses a submission whose arithmetic is not the engine's, or whose request id is another row's", async () => {
    const { sim, lines } = make();
    const bad = [
      submission(1_000_000, { netCents: 870_001 }),
      submission(1_000_000, { reserveCents: 99_999 }),
      submission(1_000_000, { balanceCents: 0 }),
      submission(1_000_000, { invoiceNumber: "Acme Freight" }),
      submission(1_000_000, { customerCode: "Acme" }),
      submission(1_000_000, { feeCents: 0.5 }),
    ];
    for (const s of bad) expect(await sim.submitInvoice(s, ctx())).toEqual({ kind: "failed", category: "validation" });
    expect(await sim.submitInvoice(submission(), ctx("0".repeat(32)))).toEqual({ kind: "failed", category: "validation" });
    expect(lines).toEqual([]);
  });

  it("is not ready and submits nothing while any switch is off or it is not armed", async () => {
    const { sim, lines } = make();
    for (const turnOff of [
      () => (flags.payoutsEnabled = false),
      () => (flags.factoring = { ...flags.factoring, enabled: false }),
      () => (flags.factoring = { ...flags.factoring, armed: false }),
    ]) {
      flags.payoutsEnabled = true;
      flags.factoring = { ...savedFactoring, enabled: true, armed: true };
      expect(await sim.ready()).toEqual({ ok: true });
      turnOff();
      expect(await sim.ready()).toEqual({ ok: false, category: "disabled" });
      expect(await sim.submitInvoice(submission(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    }
    expect(lines).toEqual([]);
  });

  it("refuses a read-back for another reference, a bad request or while switched off", async () => {
    const { sim } = make();
    const s = submission();
    await expect(
      sim.readBack({ requestId: requestIdOf(ACTION), outsideId: "fsim_adv_000000000000000000000000", request: s }, ctx()),
    ).rejects.toMatchObject({ category: "validation" });
    await expect(sim.readBack({ requestId: "0".repeat(32), request: s }, ctx())).rejects.toBeInstanceOf(
      MoneyError,
    );
    flags.factoring = { ...flags.factoring, enabled: false };
    await expect(sim.readBack({ requestId: requestIdOf(ACTION), request: s }, ctx())).rejects.toMatchObject(
      { category: "disabled" },
    );
  });

  it("never logs a name: only the invoice number, the reference and the cents", async () => {
    const { sim, lines } = make();
    await sim.submitInvoice(submission(1_000_098), ctx());
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(CUSTOMER);
    expect(lines[0]).toMatch(/^factoring: invoice INV-1042 slow fsim_adv_[0-9a-f]{24} \d+c of \d+c$/);
  });

  it("is the app's one factoring adapter", () => {
    expect(factoringAdapter().system).toBe("factoring_sim");
    expect(factoringAdapter()).toBe(factoringAdapter());
  });
});
