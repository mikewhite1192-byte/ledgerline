import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { LocalDate } from "../../time/local-date";
import { carrierBySlug } from "../carriers";
import { buildCarrierPlan, type CarrierPlan } from "../plan";
import { localStamp, localStampText, mmddyyyy } from "./documents";
import {
  BACKGROUND_SAMPLE_SENTENCE,
  MANIFEST,
  PDF_FOOTER,
  PDF_MAX_BYTES,
  PHOTO_HEIGHT,
  PHOTO_MAX_BYTES,
  PHOTO_SAMPLE_SENTENCE,
  PHOTO_WIDTH,
  SAMPLE_DOCS,
  SET_MAX_BYTES,
  SYNTHETIC_VENDORS,
  isPdf,
  isPhoto,
  parseManifest,
  sampleDocFor,
  type PdfDoc,
  type PhotoDoc,
  type SampleDoc,
  type TenantSlug,
} from "./manifest";
import { pdfPageCount, pdfSubject } from "./pdf";
import { imageDescription } from "./stamp";

// The manifest is the answer key, so every value in it is proven here against the seed plan at
// the manifest's anchor, and every file against its recorded bytes. No model, no database.

const PUBLIC = join(process.cwd(), "public");

const plans = new Map<TenantSlug, CarrierPlan>(
  (["blue-ridge", "prairie-wind"] as const).map((slug) => [
    slug,
    buildCarrierPlan(carrierBySlug(slug)!, MANIFEST.anchor as LocalDate),
  ]),
);

function planOf(doc: SampleDoc): CarrierPlan {
  const plan = plans.get(doc.tenant);
  if (!plan) throw new Error(`no plan for ${doc.tenant}`);
  return plan;
}

function one<T extends { id: string }>(rows: readonly T[], id: string | null): T {
  const found = rows.filter((r) => r.id === id);
  expect(found, `exactly one row ${id}`).toHaveLength(1);
  return found[0];
}

function loadOf(plan: CarrierPlan, id: string | null) {
  return one(plan.rows.loads, id);
}

function truckOf(plan: CarrierPlan, driverId: string | null): string | null {
  return one(plan.rows.drivers, driverId).truck_unit;
}

const VENDOR_FOR = {
  lumper_receipt: "Dock Services",
  toll_receipt: "Sample Turnpike Authority",
  fuel_receipt: "Roadside Fuel Stop",
} as const;

