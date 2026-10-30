import { describe, expect, it } from "vitest";
import { untrustedContentHash } from "../data/content-hash";
import { parseLoadCreateArgs, type LoadCreateArgs } from "./args";
import {
  accessorialCentsOf,
  checkRateCon,
  normCode,
  normName,
  recheckCard,
  sameDraft,
  type RateConCandidates,
  type RateConContext,
  type StoredRateCon,
} from "./check";
import { rateConTranscriptOf, rawOfRateCon, type RateConReading } from "./schema";
import { RATECON_NOW, RATECON_TOTAL_CENTS, rateConReading } from "./test-fixtures";

// The deterministic checks, pure: the clock, the zone and the records are passed in. Each refusal
// is named once, in the order the checks run.

const CUSTOMER = { id: "c0000000-0000-4000-8000-000000000001", code: "CUST-1", name: "Test Shipper" };
const OTHER = { id: "c0000000-0000-4000-8000-000000000002", code: "ACME-FOODS", name: "ACME Foods" };
const CANDIDATES: RateConCandidates = {
  zone: "America/Chicago",
  customers: [CUSTOMER, OTHER],
  loadsWithNumber: 0,
  cardsWithNumber: 0,
};
const CTX: RateConContext = {
  now: new Date(RATECON_NOW),
  documentCreatedAt: new Date(RATECON_NOW).toISOString(),
  startDate: "2026-11-02",
};

const check = (over: Partial<RateConReading> = {}, candidates: Partial<RateConCandidates> = {}, ctx: Partial<RateConContext> = {}) =>
  checkRateCon(rateConReading(over), { ...CANDIDATES, ...candidates }, { ...CTX, ...ctx });
const category = (...a: Parameters<typeof check>) => {
  const out = check(...a);
  return out.ok ? "ok" : out.category;
};

