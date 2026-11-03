import { describe, expect, it } from "vitest";
import { CARRIERS } from "../../../scripts/lib/demo-logins";
import { DEMO_CARRIERS, carrierBySlug, demoCarrierFor, demoTemplateFor } from "./carriers";
import { HERO_LANES, LANES, laneMiles, reverseLane } from "./lanes";

describe("DEMO_CARRIERS", () => {
  it("matches the tenants that create-demo-users makes", () => {
    expect(CARRIERS.map((c) => ({ slug: c.slug, name: c.name, timezone: c.timezone, email: c.email }))).toEqual(
      DEMO_CARRIERS.map((c) => ({ slug: c.slug, name: c.name, timezone: c.timezone, email: `ops@${c.emailDomain}` })),
    );
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

describe("demoTemplateFor", () => {
  const br = DEMO_CARRIERS[0];
  const row = (over: Partial<{ slug: string; name: string; timezone: string; demo_copy_of: string | null }>) => ({
    slug: br.slug,
    name: br.name,
    timezone: br.timezone,
    demo_copy_of: null,
    ...over,
  });

  it("is the demo carrier itself, exactly as demoCarrierFor", () => {
    expect(demoTemplateFor(row({}))).toBe(br);
    expect(demoCarrierFor(row({}))).toBe(br);
    expect(demoTemplateFor(null)).toBeNull();
  });

  it("is the demo carrier a visit's copy was built from, only with that carrier's name and zone", () => {
    const copy = row({ slug: `${br.slug}-v-0a1b2c3d`, demo_copy_of: br.slug });
    expect(demoTemplateFor(copy)).toBe(br);
    // The demo reset and the fleet move keep the exact match, so a copy is never one there.
    expect(demoCarrierFor(copy)).toBeNull();
    expect(demoTemplateFor({ ...copy, name: "Someone Else Trucking" })).toBeNull();
    expect(demoTemplateFor({ ...copy, timezone: "America/Denver" })).toBeNull();
    expect(demoTemplateFor({ ...copy, demo_copy_of: "blue" })).toBeNull();
    expect(demoTemplateFor({ ...copy, demo_copy_of: null })).toBeNull();
    expect(demoTemplateFor({ slug: copy.slug, name: copy.name, timezone: copy.timezone })).toBeNull();
    // Copied from the other demo carrier, it must carry that carrier's name and zone.
    expect(demoTemplateFor({ ...copy, demo_copy_of: DEMO_CARRIERS[1].slug })).toBeNull();
  });

  it("refuses a carrier that only took a demo slug", () => {
    expect(demoTemplateFor(row({ name: "Not Blue Ridge" }))).toBeNull();
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
