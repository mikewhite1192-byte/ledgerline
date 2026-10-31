import { describe, expect, it } from "vitest";
import { CONFIDENCE_FIELDS, type DocumentRead, type FieldConfidence, type StopClaim } from "../documents/types";
import {
  bolOf,
  paperworkOf,
  stampInstant,
  stopTimesOf,
  whyNotCounted,
  type PaperDocument,
  type PaperLoad,
} from "./paperwork";

const LOAD_ID = "11111111-1111-4111-8111-111111111111";
const LOAD: PaperLoad = { id: LOAD_ID, pickup_on: "2026-10-20", linehaul_cents: null };
const ZONE = "America/New_York";

function confidence(over: Partial<Record<string, FieldConfidence>> = {}) {
  return Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, over[f] ?? "high"])) as DocumentRead["confidence"];
}

function read(kind: "bill_of_lading" | "rate_confirmation", date: string | null, stops: StopClaim[] = []): DocumentRead {
  return {
    kind,
    fields: {
      sampleWord: false,
      vendor: null,
      date,
      totalCents: null,
      loadNumber: "BR-L1",
      truckUnit: null,
      gallonsMilli: null,
      priceCents: null,
      loadedMiles: null,
      ratePerMileCents: null,
      linehaulCents: kind === "rate_confirmation" ? 100000 : null,
      fuelSurchargeCents: null,
      customerName: null,
      stops,
    },
    textLines: [],
    confidence: confidence(),
  };
}

const SAME_NUMBER = [{ name: "load_number", claim: "BR-L1", record: "BR-L1", status: "same" }];
const matched = (fields: readonly Record<string, unknown>[] = SAME_NUMBER) => ({
  found: true,
  table: "loads",
  id: LOAD_ID,
  humanRef: "BR-L1",
  loadId: LOAD_ID,
  driverId: null,
  fields,
  notes: [],
  supports: null,
});

let seq = 0;
function bol(date: string | null, stops: StopClaim[] = [], over: Partial<PaperDocument> = {}): PaperDocument {
  seq += 1;
  const n = String(seq).padStart(2, "0");
  return {
    id: `00000000-0000-4000-8000-0000000000${n}`,
    readStatus: "read",
    kind: "bill_of_lading",
    read: read("bill_of_lading", date, stops),
    match: matched(),
    createdAt: `2026-10-25T12:${n}:00.000Z`,
    ...over,
  };
}

const pickupStop: StopClaim = { role: "pickup", arrived: null, departed: null };
const deliveryStop: StopClaim = { role: "delivery", arrived: null, departed: null };

describe("the pickup window", () => {
  it("counts a bill of lading from the day before pickup to two days after, and nothing outside", () => {
    expect(paperworkOf(LOAD, [bol("10/19/2026")]).pickupIn).toBe(true);
    expect(paperworkOf(LOAD, [bol("10/20/2026")]).pickupIn).toBe(true);
    expect(paperworkOf(LOAD, [bol("10/22/2026")]).pickupIn).toBe(true);
    expect(paperworkOf(LOAD, [bol("10/18/2026")]).pickupIn).toBe(false);
    expect(paperworkOf(LOAD, [bol("10/23/2026")]).pickupIn).toBe(false);
  });

  it("never takes a paper naming only the delivery stop as the pickup paper", () => {
    const p = paperworkOf(LOAD, [bol("10/20/2026", [deliveryStop])]);
    expect(p.pickupIn).toBe(false);
  });

  it("says why a paper dated outside both windows did not count", () => {
    const doc = bol("10/18/2026");
    expect(whyNotCounted(LOAD, doc, paperworkOf(LOAD, [doc]))).toBe("date_out_of_window");
  });
});

describe("the POD window", () => {
  it("counts a later paper up to fourteen days after pickup, and not on day fifteen", () => {
    const up = bol("10/20/2026", [pickupStop]);
    expect(paperworkOf(LOAD, [up, bol("11/03/2026")]).deliveryIn).toBe(true);
    const up2 = bol("10/20/2026", [pickupStop]);
    const late = bol("11/04/2026");
    const p = paperworkOf(LOAD, [up2, late]);
    expect(p.deliveryIn).toBe(false);
    expect(p.missing).toEqual(["rate_confirmation", "pod"]);
    expect(whyNotCounted(LOAD, late, p)).toBe("date_out_of_window");
  });

  it("with two bills of lading on the same day, the second is the POD only when it names the delivery stop", () => {
    const first = bol("10/20/2026");
    const second = bol("10/20/2026");
    const plain = paperworkOf(LOAD, [first, second]);
    expect(plain.pickupBol).toBe(first.id);
    expect(plain.pod).toBeNull();
    expect(whyNotCounted(LOAD, second, plain)).toBe("stop_unclear");

    // b is uploaded first; the one naming the delivery stop still sorts last.
    const b = bol("10/20/2026", [deliveryStop]);
    const a = bol("10/20/2026", [pickupStop]);
    const named = paperworkOf(LOAD, [b, a]);
    expect(named.pickupBol).toBe(a.id);
    expect(named.pod).toBe(b.id);
    expect(named.pickupIn && named.deliveryIn).toBe(true);
  });

  it("takes a paper naming only the delivery stop as the POD when no pickup paper is in", () => {
    const pod = bol("10/22/2026", [deliveryStop]);
    const p = paperworkOf(LOAD, [pod]);
    expect(p).toMatchObject({ pickupIn: false, deliveryIn: true, pod: pod.id, pickupBol: null });
  });

  it("calls a delivery paper with no pickup paper in no_pickup_paper when it cannot stand alone", () => {
    const both = bol("10/25/2026", [pickupStop, deliveryStop]);
    const p = paperworkOf(LOAD, [both]);
    expect(p.pickupIn || p.deliveryIn).toBe(false);
    expect(whyNotCounted(LOAD, both, p)).toBe("no_pickup_paper");
  });
});

