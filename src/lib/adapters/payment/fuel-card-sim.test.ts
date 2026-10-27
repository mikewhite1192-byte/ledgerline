import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { requestIdOf } from "../../money/keys";
import { MoneyError, type SimBehavior } from "../../money/types";
import { paymentAdapter } from "../index";
import type { PayoutRequest } from "../types";
import { createFuelCardSimAdapter, loadId } from "./fuel-card-sim";

const saved = { ...flags };
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const DRIVER = "33333333-3333-4333-8333-333333333333";
const TOKEN = "fcs_card_0123456789abcdef01234567";

const destination = (simBehavior: SimBehavior = "ok") => ({
  rail: "fuel_card" as const,
  provider: "fuel_card_sim" as const,
  token: TOKEN,
  last4: "4417",
  simBehavior,
});
const payout = (simBehavior: SimBehavior = "ok", over: Partial<PayoutRequest> = {}): PayoutRequest => ({
  actionId: ACTION,
  driverId: DRIVER,
  amountCents: 25_000,
  memoCode: `advances:${OTHER}`,
  rail: "fuel_card",
  destination: destination(simBehavior),
  ...over,
});
const ctx = (requestId = requestIdOf(ACTION)) => ({ requestId, timeoutMs: 1_000, tenantZone: "America/Chicago" });
const ref = (p: PayoutRequest, outsideId?: string | null) => ({ requestId: requestIdOf(ACTION), outsideId, payout: p });

function make() {
  const lines: string[] = [];
  return { sim: createFuelCardSimAdapter({ log: (l) => lines.push(l) }), lines };
}

const LOAD = `fcs_load_${createHash("sha256").update(`load:${requestIdOf(ACTION)}`).digest("hex").slice(0, 24)}`;

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.paymentProvider = "mock";
});

afterEach(() => {
  Object.assign(flags, saved);
});

