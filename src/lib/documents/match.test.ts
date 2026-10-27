import { describe, expect, it } from "vitest";
import { blueRidgePlan, planDb } from "../agent/gateway/__tests__/plan-db";
import { TENANT, type Row } from "../agent/gateway/__tests__/fake-db";
import type { LoadRow } from "../data/rows";
import { loadCandidates } from "./candidates";
import { isoFromMmddyyyy, matchDocument, mmddyyyyOf, norm, stampOf } from "./match";
import {
  CONFIDENCE_FIELDS,
  type ConfidenceField,
  type DocumentKind,
  type DocumentRead,
  type FieldCheck,
  type MatchFound,
  type MatchResult,
  type ReadFields,
} from "./types";

// Readings built from the seed plan's own rows, matched through the real record readers on a
// fake database. Every comparison is a whole value: a near miss, a part of a number or one cent
// off never counts as the same.

const plan = blueRidgePlan();

const EMPTY: ReadFields = {
  sampleWord: true,
  vendor: null,
  date: null,
  totalCents: null,
  loadNumber: null,
  truckUnit: null,
  gallonsMilli: null,
  priceCents: null,
  loadedMiles: null,
  ratePerMileCents: null,
  linehaulCents: null,
  fuelSurchargeCents: null,
  customerName: null,
  stops: [],
};

function readOf(kind: DocumentKind, fields: Partial<ReadFields>, low: ConfidenceField[] = []): DocumentRead {
  const confidence = Object.fromEntries(
    CONFIDENCE_FIELDS.map((f) => [f, low.includes(f) ? "low" : "high"]),
  ) as DocumentRead["confidence"];
  return { kind, fields: { ...EMPTY, ...fields }, textLines: [], confidence };
}

async function matchOf(read: DocumentRead, loadOver?: { id: string; over: Partial<LoadRow> }): Promise<MatchResult> {
  const db = planDb(plan);
  if (loadOver) {
    db.tables.loads = plan.rows.loads.map((l) =>
      l.id === loadOver.id ? ({ ...l, ...loadOver.over } as unknown as Row) : (l as unknown as Row),
    );
  }
  return db.withTenant(TENANT, async (q) => matchDocument(read, await loadCandidates(q, read)));
}

function foundOf(m: MatchResult): MatchFound {
  if (!m.found) throw new Error(`expected a match, got ${m.reason}`);
  return m;
}

function field(m: MatchFound, name: string): FieldCheck {
  const f = m.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}

function loadById(id: string): LoadRow {
  const load = plan.rows.loads.find((l) => l.id === id);
  if (!load) throw new Error("no load");
  return load;
}

function rateConFor(load: LoadRow, over: Partial<ReadFields> = {}, low: ConfidenceField[] = []): DocumentRead {
  const customer = plan.rows.customers.find((c) => c.id === load.customer_id);
  return readOf(
    "rate_confirmation",
    {
      loadNumber: load.load_number,
      loadedMiles: load.loaded_miles,
      customerName: customer?.name ?? null,
      ratePerMileCents: 245,
      linehaulCents: 245 * load.loaded_miles,
      fuelSurchargeCents: load.fuel_surcharge_cents ?? 4_000,
      ...over,
    },
    low,
  );
}

describe("helpers", () => {
  it("normalizes whole strings only", () => {
    expect(norm("  bl-1042 \n x ")).toBe("BL-1042 X");
    expect(norm("   ")).toBeNull();
    expect(norm(null)).toBeNull();
  });

  it("takes only real calendar days in MM/DD/YYYY", () => {
    expect(isoFromMmddyyyy("10/27/2026")).toBe("2026-10-27");
    expect(isoFromMmddyyyy("02/30/2026")).toBeNull();
    expect(isoFromMmddyyyy("2026-10-27")).toBeNull();
    expect(isoFromMmddyyyy("10/27/26")).toBeNull();
    expect(mmddyyyyOf("2026-10-27")).toBe("10/27/2026");
  });

  it("prints an instant as a bill of lading does, in the carrier's zone", () => {
    const s = stampOf("2026-10-21T11:40:00Z", "America/New_York");
    expect(s.full).toBe("10/21/2026 7:40 AM EDT");
    expect(s.bare).toBe("10/21/2026 7:40 AM");
  });
});

