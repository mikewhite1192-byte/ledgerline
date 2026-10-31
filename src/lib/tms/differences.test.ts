import { describe, expect, it } from "vitest";
import { DELIVERY_SLACK_MINUTES, PICKUP_SLACK_MINUTES, differencesOf, dwellMinutes, ourRevenueCents, type OurSide, type TmsSide } from "./differences";

// Where the dispatch copy of a load and ours disagree, in code: each difference on its own, nothing
// said about a value either side does not know, the pickup and delivery slack at its edge, and the two helpers.

const tms = (over: Partial<TmsSide> = {}): TmsSide => ({
  statusCode: "in_transit",
  revenueTotalCents: 150_000,
  pickedUpAt: null,
  deliveredAt: null,
  goneAt: null,
  flags: [],
  hasPodDocument: false,
  ...over,
});
const ours = (over: Partial<OurSide> = {}): OurSide => ({
  status: "in_transit",
  revenueCents: 150_000,
  pickedUpAt: null,
  deliveredAt: null,
  hasPod: false,
  ...over,
});

describe("differencesOf", () => {
  it("finds none when the two sides agree", () => {
    expect(differencesOf(tms(), ours())).toEqual([]);
  });

  it("says a rate differs in cents, with the signed delta, and never when either rate is unknown", () => {
    expect(differencesOf(tms({ revenueTotalCents: 162_550 }), ours())).toEqual([
      { kind: "rate_differs", dispatchCents: 162_550, oursCents: 150_000, deltaCents: 12_550 },
    ]);
    expect(differencesOf(tms({ revenueTotalCents: 140_000 }), ours())[0]).toMatchObject({ deltaCents: -10_000 });
    expect(differencesOf(tms({ revenueTotalCents: null }), ours())).toEqual([]);
    expect(differencesOf(tms(), ours({ revenueCents: null }))).toEqual([]);
    expect(differencesOf(tms({ revenueTotalCents: 1.5 }), ours())).toEqual([]);
  });

  it("says dispatch is ahead or behind on the shared scale, and never compares a code off it", () => {
    expect(differencesOf(tms({ statusCode: "delivered" }), ours())).toEqual([
      { kind: "status_ahead", dispatchStatus: "delivered", ourStatus: "in_transit" },
    ]);
    expect(differencesOf(tms({ statusCode: "booked" }), ours())).toEqual([
      { kind: "status_behind", dispatchStatus: "booked", ourStatus: "in_transit" },
    ]);
    // Past delivered on both sides is the same place.
    expect(differencesOf(tms({ statusCode: "paid" }), ours({ status: "invoiced" }))).toEqual([]);
    for (const code of ["on_hold", "breakdown", "claim", "custom", "cancelled", "toString"]) {
      expect(differencesOf(tms({ statusCode: code }), ours({ status: "planned" })), code).toEqual([]);
    }
    expect(differencesOf(tms({ statusCode: "delivered" }), ours({ status: "constructor" }))).toEqual([]);
  });

  it("says delivery times differ only past the slack, in whole minutes", () => {
    const at = "2026-11-02T15:00:00.000Z";
    const edge = new Date(Date.parse(at) + DELIVERY_SLACK_MINUTES * 60_000).toISOString();
    const past = new Date(Date.parse(at) + (DELIVERY_SLACK_MINUTES + 1) * 60_000).toISOString();
    expect(DELIVERY_SLACK_MINUTES).toBe(30);
    expect(differencesOf(tms({ deliveredAt: at }), ours({ deliveredAt: edge }))).toEqual([]);
    expect(differencesOf(tms({ deliveredAt: past }), ours({ deliveredAt: at }))).toEqual([
      { kind: "delivery_time_differs", dispatchAt: past, oursAt: at, minutesApart: 31 },
    ]);
    expect(differencesOf(tms({ deliveredAt: at }), ours({ deliveredAt: null }))).toEqual([]);
    expect(differencesOf(tms({ deliveredAt: "not a time" }), ours({ deliveredAt: past }))).toEqual([]);
    // A second past the slack is a difference, though it rounds to the slack's own minutes.
    const justPast = new Date(Date.parse(edge) + 1_000).toISOString();
    expect(differencesOf(tms({ deliveredAt: justPast }), ours({ deliveredAt: at }))).toEqual([
      { kind: "delivery_time_differs", dispatchAt: justPast, oursAt: at, minutesApart: 30 },
    ]);
  });

  it("says pickup times differ only past the slack, either way round, in whole minutes", () => {
    const at = "2026-11-01T14:15:00.000Z";
    const edge = new Date(Date.parse(at) + PICKUP_SLACK_MINUTES * 60_000).toISOString();
    const past = new Date(Date.parse(at) + (PICKUP_SLACK_MINUTES + 1) * 60_000).toISOString();
    expect(PICKUP_SLACK_MINUTES).toBe(30);
    expect(differencesOf(tms({ pickedUpAt: at }), ours({ pickedUpAt: at }))).toEqual([]);
    expect(differencesOf(tms({ pickedUpAt: at }), ours({ pickedUpAt: edge }))).toEqual([]);
    expect(differencesOf(tms({ pickedUpAt: edge }), ours({ pickedUpAt: at }))).toEqual([]);
    expect(differencesOf(tms({ pickedUpAt: past }), ours({ pickedUpAt: at }))).toEqual([
      { kind: "pickup_time_differs", dispatchAt: past, oursAt: at, minutesApart: 31 },
    ]);
    expect(differencesOf(tms({ pickedUpAt: at }), ours({ pickedUpAt: past }))).toEqual([
      { kind: "pickup_time_differs", dispatchAt: at, oursAt: past, minutesApart: 31 },
    ]);
    expect(differencesOf(tms({ pickedUpAt: at }), ours({ pickedUpAt: null }))).toEqual([]);
    expect(differencesOf(tms({ pickedUpAt: null }), ours({ pickedUpAt: past }))).toEqual([]);
    expect(differencesOf(tms({ pickedUpAt: "not a time" }), ours({ pickedUpAt: past }))).toEqual([]);
    expect(differencesOf(tms({ pickedUpAt: past }), ours({ pickedUpAt: "not a time" }))).toEqual([]);
    const justPast = new Date(Date.parse(edge) + 1_000).toISOString();
    expect(differencesOf(tms({ pickedUpAt: at }), ours({ pickedUpAt: justPast }))).toEqual([
      { kind: "pickup_time_differs", dispatchAt: at, oursAt: justPast, minutesApart: 30 },
    ]);
  });

  it("says a proof of delivery is in dispatch and not here, a load gone from dispatch, and an edit after finalize", () => {
    expect(differencesOf(tms({ hasPodDocument: true }), ours())).toEqual([{ kind: "pod_in_dispatch_not_here" }]);
    expect(differencesOf(tms({ hasPodDocument: true }), ours({ hasPod: true }))).toEqual([]);
    expect(differencesOf(tms({ goneAt: "2026-11-02T12:00:00.000Z" }), ours())).toEqual([
      { kind: "gone_from_dispatch", goneAt: "2026-11-02T12:00:00.000Z" },
    ]);
    expect(differencesOf(tms({ flags: ["clocks_disagree", "edited_after_finalize"] }), ours())).toEqual([
      { kind: "edited_after_finalize" },
    ]);
  });

  it("lists several differences in a fixed order", () => {
    const all = differencesOf(
      tms({
        statusCode: "delivered",
        revenueTotalCents: 151_000,
        pickedUpAt: "2026-11-01T15:00:00.000Z",
        deliveredAt: "2026-11-02T18:00:00.000Z",
        goneAt: "2026-11-02T19:00:00.000Z",
        flags: ["edited_after_finalize"],
        hasPodDocument: true,
      }),
      ours({ status: "delivered", pickedUpAt: "2026-11-01T14:00:00.000Z", deliveredAt: "2026-11-02T16:00:00.000Z" }),
    );
    expect(all.map((d) => d.kind)).toEqual([
      "rate_differs",
      "pickup_time_differs",
      "delivery_time_differs",
      "pod_in_dispatch_not_here",
      "gone_from_dispatch",
      "edited_after_finalize",
    ]);
  });
});

