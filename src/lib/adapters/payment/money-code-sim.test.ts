import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { requestIdOf } from "../../money/keys";
import { MoneyError } from "../../money/types";
import { moneyCodeIssuer } from "../index";
import type { MoneyCodeRequest } from "../types";
import { codeBehavior, codeOf, codeRef, createMoneyCodeIssuer } from "./fuel-card-sim";

const saved = { ...flags, moneyCodes: { ...flags.moneyCodes } };
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const DRIVER = "33333333-3333-4333-8333-333333333333";
const REQUEST = requestIdOf(ACTION);

const request = (over: Partial<MoneyCodeRequest> = {}): MoneyCodeRequest => ({
  actionId: ACTION,
  driverId: DRIVER,
  amountCents: 15_000,
  memoCode: `money_codes:${OTHER}`,
  purpose: "lumper",
  ...over,
});
const ctx = (requestId = REQUEST) => ({ requestId, timeoutMs: 1_000, tenantZone: "America/Chicago" });
const ref = (r: MoneyCodeRequest, outsideId?: string | null) => ({ requestId: REQUEST, outsideId, request: r });

function make() {
  const lines: string[] = [];
  return { sim: createMoneyCodeIssuer({ log: (l) => lines.push(l) }), lines };
}

const HASH = createHash("sha256").update(`code:${REQUEST}`).digest("hex");
const REF = `fcs_code_${HASH.slice(0, 24)}`;
const CODE = (BigInt(`0x${HASH.slice(24, 40)}`) % 10_000_000_000n).toString().padStart(10, "0");

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.moneyCodes = { ...saved.moneyCodes, enabled: true, armed: true };
});

afterEach(() => {
  Object.assign(flags, saved, { moneyCodes: { ...saved.moneyCodes } });
});

describe("simulated money codes", () => {
  it("derives the reference and the ten-digit code from the request id, the same every time", () => {
    expect(codeRef(REQUEST)).toBe(REF);
    expect(REF).toMatch(/^fcs_code_[0-9a-f]{24}$/);
    expect(codeOf(REQUEST)).toBe(CODE);
    expect(codeOf(REQUEST)).toMatch(/^[0-9]{10}$/);
    expect(codeOf(requestIdOf(OTHER))).not.toBe(CODE);
    // The reference never contains the code.
    expect(REF).not.toContain(CODE);
    expect(() => codeOf("not-a-request-id")).toThrow(MoneyError);
  });

  it("reveals exactly the derived code and keeps its last four", () => {
    const { sim } = make();
    expect(sim.revealCode(REQUEST)).toBe(CODE);
    expect(sim.codeLast4(REQUEST)).toBe(CODE.slice(-4));
  });

  it("picks the behavior from the amount's last two digits", () => {
    expect(codeBehavior(15_000)).toBe("ok");
    expect(codeBehavior(15_099)).toBe("declined");
    expect(codeBehavior(15_098)).toBe("slow");
    expect(codeBehavior(99)).toBe("declined");
  });

  it("issues at once, reads the same code back, and never logs the code", async () => {
    const { sim, lines } = make();
    const sent = await sim.issueMoneyCode(request(), ctx());
    expect(sent).toEqual({ kind: "confirmed", system: "fuel_card_sim", type: "money_code", id: REF, amountCents: 15_000 });
    expect(await sim.readBackCode(ref(request(), REF), ctx())).toEqual({
      found: true,
      system: "fuel_card_sim",
      type: "money_code",
      id: REF,
      amountCents: 15_000,
      status: "succeeded",
    });
    sim.revealCode(REQUEST);
    expect(lines).toEqual([`fuelcard: money code ok ${REF} 15000c lumper for money_codes:${OTHER}`]);
    expect(lines.join(" ")).not.toContain(CODE);
    expect(JSON.stringify(sent)).not.toContain(CODE);
  });

  it("declines a ..99 amount definitely, and the read-back finds nothing", async () => {
    const { sim } = make();
    const r = request({ amountCents: 15_099 });
    expect(await sim.issueMoneyCode(r, ctx())).toEqual({ kind: "failed", category: "declined" });
    expect(await sim.readBackCode(ref(r), ctx())).toEqual({ found: false });
  });

  it("loses the reply for a ..98 amount, and the read-back finds the code that was issued", async () => {
    const { sim } = make();
    const r = request({ amountCents: 15_098 });
    expect(await sim.issueMoneyCode(r, ctx())).toEqual({ kind: "unknown", category: "timeout" });
    const back = await sim.readBackCode(ref(r), ctx());
    expect(back).toMatchObject({ found: true, id: REF, amountCents: 15_098, status: "succeeded" });
  });

  it("refuses while any switch is off: ready, issue, read-back and reveal", async () => {
    const { sim, lines } = make();
    flags.moneyCodes.armed = false;
    expect(await sim.ready()).toEqual({ ok: true });
    expect(await sim.issueMoneyCode(request(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    expect(await sim.readBackCode(ref(request()), ctx())).toMatchObject({ found: true });

    flags.moneyCodes.armed = true;
    flags.moneyCodes.enabled = false;
    expect(await sim.ready()).toEqual({ ok: false, category: "disabled" });
    expect(await sim.issueMoneyCode(request(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    await expect(sim.readBackCode(ref(request()), ctx())).rejects.toThrow(MoneyError);
    expect(() => sim.revealCode(REQUEST)).toThrow(MoneyError);

    flags.moneyCodes.enabled = true;
    flags.payoutsEnabled = false;
    expect(await sim.ready()).toEqual({ ok: false, category: "disabled" });
    expect(await sim.issueMoneyCode(request(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    await expect(sim.readBackCode(ref(request()), ctx())).rejects.toMatchObject({ category: "disabled" });
    expect(lines).toEqual([]);
  });

  it("refuses a request that is not whole: ids, amounts, memo, purpose and a foreign request id", async () => {
    const { sim, lines } = make();
    const bad: MoneyCodeRequest[] = [
      request({ actionId: OTHER }),
      request({ actionId: "nope" }),
      request({ driverId: "nope" }),
      request({ amountCents: 0 }),
      request({ amountCents: 150.5 }),
      request({ amountCents: 1_000_000_000 }),
      request({ memoCode: "" }),
      request({ memoCode: "x".repeat(81) }),
      request({ purpose: "fuel" as never }),
    ];
    for (const r of bad) {
      expect(await sim.issueMoneyCode(r, ctx())).toEqual({ kind: "failed", category: "validation" });
      await expect(sim.readBackCode(ref(r), ctx())).rejects.toMatchObject({ category: "validation" });
    }
    expect(await sim.issueMoneyCode(request(), ctx(requestIdOf(OTHER)))).toEqual({
      kind: "failed",
      category: "validation",
    });
    expect(lines).toEqual([]);
  });

  it("refuses a read-back for another reference or request id, compared whole", async () => {
    const { sim } = make();
    await expect(sim.readBackCode(ref(request(), `${REF}0`), ctx())).rejects.toMatchObject({ category: "validation" });
    await expect(sim.readBackCode(ref(request(), REF.slice(0, -1)), ctx())).rejects.toMatchObject({
      category: "validation",
    });
    await expect(
      sim.readBackCode({ requestId: requestIdOf(OTHER), request: request() }, ctx()),
    ).rejects.toMatchObject({ category: "validation" });
  });

  it("is one shared issuer in the app", () => {
    expect(moneyCodeIssuer()).toBe(moneyCodeIssuer());
    expect(moneyCodeIssuer().system).toBe("fuel_card_sim");
  });
});
