import { describe, expect, it } from "vitest";
import { noteTextSchema } from "../memory/notes";
import { customerClassOf } from "./ar-plan";
import { DEMO_CARRIERS } from "./carriers";
import { CARRIER_NOTE, DRIVER_NOTE, SLOW_PAYER_NOTE } from "./memory-plan";
import { buildCarrierPlan } from "./plan";

// The sample notes each demo carrier starts with: two about its slow payers, one about a driver
// whose pay notes are in Spanish, one about the carrier as a whole. All active, all marked as
// samples, and none states an amount.

const ANCHOR = "2026-11-02";

describe("the seeded carrier notes", () => {
  for (const carrier of DEMO_CARRIERS) {
    describe(carrier.slug, () => {
      const plan = buildCarrierPlan(carrier, ANCHOR);
      const notes = plan.rows.carrier_notes;

      it("has four active sample notes with their own ids", () => {
        expect(notes).toHaveLength(4);
        expect(new Set(notes.map((n) => n.id)).size).toBe(4);
        for (const n of notes) {
          expect(n.status).toBe("active");
          expect(n.source_kind).toBe("seed");
          expect(n.created_by_kind).toBe("seed");
          expect(n.created_by_sub).toBeNull();
          expect(n.created_by_model_call_id).toBeNull();
          expect(n.source_turn_id).toBeNull();
        }
      });

      it("is about the two slow payers, a Spanish-speaking driver and the whole carrier", () => {
        const customers = notes.filter((n) => n.subject_kind === "customer");
        expect(customers.map((n) => n.text)).toEqual([SLOW_PAYER_NOTE, SLOW_PAYER_NOTE]);
        for (const n of customers) {
          const index = plan.rows.customers.findIndex((c) => c.id === n.subject_id);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(customerClassOf(index)).toBe("slow");
        }
        const [driver] = notes.filter((n) => n.subject_kind === "driver");
        expect(driver.text).toBe(DRIVER_NOTE);
        expect(plan.rows.drivers.find((d) => d.id === driver.subject_id)?.preferred_language).toBe("es");
        const [wide] = notes.filter((n) => n.subject_kind === "carrier");
        expect(wide).toMatchObject({ subject_id: null, text: CARRIER_NOTE });
      });

      it("reads as valid notes and states no amount", () => {
        for (const n of notes) {
          expect(noteTextSchema.parse(n.text)).toBe(n.text);
          expect(n.text).not.toMatch(/\$|\bcents\b/i);
        }
      });

      it("is the same on every build and leaves the other rows alone", () => {
        const again = buildCarrierPlan(carrier, ANCHOR);
        expect(again.rows.carrier_notes).toEqual(notes);
        expect(again.rows.customers).toEqual(plan.rows.customers);
      });
    });
  }
});