describe("rate confirmations", () => {
  const noRate = loadById(plan.planted.noRateLoadId);

  it("supports filling the rate on the load that has none when every needed field agrees", async () => {
    expect(noRate.linehaul_cents).toBeNull();
    const m = foundOf(await matchOf(rateConFor(noRate)));
    expect(m.table).toBe("loads");
    expect(m.id).toBe(noRate.id);
    expect(m.supports).toBe("load_rate_fill");
    expect(m.notes).toEqual(expect.arrayContaining(["record_has_no_rate", "arithmetic_checks"]));
    expect(field(m, "load_number").status).toBe("same");
    expect(field(m, "loaded_miles").status).toBe("same");
    expect(field(m, "linehaul_cents").status).toBe("no_record_value");
  });

  it("reads a no-rate load's default 0 surcharge as no record value, so a printed surcharge can fill it", async () => {
    const read = rateConFor(noRate, { fuelSurchargeCents: 18_360 });
    const m = foundOf(await matchOf(read, { id: noRate.id, over: { fuel_surcharge_cents: 0 } }));
    expect(field(m, "fuel_surcharge_cents")).toMatchObject({ claim: 18_360, record: null, status: "no_record_value" });
    expect(m.supports).toBe("load_rate_fill");
  });

  it("still compares a no-rate load's surcharge when it is not 0", async () => {
    const read = rateConFor(noRate, { fuelSurchargeCents: 18_360 });
    const m = foundOf(await matchOf(read, { id: noRate.id, over: { fuel_surcharge_cents: 18_361 } }));
    expect(field(m, "fuel_surcharge_cents")).toMatchObject({ record: 18_361, status: "differs" });
    expect(m.supports).toBeNull();
  });

  it("keeps a 0 surcharge as the record's value on a load that has a rate", async () => {
    const rated = plan.rows.loads.find((l) => l.linehaul_cents !== null && l.status === "delivered")!;
    const read = rateConFor(rated, { ratePerMileCents: null, linehaulCents: rated.linehaul_cents, fuelSurchargeCents: 500 });
    const m = foundOf(await matchOf(read, { id: rated.id, over: { fuel_surcharge_cents: 0 } }));
    expect(field(m, "fuel_surcharge_cents")).toMatchObject({ claim: 500, record: 0, status: "differs" });
  });

  it("supports nothing when the arithmetic is off by one cent", async () => {
    const m = foundOf(await matchOf(rateConFor(noRate, { linehaulCents: 245 * noRate.loaded_miles + 1 })));
    expect(m.notes).toContain("arithmetic_off");
    expect(m.supports).toBeNull();
  });

  it("supports nothing when the loaded miles differ by one", async () => {
    const m = foundOf(
      await matchOf(
        rateConFor(noRate, { loadedMiles: noRate.loaded_miles + 1, linehaulCents: 245 * (noRate.loaded_miles + 1) }),
      ),
    );
    expect(field(m, "loaded_miles").status).toBe("differs");
    expect(m.supports).toBeNull();
  });

  it("supports nothing when a needed field was read with low confidence", async () => {
    const m = foundOf(await matchOf(rateConFor(noRate, {}, ["linehaul_cents"])));
    expect(field(m, "linehaul_cents").status).toBe("low_confidence");
    expect(m.supports).toBeNull();
  });

  it("does not match on a load number with low confidence", async () => {
    expect(await matchOf(rateConFor(noRate, {}, ["load_number"]))).toEqual({ found: false, reason: "low_confidence" });
  });

  it("never matches a part of a load number", async () => {
    const partial = noRate.load_number.slice(0, -1);
    expect(await matchOf(rateConFor(noRate, { loadNumber: partial }))).toEqual({ found: false, reason: "no_record" });
    expect(await matchOf(rateConFor(noRate, { loadNumber: `${noRate.load_number}0` }))).toEqual({
      found: false,
      reason: "no_record",
    });
  });

  it("matches a load number whatever its case and spacing", async () => {
    const m = foundOf(await matchOf(rateConFor(noRate, { loadNumber: ` ${noRate.load_number.toLowerCase()} ` })));
    expect(m.id).toBe(noRate.id);
  });

  it("says no load when the document prints no load number", async () => {
    expect(await matchOf(rateConFor(noRate, { loadNumber: null }))).toEqual({ found: false, reason: "no_load" });
  });

  it("supports nothing on a load that already has a rate, and shows a different linehaul as differs", async () => {
    const rated = plan.rows.loads.find((l) => l.linehaul_cents !== null && l.status === "delivered")!;
    const m = foundOf(
      await matchOf(
        rateConFor(rated, {
          ratePerMileCents: null,
          linehaulCents: rated.linehaul_cents! + 1,
          fuelSurchargeCents: rated.fuel_surcharge_cents,
        }),
      ),
    );
    expect(field(m, "linehaul_cents").status).toBe("differs");
    expect(m.notes).not.toContain("record_has_no_rate");
    expect(m.supports).toBeNull();
  });
});

