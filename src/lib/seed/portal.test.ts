import { describe, expect, it } from "vitest";
import { stampText } from "../portal/zones";
import { DEMO_CARRIERS } from "./carriers";
import { buildCarrierPlan } from "./plan";
import { buildPortalPlan, carrierNumberFor, PORTAL_NOTE_INSTRUCTION, PORTAL_SEED_KEYS, zoneForState } from "./portal";
import { POD_FOOTER, POD_MAX_BYTES, renderPortalPod } from "./portal-pdf";

const ANCHOR = "2026-11-02";
const plans = DEMO_CARRIERS.map((c) => buildCarrierPlan(c, ANCHOR));
const portals = plans.map(buildPortalPlan);
const ALL_KEYS = [...PORTAL_SEED_KEYS.nullTimes, PORTAL_SEED_KEYS.differs, PORTAL_SEED_KEYS.podPending, PORTAL_SEED_KEYS.note];

describe("buildPortalPlan", () => {
  it("is the same plan twice", () => {
    expect(plans.map(buildPortalPlan)).toEqual(portals);
  });

  it("gives every carrier its own carrier number and every load a unique reference", () => {
    const numbers = portals.map((p) => p.carrierNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) expect(n).toMatch(/^MC-[0-9]{6}$/);
    expect(carrierNumberFor(DEMO_CARRIERS[0].slug)).toBe(numbers[0]);
    for (const p of portals) {
      const refs = p.loads.map((l) => l.reference);
      expect(new Set(refs).size).toBe(refs.length);
      for (const r of refs) expect(r).toMatch(/^FFE-[0-9]{6}$/);
    }
  });

  it("carries one row per delivered load, and every planted case once per carrier", () => {
    portals.forEach((p, i) => {
      const delivered = plans[i].rows.loads.filter((l) => l.delivered_on !== null && l.delivered_at !== null);
      expect(p.loads).toHaveLength(delivered.length);
      const keys = p.loads.flatMap((l) => (l.seedKey ? [l.seedKey] : []));
      expect([...keys].sort()).toEqual([...ALL_KEYS].sort());
    });
  });

  it("plants each case as its key says", () => {
    portals.forEach((p, i) => {
      const plan = plans[i];
      const byKey = new Map(p.loads.filter((l) => l.seedKey).map((l) => [l.seedKey, l]));
      const ours = new Map(plan.rows.loads.map((l) => [l.id, l]));
      for (const key of PORTAL_SEED_KEYS.nullTimes) {
        const row = byKey.get(key)!;
        expect(ours.get(row.loadId)!.delivery_arrived_at).toBeNull();
        expect(row.checkedIn).not.toBeNull();
        const customer = plan.rows.customers.find((c) => c.id === ours.get(row.loadId)!.customer_id)!;
        const dwell = (Date.parse(row.checkedOut!) - Date.parse(row.checkedIn!)) / 60_000;
        expect(dwell).toBeGreaterThan(customer.detention_free_minutes);
      }
      const differs = byKey.get(PORTAL_SEED_KEYS.differs)!;
      const ourOut = ours.get(differs.loadId)!.delivery_departed_at!;
      expect(Date.parse(differs.checkedOut!) - Math.floor(Date.parse(ourOut) / 60_000) * 60_000).toBe(40 * 60_000);
      const pending = byKey.get(PORTAL_SEED_KEYS.podPending)!;
      expect(pending).toMatchObject({ checkedIn: null, checkedOut: null, podStatus: "pending", podSignedBy: null });
      expect(byKey.get(PORTAL_SEED_KEYS.note)!.notes).toBe(PORTAL_NOTE_INSTRUCTION);
      expect(p.loads.filter((l) => l.notes !== null)).toHaveLength(1);
    });
  });

  it("stamps to the whole minute, in a zone the portal can print, check-out after check-in", () => {
    for (const p of portals) {
      for (const l of p.loads) {
        if (l.checkedIn === null) continue;
        expect(Date.parse(l.checkedIn) % 60_000).toBe(0);
        expect(Date.parse(l.checkedOut!)).toBeGreaterThan(Date.parse(l.checkedIn));
        expect(stampText(l.checkedIn, l.facilityTimeZone)).toMatch(/ (ET|CT|MT|PT|AZ)$/);
      }
    }
  });

  it("maps a state to its zone, with the carrier's zone as the fallback", () => {
    expect(zoneForState("TX", "America/New_York")).toBe("America/Chicago");
    expect(zoneForState("AZ", "America/Chicago")).toBe("America/Phoenix");
    expect(zoneForState("ZZ", "America/Denver")).toBe("America/Denver");
    expect(zoneForState("ZZ", "Europe/Paris")).toBe("America/Chicago");
  });
});

describe("renderPortalPod", () => {
  const load = portals[0].loads.find((l) => l.podStatus === "available")!;

  it("is a small PDF, the same bytes every time, with the fictional footer", async () => {
    const a = await renderPortalPod(load, portals[0].carrierName);
    const b = await renderPortalPod(load, portals[0].carrierName);
    expect(a.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(a.bytes.length).toBeLessThan(POD_MAX_BYTES);
    expect(a.hash).toBe(b.hash);
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect(a.bytes.toString("latin1")).toContain(POD_FOOTER.slice(0, 20));
  });
});
