import { describe, expect, it } from "vitest";
import { parseInstant } from "../../time/local-date";
import { feedNowMs, listPage, loadExternalId, scriptOf, serveLoad, type SynLoad, type SynWorld } from "./synthetic";
import type { TmsConnection } from "./types";

const WORLD: SynWorld = { slug: "demo-test", zone: "America/Chicago" };

function load(n: number, over: Partial<SynLoad> = {}): SynLoad {
  return {
    loadNumber: `L-${1000 + n}`,
    status: "in_transit",
    pickupOn: `2026-11-0${1 + (n % 5)}`,
    deliveredAt: null,
    loadedMiles: 600,
    linehaulCents: 180_000,
    fuelSurchargeCents: 12_345,
    pickupArrivedAt: null,
    pickupDepartedAt: null,
    deliveryArrivedAt: null,
    originCity: "Springfield",
    originState: "IL",
    destCity: "Riverton",
    destState: "OH",
    customer: { code: "CUST-1", name: "Example Freight Buyer" },
    driverExternalId: "drv-1",
    truckUnit: "T-101",
    accessorials: [],
    invoiceIssuedOn: null,
    ...over,
  };
}

const at = (iso: string) => parseInstant(iso);

describe("the synthetic dispatch feed", () => {
  it("serves nothing after its clock: no load before it is created, no step before it happens", () => {
    const l = load(1);
    const s = scriptOf(WORLD, l);
    expect(serveLoad(WORLD, l, at(s.createdAt) - 1)).toBeNull();
    const created = serveLoad(WORLD, l, at(s.createdAt));
    expect(created?.record.statusLabel).toBe("Tendered");
    expect(created?.history.map((h) => h.newValue)).toEqual(["Tendered"]);
    const before = serveLoad(WORLD, l, at(s.deliveredAt as string) - 1);
    expect(before?.record.statusLabel).toBe("In Transit");
    expect(before?.record.delivered).toBeNull();
    expect(before?.documents.map((d) => d.typeLabel)).toEqual(["Rate Confirmation", "Bill of Lading"]);
    const after = serveLoad(WORLD, l, at(s.deliveredAt as string));
    expect(after?.record.statusLabel).toBe("Delivered");
    expect(after?.record.delivered?.utc).toBe(s.deliveredAt);
    for (const served of [created, before, after]) {
      for (const h of served?.history ?? []) expect(at(h.at.utc as string)).toBeLessThanOrEqual(at(served?.record.updatedAt as string));
    }
  });

  it("keeps the load's revenue in integer cents from its own lines", () => {
    const l = load(2, { accessorials: [{ kind: "detention", seq: 1, amountCents: 7_500, description: "Detention" }] });
    const s = serveLoad(WORLD, l, at("2026-12-01T00:00:00Z"));
    expect(s?.lines.map((x) => x.amountCents)).toEqual([180_000, 12_345, 7_500]);
    expect(s?.record.revenueTotalCents).toBe(199_845);
    expect(s?.record.driverPayTotalCents).toBeNull();
  });

  it("lists newest created first and pages by bookmark with no row twice or missed", () => {
    const loads = Array.from({ length: 12 }, (_, i) => load(i));
    const now = at("2026-12-01T00:00:00Z");
    const all = listPage(WORLD, loads, now, null, 100).rows;
    expect(all).toHaveLength(12);
    for (let i = 1; i < all.length; i += 1) {
      const a = all[i - 1];
      const b = all[i];
      expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.externalId > b.externalId)).toBe(true);
    }
    const seen: string[] = [];
    let below = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = listPage(WORLD, loads, now, below, 5);
      seen.push(...page.rows.map((r) => r.externalId));
      if (page.next === null) break;
      below = page.next;
    }
    expect(seen).toEqual(all.map((r) => r.externalId));
    // The same clock and bookmark give the same page.
    expect(listPage(WORLD, loads, now, null, 5)).toEqual(listPage(WORLD, loads, now, null, 5));
  });

  it("names a load by the carrier's slug and the whole load number", () => {
    expect(loadExternalId(WORLD, "L-1001")).toBe("syn:demo-test:L-1001");
  });

  it("never reads earlier than the connection's floor", () => {
    const connection: TmsConnection = {
      id: "c",
      system: "synthetic",
      labelMap: {},
      lookbackHours: 4,
      finalizeCooloffMinutes: 30,
      feedFloorAt: "2026-11-02T05:00:00.000Z",
    };
    expect(feedNowMs({ now: "2026-10-31T12:00:00.000Z", connection })).toBe(at("2026-11-02T05:00:00.000Z"));
    expect(feedNowMs({ now: "2026-11-09T12:00:00.000Z", connection })).toBe(at("2026-11-09T12:00:00.000Z"));
    expect(feedNowMs({ now: "2026-10-31T12:00:00.000Z", connection: { ...connection, feedFloorAt: null } })).toBe(
      at("2026-10-31T12:00:00.000Z"),
    );
  });

  it("serves a cancelled load as cancelled, never picked up", () => {
    const s = serveLoad(WORLD, load(3, { status: "cancelled" }), at("2026-12-01T00:00:00Z"));
    expect(s?.record.statusLabel).toBe("Cancelled");
    expect(s?.record.pickedUp).toBeNull();
    expect(s?.history.map((h) => h.newValue)).toEqual(["Tendered", "Booked", "Cancelled"]);
  });
});