describe("ourRevenueCents", () => {
  it("adds linehaul, fuel surcharge and every extra charge, in cents", () => {
    expect(ourRevenueCents(150_000, 12_500, [7_500, 2_500])).toBe(172_500);
    expect(ourRevenueCents(150_000, null, [])).toBe(150_000);
  });

  it("is unknown while the linehaul is unknown or a charge is not whole cents", () => {
    expect(ourRevenueCents(null, 12_500, [])).toBeNull();
    expect(ourRevenueCents(150_000, 0, [12.5])).toBeNull();
    expect(ourRevenueCents(Number.MAX_SAFE_INTEGER, 1, [])).toBeNull();
  });
});

describe("dwellMinutes", () => {
  it("counts the minutes from arrival to leaving, and is unknown when a time is missing or runs backward", () => {
    expect(dwellMinutes("2026-11-02T14:00:00.000Z", "2026-11-02T16:15:00.000Z")).toBe(135);
    expect(dwellMinutes("2026-11-02T14:00:00.000Z", "2026-11-02T14:00:00.000Z")).toBe(0);
    expect(dwellMinutes(null, "2026-11-02T16:15:00.000Z")).toBeNull();
    expect(dwellMinutes("2026-11-02T14:00:00.000Z", null)).toBeNull();
    expect(dwellMinutes("2026-11-02T16:15:00.000Z", "2026-11-02T14:00:00.000Z")).toBeNull();
  });
});