describe("lumper receipts", () => {
  const lumper = plan.rows.load_accessorials.find((a) => a.id === plan.planted.unreimbursedLumperId)!;
  const load = loadById(lumper.load_id);
  const driver = plan.rows.drivers.find((d) => d.id === load.driver_id)!;
  const receipt = (over: Partial<ReadFields> = {}, low: ConfidenceField[] = []) =>
    readOf(
      "lumper_receipt",
      {
        vendor: "Dock Services",
        loadNumber: load.load_number,
        totalCents: lumper.amount_cents,
        date: mmddyyyyOf(load.delivered_on!),
        truckUnit: driver.truck_unit,
        ...over,
      },
      low,
    );

  it("finds the unreimbursed lumper and supports proposing the reimbursement", async () => {
    const m = foundOf(await matchOf(receipt()));
    expect(m.table).toBe("load_accessorials");
    expect(m.id).toBe(lumper.id);
    expect(m.notes).toContain("reimbursement_missing");
    expect(m.supports).toBe("missing_reimbursement");
    expect(m.fields.every((f) => f.status === "same")).toBe(true);
  });

  it("shows one cent off as differs and supports nothing", async () => {
    const m = foundOf(await matchOf(receipt({ totalCents: lumper.amount_cents + 1 })));
    expect(field(m, "total_cents")).toMatchObject({
      claim: lumper.amount_cents + 1,
      record: lumper.amount_cents,
      status: "differs",
    });
    expect(m.supports).toBeNull();
  });

  it("does not match a lumper receipt whose total was read with low confidence", async () => {
    expect(await matchOf(receipt({}, ["total_cents"]))).toEqual({ found: false, reason: "low_confidence" });
  });
});

describe("bills of lading", () => {
  const load = loadById(plan.planted.detentionLoadIds[0]);
  const zone = plan.carrier.timezone;
  const stamp = (iso: string | null) => (iso === null ? null : stampOf(iso, zone).full);
  const bol = (over: Partial<ReadFields> = {}) =>
    readOf("bill_of_lading", {
      loadNumber: load.load_number,
      stops: [
        { role: "pickup", arrived: stamp(load.pickup_arrived_at), departed: stamp(load.pickup_departed_at) },
        { role: "delivery", arrived: stamp(load.delivery_arrived_at), departed: stamp(load.delivery_departed_at) },
      ],
      ...over,
    });

  it("matches every stop time and notes the wait with no detention recorded", async () => {
    const m = foundOf(await matchOf(bol()));
    expect(m.table).toBe("loads");
    for (const name of ["pickup_arrived", "pickup_departed", "delivery_arrived", "delivery_departed"]) {
      const f = field(m, name);
      expect(f.status === "same" || f.status === "no_record_value").toBe(true);
    }
    expect(m.notes).toContain("no_detention_recorded");
    expect(m.supports).toBeNull();
  });

  it("shows a stop time one minute off as differs", async () => {
    const departed = load.delivery_departed_at!;
    const off = new Date(new Date(departed).getTime() + 60_000).toISOString();
    const m = foundOf(
      await matchOf(
        bol({
          stops: [
            { role: "pickup", arrived: stamp(load.pickup_arrived_at), departed: stamp(load.pickup_departed_at) },
            { role: "delivery", arrived: stamp(load.delivery_arrived_at), departed: stamp(off) },
          ],
        }),
      ),
    );
    expect(field(m, "delivery_departed").status).toBe("differs");
    expect(field(m, "delivery_arrived").status).toBe("same");
  });
});

describe("other documents", () => {
  it("compares nothing for a kind it does not know", async () => {
    expect(await matchOf(readOf("other", { totalCents: 100 }))).toEqual({ found: false, reason: "no_load" });
  });

  it("finds no toll record for a truck no driver drives", async () => {
    expect(
      await matchOf(readOf("toll_receipt", { totalCents: 1_250, date: "10/20/2026", truckUnit: "NO-SUCH-TRUCK" })),
    ).toEqual({ found: false, reason: "no_record" });
  });
});
