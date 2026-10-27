import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_CARRIERS, carrierBySlug } from "./carriers";
import { HERO_LANES, LANES, laneMiles, reverseLane } from "./lanes";

describe("DEMO_CARRIERS", () => {
  it("matches the tenants that create-demo-users makes", () => {
    const path = new URL("../../../scripts/create-demo-users.ts", import.meta.url);
    const script = readFileSync(path, "utf8");
    for (const c of DEMO_CARRIERS) {
      const block = new RegExp(
        `slug: "${c.slug}",\\s*name: "${c.name}",\\s*timezone: "${c.timezone}",`,
      );
      expect(script).toMatch(block);
    }
  });

  it("finds a carrier by slug and nothing else", () => {
    expect(carrierBySlug("blue-ridge")?.prefix).toBe("BR");
    expect(carrierBySlug("prairie-wind")?.prefix).toBe("PW");
    expect(carrierBySlug("Blue-Ridge")).toBeUndefined();
    expect(carrierBySlug("blue")).toBeUndefined();
  });

  it("uses reserved example domains only", () => {
    for (const c of DEMO_CARRIERS) expect(c.emailDomain).toMatch(/\.example$/);
  });
});

describe("LANES", () => {
  const all = Object.values(LANES).flatMap((l) => [...l.regional, ...l.local]);

  it("names distinct two-letter states with whole positive miles", () => {
    for (const lane of all) {
      const states = lane.states.map(([s]) => s);
      expect(new Set(states).size).toBe(states.length);
      for (const [state, miles] of lane.states) {
        expect(state).toMatch(/^[A-Z]{2}$/);
        expect(Number.isSafeInteger(miles) && miles > 0).toBe(true);
      }
      expect(lane.states[0][0]).toBe(lane.from.state);
      expect(lane.states[lane.states.length - 1][0]).toBe(lane.to.state);
    }
  });

  it("runs the same miles both ways", () => {
    for (const lane of all) {
      const back = reverseLane(lane);
      expect(back.from).toEqual(lane.to);
      expect(laneMiles(back)).toBe(laneMiles(lane));
    }
  });

  it("points the hero lanes at real Blue Ridge lanes", () => {
    for (const i of Object.values(HERO_LANES)) expect(LANES.BR.regional[i]).toBeDefined();
  });
});