describe("checkRateCon", () => {
  it("drafts the load from a reading that passes every check, in whole cents", () => {
    const out = check();
    expect(out).toEqual({
      ok: true,
      draft: {
        loadNumber: "RC-1001",
        customerId: CUSTOMER.id,
        customerCode: "CUST-1",
        originCity: "Dallas",
        originState: "TX",
        destCity: "Memphis",
        destState: "TN",
        pickupOn: "2026-11-05",
        deliveryOn: "2026-11-06",
        loadedMiles: 450,
        ratePerMileCents: 300,
        linehaulCents: 135_000,
        fuelSurchargeCents: 12_000,
        accessorials: [
          { kind: "stop", amountCents: 7_500 },
          { kind: "lumper", amountCents: 5_000 },
        ],
        totalCents: RATECON_TOTAL_CENTS,
        driverCodeClaim: "DRV-1",
      },
    });
    if (out.ok) expect(accessorialCentsOf(out.draft)).toBe(12_500);
  });

  it("normalizes printed values and compares them whole", () => {
    const out = check({
      loadNumber: "  rc-1001 ",
      customerName: "  test   SHIPPER ",
      customerCode: null,
      originState: "tx",
      originCity: " Dallas ",
      driverCode: "drv 1",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft).toMatchObject({ loadNumber: "RC-1001", customerId: CUSTOMER.id, originState: "TX", originCity: "Dallas" });
    // A driver code off its pattern is dropped, never stored as a claim.
    expect(out.draft.driverCodeClaim).toBeNull();
    expect(normCode(" a  b ")).toBe("A B");
    expect(normName(" A  B ")).toBe("a b");
    expect(normCode("   ")).toBeNull();
  });

  it("refuses a document from before the start date", () => {
    expect(category({}, {}, { documentCreatedAt: "2026-11-02T04:59:59.000Z" })).toBe("before_start");
    // Midnight in Chicago on the start date is on it.
    expect(category({}, {}, { documentCreatedAt: "2026-11-02T06:00:00.000Z" })).toBe("ok");
  });

  it("refuses a reading with a key field marked low", () => {
    const low = (f: string) => ({ confidence: { ...rateConReading().confidence, [f]: "low" } }) as Partial<RateConReading>;
    for (const f of ["load_number", "customer", "origin", "destination", "pickup", "linehaul", "total"]) {
      expect(category(low(f)), f).toBe("low_confidence");
    }
    expect(category({ confidence: { ...rateConReading().confidence, total: "medium" } })).toBe("ok");
  });

  it("refuses a missing or malformed load number", () => {
    expect(category({ loadNumber: null })).toBe("no_load_number");
    expect(category({ loadNumber: "R" })).toBe("no_load_number");
    expect(category({ loadNumber: "RC 1001" })).toBe("no_load_number");
    expect(category({ loadNumber: "RC_1001" })).toBe("no_load_number");
  });

  it("refuses a number a load already holds, then one a live card already holds", () => {
    expect(category({}, { loadsWithNumber: 1 })).toBe("load_exists");
    expect(category({}, { cardsWithNumber: 1 })).toBe("card_exists");
  });

  it("refuses a customer the tenant does not hold, and never matches part of a name", () => {
    expect(category({ customerName: "Nobody Freight", customerCode: "NOPE" })).toBe("unknown_customer");
    // "ACME" is not "ACME Foods", by name or by code.
    expect(category({ customerName: "ACME", customerCode: "ACME" })).toBe("unknown_customer");
    expect(category({ customerName: "ACME Foods", customerCode: null })).toBe("ok");
    expect(category({ customerName: "Test", customerCode: "CUST" })).toBe("unknown_customer");
  });

  it("refuses a reading whose name and code point at two customers", () => {
    expect(category({ customerName: "ACME Foods", customerCode: "CUST-1" })).toBe("ambiguous_customer");
    const twins = [CUSTOMER, { ...OTHER, name: "Test Shipper" }];
    expect(category({ customerCode: null }, { customers: twins })).toBe("ambiguous_customer");
  });

  it("refuses a lane off the list of states or with a city that is not one", () => {
    expect(category({ originState: "ZZ" })).toBe("bad_lane");
    expect(category({ destState: null })).toBe("bad_lane");
    expect(category({ destCity: "" })).toBe("bad_lane");
    expect(category({ originCity: "Dallas; DROP" })).toBe("bad_lane");
    expect(category({ destCity: "9th Street" })).toBe("bad_lane");
  });

  it("refuses a pickup outside its window or a delivery out of order", () => {
    expect(category({ pickupDate: "13/05/2026" })).toBe("bad_dates");
    expect(category({ pickupDate: "02/30/2026" })).toBe("bad_dates");
    // 200 days out, and 61 days back.
    expect(category({ pickupDate: "05/22/2027", deliveryDate: null })).toBe("bad_dates");
    expect(category({ pickupDate: "09/03/2026", deliveryDate: null })).toBe("bad_dates");
    expect(category({ pickupDate: "09/04/2026", deliveryDate: null })).toBe("ok");
    expect(category({ deliveryDate: "11/04/2026" })).toBe("bad_dates");
    expect(category({ deliveryDate: "12/06/2026" })).toBe("bad_dates");
    expect(category({ deliveryDate: "12/05/2026" })).toBe("ok");
    expect(category({ deliveryDate: null })).toBe("ok");
  });

  it("refuses no loaded miles, zero, or ten thousand", () => {
    expect(category({ loadedMiles: null })).toBe("no_miles");
    expect(category({ loadedMiles: 0 })).toBe("no_miles");
    expect(category({ loadedMiles: 10_000, ratePerMileCents: null })).toBe("no_miles");
  });

  it("refuses no total, and a total that is not the sum of its lines", () => {
    expect(category({ totalCents: null })).toBe("no_total");
    // The total prints $1,800.00 while the lines come to $1,595.00.
    expect(category({ totalCents: 180_000 })).toBe("arithmetic_off");
    expect(category({ totalCents: RATECON_TOTAL_CENTS + 1 })).toBe("arithmetic_off");
    // The rate times the miles must be the linehaul when a rate is printed.
    expect(category({ ratePerMileCents: 301 })).toBe("arithmetic_off");
    expect(category({ ratePerMileCents: null })).toBe("ok");
    expect(category({ linehaulCents: null })).toBe("arithmetic_off");
    expect(category({ accessorials: [{ kind: "stop", description: null, amountCents: null }] })).toBe("arithmetic_off");
    expect(category({ accessorials: [{ kind: "stop", description: null, amountCents: 0 }], totalCents: 147_000 })).toBe(
      "arithmetic_off",
    );
  });

  it("takes no printed surcharge as no surcharge", () => {
    const out = check({ fuelSurchargeCents: null, totalCents: RATECON_TOTAL_CENTS - 12_000 });
    expect(out.ok && out.draft.fuelSurchargeCents).toBe(0);
  });

  it("refuses a charge line of a kind the load cannot take", () => {
    const accessorials = [
      ...rateConReading().accessorials,
      { kind: "other" as const, description: "Tarp", amountCents: 2_500 },
    ];
    expect(category({ accessorials, totalCents: RATECON_TOTAL_CENTS + 2_500 })).toBe("accessorial_unknown");
  });
});

// A card as the service makes it, from the fixture reading.
function made(reading = rateConReading()) {
  const out = checkRateCon(reading, CANDIDATES, CTX);
  if (!out.ok) throw new Error("fixture does not check");
  const body = rateConTranscriptOf(reading);
  const hash = untrustedContentHash("document", body);
  const args: LoadCreateArgs = {
    v: 1,
    loadId: "10000000-0000-4000-8000-000000000001",
    documentId: "20000000-0000-4000-8000-000000000001",
    inputId: "30000000-0000-4000-8000-000000000001",
    readingHash: hash,
    ...out.draft,
  };
  const stored: StoredRateCon = {
    status: "proposed",
    proposalId: "40000000-0000-4000-8000-000000000001",
    documentId: args.documentId,
    inputId: args.inputId,
    reading: JSON.stringify(rawOfRateCon(reading)),
    documentCreatedAt: CTX.documentCreatedAt,
    transcript: { body, hash },
  };
  return { args, stored };
}

describe("recheckCard", () => {
  it("holds for the card exactly as it was made, and its args parse", () => {
    const { args, stored } = made();
    expect(parseLoadCreateArgs(args)).toEqual(args);
    const out = recheckCard(args, stored, CANDIDATES, CTX);
    expect(out.ok).toBe(true);
    if (out.ok) expect(sameDraft(out.draft, args)).toBe(true);
  });

  it("refuses a card whose ids, transcript or reading drifted from what it names", () => {
    const { args, stored } = made();
    const not = (s: StoredRateCon, a: LoadCreateArgs = args) => recheckCard(a, s, CANDIDATES, CTX);
    const NE = { ok: false, category: "not_executable" };
    expect(not({ ...stored, documentId: "20000000-0000-4000-8000-000000000009" })).toEqual(NE);
    expect(not({ ...stored, inputId: null })).toEqual(NE);
    expect(not({ ...stored, transcript: null })).toEqual(NE);
    expect(not({ ...stored, transcript: { body: `${stored.transcript!.body}\nx`, hash: stored.transcript!.hash } })).toEqual(NE);
    expect(not(stored, { ...args, readingHash: "0".repeat(64) })).toEqual(NE);
    expect(not({ ...stored, reading: null })).toEqual(NE);
    expect(not({ ...stored, reading: "{}" })).toEqual(NE);
    // A stored reading whose text is not the transcript the card hashed.
    const other = JSON.stringify(rawOfRateCon(rateConReading({ textLines: ["SAMPLE"] })));
    expect(not({ ...stored, reading: other })).toEqual(NE);
  });

  it("calls a card whose values differ from the reading's draft stale", () => {
    const { args, stored } = made();
    for (const edit of [
      { totalCents: RATECON_TOTAL_CENTS + 100 },
      { loadedMiles: 451 },
      { accessorials: [{ kind: "stop" as const, amountCents: 12_500 }] },
      { customerId: OTHER.id },
      { driverCodeClaim: null },
    ]) {
      expect(recheckCard({ ...args, ...edit }, stored, CANDIDATES, CTX), JSON.stringify(edit)).toEqual({
        ok: false,
        category: "stale",
      });
    }
  });

  it("refuses with the records as they are now", () => {
    const { args, stored } = made();
    expect(recheckCard(args, stored, { ...CANDIDATES, loadsWithNumber: 1 }, CTX)).toEqual({ ok: false, category: "load_exists" });
    expect(recheckCard(args, stored, { ...CANDIDATES, customers: [OTHER] }, CTX)).toEqual({
      ok: false,
      category: "unknown_customer",
    });
    // The pickup has fallen out of the window by the time of the approval.
    const later = { ...CTX, now: new Date(RATECON_NOW + 70 * 86_400_000) };
    expect(recheckCard(args, stored, CANDIDATES, later)).toEqual({ ok: false, category: "bad_dates" });
    // The stored document's created_at decides the start date, not the context's.
    expect(recheckCard(args, { ...stored, documentCreatedAt: "2026-10-01T12:00:00.000Z" }, CANDIDATES, CTX)).toEqual({
      ok: false,
      category: "before_start",
    });
  });
});