describe("a paper that never counts", () => {
  it("refuses an unread, unmatched, differing or low confidence reading by category", () => {
    expect(bolOf(LOAD, bol("10/20/2026", [], { readStatus: "pending" }))).toEqual({ ok: false, reason: "not_read" });
    expect(bolOf(LOAD, bol("10/20/2026", [], { match: {} }))).toEqual({ ok: false, reason: "not_matched" });
    const other = { ...matched(), loadId: "22222222-2222-4222-8222-222222222222" };
    expect(bolOf(LOAD, bol("10/20/2026", [], { match: other }))).toEqual({ ok: false, reason: "not_matched" });
    const differs = matched([{ name: "load_number", claim: "BR-L2", record: "BR-L1", status: "differs" }]);
    expect(bolOf(LOAD, bol("10/20/2026", [], { match: differs }))).toEqual({ ok: false, reason: "field_differs" });
    const low = bol("10/20/2026", [], {
      read: { ...read("bill_of_lading", "10/20/2026"), confidence: confidence({ date_mmddyyyy: "low" }) },
    });
    expect(bolOf(LOAD, low)).toEqual({ ok: false, reason: "low_confidence" });
    expect(bolOf(LOAD, bol(null))).toEqual({ ok: false, reason: "no_date" });
    expect(bolOf(LOAD, bol("13/40/2026"))).toEqual({ ok: false, reason: "no_date" });
  });
});

describe("rated", () => {
  it("is true for a filled rate or a matching rate con, never for one whose linehaul differs", () => {
    expect(paperworkOf({ ...LOAD, linehaul_cents: 90000 }, []).rated).toBe(true);
    const fields = [
      { name: "load_number", claim: "BR-L1", record: "BR-L1", status: "same" },
      { name: "linehaul_cents", claim: 100000, record: 100000, status: "same" },
    ];
    const rc: PaperDocument = {
      ...bol(null),
      kind: "rate_confirmation",
      read: read("rate_confirmation", null),
      match: matched(fields),
    };
    expect(paperworkOf(LOAD, [rc])).toMatchObject({ rated: true, rateCon: rc.id });
    const off = { ...rc, match: matched([fields[0], { ...fields[1], record: 90000, status: "differs" }]) };
    expect(paperworkOf(LOAD, [off]).rated).toBe(false);
  });
});

describe("stop times", () => {
  it("reads a printed stamp in the carrier's zone, and refuses a time that does not exist", () => {
    expect(stampInstant("10/21/2026 7:40 AM EDT", ZONE)).toBe("2026-10-21T11:40:00.000Z");
    expect(stampInstant("10/21/2026 12:05 PM", ZONE)).toBe("2026-10-21T16:05:00.000Z");
    expect(stampInstant("03/08/2026 2:30 AM", ZONE)).toBeNull();
    expect(stampInstant("10/21/2026 13:40 PM", ZONE)).toBeNull();
    expect(stampInstant(null, ZONE)).toBeNull();
  });

  it("gives both times in order or neither", () => {
    const ok = bol("10/21/2026", [{ role: "delivery", arrived: "10/21/2026 1:00 PM", departed: "10/21/2026 3:30 PM" }]);
    expect(stopTimesOf(ok, "delivery", ZONE)).toEqual({
      arrivedAt: "2026-10-21T17:00:00.000Z",
      departedAt: "2026-10-21T19:30:00.000Z",
    });
    const backwards = bol("10/21/2026", [{ role: "delivery", arrived: "10/21/2026 3:30 PM", departed: "10/21/2026 1:00 PM" }]);
    expect(stopTimesOf(backwards, "delivery", ZONE)).toBeNull();
    expect(stopTimesOf(ok, "pickup", ZONE)).toBeNull();
  });
});
