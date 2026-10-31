import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { requestIdOf } from "../../money/keys";
import { MoneyError, type SimBehavior } from "../../money/types";
import { cardPuller } from "../index";
import type { CardPullRequest } from "../types";
import { createCardPuller, pullId } from "./fuel-card-sim";

const saved = { ...flags, cardPullback: { ...flags.cardPullback } };
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const DRIVER = "33333333-3333-4333-8333-333333333333";
const REQUEST = requestIdOf(ACTION);
const TOKEN = "fcs_card_0123456789abcdef01234567";

const request = (behavior: SimBehavior = "ok", over: Partial<CardPullRequest> = {}): CardPullRequest => ({
  actionId: ACTION,
  driverId: DRIVER,
  amountCents: 12_500,
  memoCode: `card_pullbacks:${OTHER}`,
  destination: { rail: "fuel_card", provider: "fuel_card_sim", token: TOKEN, last4: "4321", simBehavior: behavior },
  ...over,
});
const ctx = (requestId = REQUEST) => ({ requestId, timeoutMs: 1_000, tenantZone: "America/Chicago" });
const ref = (r: CardPullRequest, outsideId?: string | null) => ({ requestId: REQUEST, outsideId, request: r });

function make() {
  const lines: string[] = [];
  return { sim: createCardPuller({ log: (l) => lines.push(l) }), lines };
}

const ID = `fcs_pull_${createHash("sha256").update(`pull:${REQUEST}`).digest("hex").slice(0, 24)}`;

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.cardPullback = { ...saved.cardPullback, enabled: true };
});

afterEach(() => {
  Object.assign(flags, saved, { cardPullback: { ...saved.cardPullback } });
});

describe("simulated card pull-backs", () => {
  it("derives the pull id from the request id, the same every time", () => {
    expect(pullId(REQUEST)).toBe(ID);
    expect(ID).toMatch(/^fcs_pull_[0-9a-f]{24}$/);
    expect(pullId(requestIdOf(OTHER))).not.toBe(ID);
  });

  it("pulls at once on an ok card, reads the same pull back, and never logs the token or last four", async () => {
    const { sim, lines } = make();
    const sent = await sim.pullBack(request(), ctx());
    expect(sent).toEqual({ kind: "confirmed", system: "fuel_card_sim", type: "card_pull", id: ID, amountCents: 12_500 });
    expect(await sim.readBackPull(ref(request(), ID), ctx())).toEqual({
      found: true,
      system: "fuel_card_sim",
      type: "card_pull",
      id: ID,
      amountCents: 12_500,
      status: "succeeded",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ID);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("4321");
  });

  it("answers each card behavior as a load does", async () => {
    const { sim } = make();
    expect(await sim.pullBack(request("declined"), ctx())).toEqual({ kind: "failed", category: "declined" });
    expect(await sim.readBackPull(ref(request("declined")), ctx())).toEqual({ found: false });
    expect(await sim.pullBack(request("slow"), ctx())).toEqual({ kind: "unknown", category: "timeout" });
    expect(await sim.readBackPull(ref(request("slow")), ctx())).toMatchObject({ found: true, status: "succeeded" });
    expect(await sim.pullBack(request("offline"), ctx())).toEqual({ kind: "unknown", category: "unavailable" });
    await expect(sim.readBackPull(ref(request("offline")), ctx())).rejects.toThrow(MoneyError);
  });

  it("refuses a request that is not whole, before anything else", async () => {
    const { sim, lines } = make();
    for (const bad of [
      request("ok", { amountCents: 0 }),
      request("ok", { amountCents: 12.5 }),
      request("ok", { actionId: OTHER }),
      request("ok", { driverId: "not-a-uuid" }),
      request("ok", { memoCode: "" }),
      request("ok", { destination: { rail: "fuel_card", provider: "fuel_card_sim", token: "card_1", last4: "4321", simBehavior: "ok" } }),
    ]) {
      expect(await sim.pullBack(bad, ctx())).toEqual({ kind: "failed", category: "validation" });
    }
    expect(await sim.pullBack(request(), ctx(requestIdOf(OTHER)))).toEqual({ kind: "failed", category: "validation" });
    await expect(sim.readBackPull(ref(request(), "fcs_pull_000000000000000000000000"), ctx())).rejects.toThrow(MoneyError);
    expect(lines).toEqual([]);
  });

  it("re-reads both switches on every call", async () => {
    const { sim } = make();
    flags.cardPullback = { ...flags.cardPullback, enabled: false };
    expect(await sim.ready()).toEqual({ ok: false, category: "disabled" });
    expect(await sim.pullBack(request(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    await expect(sim.readBackPull(ref(request()), ctx())).rejects.toThrow(MoneyError);
    flags.cardPullback = { ...flags.cardPullback, enabled: true };
    flags.payoutsEnabled = false;
    expect(await sim.ready()).toEqual({ ok: false, category: "disabled" });
    expect(await sim.pullBack(request(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    flags.payoutsEnabled = true;
    expect(await sim.ready()).toEqual({ ok: true });
  });

  it("is one puller for the app", () => {
    expect(cardPuller()).toBe(cardPuller());
    expect(cardPuller().system).toBe("fuel_card_sim");
  });
});