describe("the sample documents manifest", () => {
  it("parses, and names each id and file once", () => {
    expect(parseManifest(JSON.parse(JSON.stringify(MANIFEST)))).toEqual(MANIFEST);
    expect(MANIFEST.anchor).toBe("2026-11-02");
    const ids = SAMPLE_DOCS.map((d) => d.id);
    const files = [...SAMPLE_DOCS.map((d) => d.file), MANIFEST.background?.file].filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
    expect(SAMPLE_DOCS.filter(isPhoto)).toHaveLength(6);
    expect(SAMPLE_DOCS.filter(isPdf)).toHaveLength(6);
  });

  it("refuses a malformed manifest", () => {
    const good = JSON.parse(JSON.stringify(MANIFEST));
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({ ...good, anchor: "11/02/2026" })).toThrow();
    const badKind = JSON.parse(JSON.stringify(good));
    badKind.entries[0].kind = "invoice";
    expect(() => parseManifest(badKind)).toThrow();
    const badMime = JSON.parse(JSON.stringify(good));
    badMime.entries[0].mime = "application/pdf";
    expect(() => parseManifest(badMime)).toThrow();
    const badFile = JSON.parse(JSON.stringify(good));
    badFile.entries[0].file = "../secret.webp";
    expect(() => parseManifest(badFile)).toThrow();
  });

  it("finds a document by its row", () => {
    const doc = SAMPLE_DOCS[0];
    expect(sampleDocFor(doc.ref)).toBe(doc);
    expect(sampleDocFor({ table: doc.ref.table, id: "00000000-0000-4000-8000-000000000000" }))
      .toBeUndefined();
  });

  it.each(SAMPLE_DOCS.filter(isPhoto).map((d) => [d.id, d] as const))(
    "%s: every receipt value equals its seeded row",
    (_id, doc: PhotoDoc) => {
      const plan = planOf(doc);
      const e = doc.expect;
      expect(doc.tenant).toBe("blue-ridge");
      expect(SYNTHETIC_VENDORS).toContain(e.vendor);
      expect(e.vendor).toBe(VENDOR_FOR[doc.kind]);
      const tz = plan.carrier.timezone;

      if (doc.ref.table === "load_accessorials") {
        expect(doc.kind).toBe("lumper_receipt");
        const row = one(plan.rows.load_accessorials, doc.ref.id);
        const load = loadOf(plan, row.load_id);
        expect(row.id).toBe(plan.planted.unreimbursedLumperId);
        expect(row.kind).toBe("lumper");
        expect(doc.ref.humanRef).toBe(load.load_number);
        expect(doc.ref.loadNumber).toBe(load.load_number);
        expect(e.amountCents).toBe(row.amount_cents);
        expect(e.paidByDriver).toBe(true);
        expect(row.paid_by_driver).toBe(true);
        expect(e.date).toBe(load.delivered_on);
        expect(e.loadNumber).toBe(load.load_number);
        expect(e.truckUnit).toBe(truckOf(plan, load.driver_id));
        expect([e.gallonsMilli, e.priceCents]).toEqual([null, null]);
      } else if (doc.ref.table === "pay_items") {
        const row = one(plan.rows.pay_items, doc.ref.id);
        expect(doc.ref.humanRef).toBe(row.item_ref);
        expect(row.kind).toBe("reimbursement");
        expect(row.subkind).toBe(doc.kind === "toll_receipt" ? "toll" : "fuel");
        expect(e.amountCents).toBe(row.amount_cents);
        expect(e.date).toBe(row.item_date);
        expect(e.truckUnit).toBe(truckOf(plan, row.driver_id));
        // A toll or prepaid fuel receipt does not print the load.
        expect(e.loadNumber).toBeNull();
        expect(doc.ref.loadNumber).toBe(
          row.ref_table === "loads" ? loadOf(plan, row.ref_id).load_number : null,
        );
        expect([e.gallonsMilli, e.priceCents]).toEqual([null, null]);
        if (doc.kind === "toll_receipt") expect(doc.shows.plaza).toMatch(/^Plaza \d+$/);
      } else {
        expect(doc.ref.table).toBe("fuel_purchases");
        expect(doc.kind).toBe("fuel_receipt");
        const row = one(plan.rows.fuel_purchases, doc.ref.id);
        expect([plan.planted.wrongDriverPurchaseId, plan.planted.fuelOffRouteId]).toContain(row.id);
        expect(doc.ref.humanRef).toBe(row.purchase_ref);
        expect(doc.ref.loadNumber).toBe(row.load_id ? loadOf(plan, row.load_id).load_number : null);
        expect(e.amountCents).toBe(row.amount_cents);
        expect(e.date).toBe(row.purchased_on);
        expect(e.gallonsMilli).toBe(row.gallons_milli);
        // Gallons times the price is the total, to the cent.
        expect((row.gallons_milli * e.priceCents!) / 1000).toBe(row.amount_cents);
        expect(e.purchasedAt).toBe(row.purchased_at);
        expect(e.localTime).toBe(localStamp(row.purchased_at, tz).time);
        expect(localStamp(row.purchased_at, tz).date).toBe(mmddyyyy(row.purchased_on));
        expect(e.state).toBe(row.state);
        expect(e.paidWith).toBe(row.paid_with);
        expect(e.truckUnit).toBe(truckOf(plan, row.driver_id));
        expect(e.loadNumber).toBeNull();
        expect(doc.shows.city).toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+)*$/);
      }
    },
  );

  it.each(SAMPLE_DOCS.filter(isPdf).map((d) => [d.id, d] as const))(
    "%s: every document value equals its seeded load",
    (_id, doc: PdfDoc) => {
      const plan = planOf(doc);
      const e = doc.expect;
      expect(doc.ref.table).toBe("loads");
      const load = loadOf(plan, doc.ref.id);
      const customer = one(plan.rows.customers, load.customer_id);
      const driver = one(plan.rows.drivers, load.driver_id);
      expect(doc.ref.humanRef).toBe(load.load_number);
      expect(doc.ref.loadNumber).toBe(load.load_number);
      expect(e.loadNumber).toBe(load.load_number);
      expect(e.customer).toEqual({ name: customer.name, city: customer.city, state: customer.state });
      expect(e.carrier).toBe(plan.carrier.name);
      expect(e.origin).toEqual({ city: load.origin_city, state: load.origin_state });
      expect(e.destination).toEqual({ city: load.dest_city, state: load.dest_state });
      expect(e.pickupOn).toBe(load.pickup_on);
      expect(e.deliveredOn).toBe(load.delivered_on);
      expect(e.date).toBe(load.delivered_on);
      expect(e.truckUnit).toBe(driver.truck_unit);
      expect(e.driverCode).toBe(driver.code);

      if (doc.kind === "rate_confirmation") {
        const r = doc.expect;
        // The "can't invoice" load: the rate confirmation is where its linehaul comes from.
        expect(load.id).toBe(plan.planted.noRateLoadId);
        expect(load.linehaul_cents).toBeNull();
        expect(r.loadedMiles).toBe(load.loaded_miles);
        expect(r.ratePerMileCents).toBeGreaterThanOrEqual(210);
        expect(r.ratePerMileCents).toBeLessThanOrEqual(320);
        expect(r.ratePerMileCents % 10).toBe(0);
        expect(r.linehaulCents).toBe(load.loaded_miles * r.ratePerMileCents);
        expect(r.fuelSurchargeCents).toBe(load.fuel_surcharge_cents);
        expect(r.totalCents).toBe(r.linehaulCents + r.fuelSurchargeCents);
      } else {
        const b = doc.expect;
        const tz = plan.carrier.timezone;
        expect(plan.planted.detentionLoadIds).toContain(load.id);
        expect(b.stops).toEqual({
          pickupArrivedAt: load.pickup_arrived_at,
          pickupDepartedAt: load.pickup_departed_at,
          deliveryArrivedAt: load.delivery_arrived_at,
          deliveryDepartedAt: load.delivery_departed_at,
        });
        for (const k of Object.keys(b.stops) as (keyof typeof b.stops)[]) {
          expect(b.stopsLocal[k]).toBe(localStampText(b.stops[k], tz));
        }
        expect(doc.shows.commodity).toBe("General freight, palletized");
        expect(Number.isSafeInteger(doc.shows.pallets) && doc.shows.pallets > 0).toBe(true);
      }
    },
  );

  it("never lets one amount match two documents", () => {
    const seen = new Map<number, string>();
    for (const d of SAMPLE_DOCS) {
      const amounts = isPhoto(d)
        ? [d.expect.amountCents]
        : d.kind === "rate_confirmation"
          ? [d.expect.linehaulCents, d.expect.fuelSurchargeCents, d.expect.totalCents]
          : [];
      for (const a of amounts) {
        const other = seen.get(a);
        expect(other === undefined || other === d.ref.id, `${a} cents in ${d.id} and another`)
          .toBe(true);
        seen.set(a, d.ref.id);
      }
    }
  });

  it.each(SAMPLE_DOCS.map((d) => [d.id, d] as const))(
    "%s: the committed file is the one recorded, marked SAMPLE",
    async (_id, doc: SampleDoc) => {
      const path = join(PUBLIC, doc.file);
      expect(existsSync(path), `${doc.file} exists`).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.length).toBe(doc.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(doc.sha256);
      if (isPhoto(doc)) {
        expect(bytes.toString("latin1", 0, 4)).toBe("RIFF");
        expect(bytes.toString("latin1", 8, 12)).toBe("WEBP");
        expect(bytes.length).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
        const meta = await sharp(bytes).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(["webp", doc.width, doc.height]);
        expect([doc.width, doc.height]).toEqual([PHOTO_WIDTH, PHOTO_HEIGHT]);
        expect(await imageDescription(bytes)).toBe(PHOTO_SAMPLE_SENTENCE);
        expect(["generated", "composed"]).toContain(doc.origin);
      } else {
        expect(bytes.toString("latin1", 0, 5)).toBe("%PDF-");
        expect(bytes.length).toBeLessThanOrEqual(PDF_MAX_BYTES);
        expect(pdfPageCount(bytes)).toBe(doc.pages);
        expect(pdfSubject(bytes)).toBe(PDF_FOOTER);
        expect(doc.origin).toBe("rendered");
      }
    },
  );

  it("records the paper background, if there is one, and keeps the set small", async () => {
    let total = 0;
    for (const d of SAMPLE_DOCS) total += d.bytes;
    const bg = MANIFEST.background;
    if (bg) {
      const bytes = readFileSync(join(PUBLIC, bg.file));
      expect(bytes.length).toBe(bg.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(bg.sha256);
      expect(bytes.length).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
      const meta = await sharp(bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", bg.width, bg.height]);
      expect(await imageDescription(bytes)).toBe(BACKGROUND_SAMPLE_SENTENCE);
      total += bg.bytes;
    }
    expect(total).toBeLessThanOrEqual(SET_MAX_BYTES);
  });
});
