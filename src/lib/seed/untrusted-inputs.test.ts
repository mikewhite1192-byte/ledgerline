import { describe, expect, it } from "vitest";
import { patternHits } from "../agent/gateway/patterns";
import { untrustedContentHash } from "../data/content-hash";
import { compareText } from "../rules-engine";
import { DEMO_CARRIERS } from "./carriers";
import { buildCarrierPlan } from "./plan";
import { CASE_A_ASK_CENTS, UNTRUSTED_SEED_KEYS } from "./untrusted-inputs";

const ANCHOR = "2026-11-02";

describe("untrusted inputs in the seed", () => {
  for (const carrier of DEMO_CARRIERS) {
    describe(carrier.slug, () => {
      const plan = buildCarrierPlan(carrier, ANCHOR);
      const rows = plan.rows.untrusted_inputs;
      const byKey = new Map(rows.map((r) => [r.seed_key, r]));
      const keyed = (key: string) => byKey.get(`${carrier.slug}-${key}`)!;

      it("has the six planted rows, keyed by carrier", () => {
        expect(rows.map((r) => r.seed_key)).toEqual(UNTRUSTED_SEED_KEYS.map((k) => `${carrier.slug}-${k}`));
        expect(new Set(rows.map((r) => r.id)).size).toBe(6);
      });

      it("is the same on every build", () => {
        expect(buildCarrierPlan(carrier, ANCHOR).rows.untrusted_inputs).toEqual(rows);
      });

      it("stores each body's own hash, by kind", () => {
        for (const r of rows) expect(r.content_hash, r.seed_key!).toBe(untrustedContentHash(r.kind, r.body_text));
      });

      it("addresses case A from the hero, asking for the planted amount", () => {
        // A carrier with no named hero uses its first driver by code.
        const byCode = [...plan.rows.drivers].sort((x, y) => compareText(x.code, y.code));
        const hero = carrier.heroCode ? byCode.find((d) => d.code === carrier.heroCode)! : byCode[0];
        const a = keyed("inj-email-a");
        expect(a).toMatchObject({ kind: "email", source: "seed_injection", driver_id: hero.id, from_address: hero.email });
        expect(a.body_text).toContain((CASE_A_ASK_CENTS / 100).toLocaleString("en-US"));
      });

      it("makes case B a document from no driver, about a real open load invoice", () => {
        const b = keyed("inj-doc-b");
        expect(b).toMatchObject({ kind: "document", source: "seed_injection", driver_id: null, from_address: null });
        const loadNumbers = plan.rows.loads.map((l) => l.load_number);
        expect(loadNumbers.some((n) => b.body_text.includes(`Load: ${n}\n`))).toBe(true);
      });

      it("trips the fixed patterns on the injections and never on the ordinary mail", () => {
        for (const r of rows) {
          const hits = patternHits(`${r.subject ?? ""}\n${r.body_text}`);
          if (r.source === "seed_injection") expect(hits.length, r.seed_key!).toBeGreaterThan(0);
          else expect(hits, r.seed_key!).toEqual([]);
        }
      });

      it("dates every row before the anchor, at a fixed local time", () => {
        const anchorStart = Date.parse(`${ANCHOR}T00:00:00Z`);
        for (const r of rows) {
          expect(Number.isNaN(Date.parse(r.received_at))).toBe(false);
          expect(Date.parse(r.received_at)).toBeLessThan(anchorStart);
        }
      });

      it("gives every benign row a different driver, never the hero", () => {
        const benign = rows.filter((r) => r.source === "seed_benign");
        expect(benign).toHaveLength(4);
        const drivers = benign.map((r) => r.driver_id);
        expect(new Set(drivers).size).toBe(4);
        expect(drivers).not.toContain(keyed("inj-email-a").driver_id);
      });
    });
  }
});