describe("simulated fuel-card provider", () => {
  it("names each load by a pure function of the request id", () => {
    expect(loadId(requestIdOf(ACTION))).toBe(LOAD);
    expect(LOAD).toMatch(/^fcs_load_[0-9a-f]{24}$/);
    expect(loadId(requestIdOf(OTHER))).not.toBe(LOAD);
  });

  it("is ready only while payoutsEnabled is on", async () => {
    const { sim } = make();
    expect(sim.system).toBe("fuel_card_sim");
    expect(await sim.ready()).toEqual({ ok: true });
    flags.payoutsEnabled = false;
    expect(await sim.ready()).toEqual({ ok: false, category: "disabled" });
  });

  it("confirms an ok card at send, and reads the same load back", async () => {
    const { sim, lines } = make();
    const sent = await sim.sendPayout(payout("ok"), ctx());
    expect(sent).toEqual({ kind: "confirmed", system: "fuel_card_sim", type: "card_load", id: LOAD, amountCents: 25_000 });
    expect(await sim.readBack(ref(payout("ok"), LOAD), ctx())).toEqual({
      found: true,
      system: "fuel_card_sim",
      type: "card_load",
      id: LOAD,
      amountCents: 25_000,
      status: "succeeded",
    });
    // The log names the behavior, the load and the amount, never the token or the last four.
    expect(lines).toEqual([`fuelcard: ok load ${LOAD} 25000c for advances:${OTHER}`]);
    expect(lines.join(" ")).not.toContain(TOKEN);
    expect(lines.join(" ")).not.toContain("4417");
  });

  it("gives the same load id from two fresh adapters, so a resend lands on the same load", async () => {
    const a = await make().sim.sendPayout(payout("ok"), ctx());
    const b = await make().sim.sendPayout(payout("ok"), ctx());
    expect(a).toEqual(b);
  });

  it("declines a declined card definitely at send, and finds nothing on read-back", async () => {
    const { sim } = make();
    expect(await sim.sendPayout(payout("declined"), ctx())).toEqual({ kind: "failed", category: "declined" });
    expect(await sim.readBack(ref(payout("declined")), ctx())).toEqual({ found: false });
  });

  it("loses the reply for a slow card, and the read-back finds the load that landed", async () => {
    const { sim } = make();
    expect(await sim.sendPayout(payout("slow"), ctx())).toEqual({ kind: "unknown", category: "timeout" });
    expect(await sim.readBack(ref(payout("slow")), ctx())).toMatchObject({ found: true, id: LOAD, status: "succeeded" });
  });

  it("stays unknown for an offline card: the send is unavailable and the read-back throws", async () => {
    const { sim } = make();
    expect(await sim.sendPayout(payout("offline"), ctx())).toEqual({ kind: "unknown", category: "unavailable" });
    await expect(sim.readBack(ref(payout("offline")), ctx())).rejects.toMatchObject({ category: "unavailable" });
  });

  it("refuses at send and at read-back while the switch is off", async () => {
    const { sim, lines } = make();
    flags.payoutsEnabled = false;
    expect(await sim.sendPayout(payout("ok"), ctx())).toEqual({ kind: "failed", category: "disabled" });
    await expect(sim.readBack(ref(payout("ok")), ctx())).rejects.toMatchObject({ category: "disabled" });
    expect(lines).toEqual([]);
  });

  it("refuses a request that is not whole: wrong rail, a bank destination, a bad token, ids and amounts", async () => {
    const { sim, lines } = make();
    const bad: [PayoutRequest, ReturnType<typeof ctx>][] = [
      [payout("ok", { rail: "bank" }), ctx()],
      [payout("ok", { destination: undefined }), ctx()],
      [payout("ok", { destination: { ...destination(), rail: "bank" } as never }), ctx()],
      [payout("ok", { destination: { ...destination(), token: `${TOKEN}0` } }), ctx()],
      [payout("ok", { destination: { ...destination(), token: TOKEN.slice(0, -1) } }), ctx()],
      [payout("ok", { destination: { ...destination(), last4: "441" } }), ctx()],
      [payout("ok", { destination: { ...destination(), simBehavior: "late" as never } }), ctx()],
      [payout("ok"), ctx(requestIdOf(ACTION).slice(0, 31))],
      [payout("ok"), ctx(requestIdOf(OTHER))],
      [payout("ok", { amountCents: 0 }), ctx()],
      [payout("ok", { amountCents: 1.5 }), ctx()],
      [payout("ok", { memoCode: "" }), ctx()],
    ];
    for (const [p, c] of bad) {
      expect(await sim.sendPayout(p, c)).toEqual({ kind: "failed", category: "validation" });
      await expect(sim.readBack({ requestId: c.requestId, payout: p }, c)).rejects.toMatchObject({ category: "validation" });
    }
    expect(lines).toEqual([]);
  });

  it("refuses a read-back for another load id or a request id that is not the context's, compared whole", async () => {
    const { sim } = make();
    await expect(sim.readBack(ref(payout("ok"), LOAD.slice(0, -1)), ctx())).rejects.toBeInstanceOf(MoneyError);
    await expect(sim.readBack(ref(payout("ok"), `${LOAD}0`), ctx())).rejects.toMatchObject({ category: "validation" });
    await expect(
      sim.readBack({ requestId: requestIdOf(OTHER), payout: payout("ok") }, ctx()),
    ).rejects.toMatchObject({ category: "validation" });
  });
});

describe("rail routing", () => {
  it("sends the fuel-card rail to the simulated provider, the same instance every time", () => {
    expect(paymentAdapter("fuel_card").system).toBe("fuel_card_sim");
    expect(paymentAdapter("fuel_card")).toBe(paymentAdapter("fuel_card"));
    flags.paymentProvider = "stripe_test";
    // The bank provider switch never moves the card rail.
    expect(paymentAdapter("fuel_card").system).toBe("fuel_card_sim");
    expect(paymentAdapter("bank").system).toBe("stripe_test");
  });
});
