import { describe, expect, it } from "vitest";
import { fnv1a32, Rng } from "./prng";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Rng", () => {
  it("gives the same numbers for the same seed text", () => {
    const a = new Rng("blue-ridge:2026-11-02");
    const b = new Rng("blue-ridge:2026-11-02");
    const draw = (r: Rng) => [r.nextUint32(), r.int(1, 6), r.uuid(), r.pick(["x", "y", "z"])];
    expect(draw(a)).toEqual(draw(b));
  });

  it("gives different numbers for different seed text", () => {
    const a = new Rng("blue-ridge:2026-11-02");
    const b = new Rng("blue-ridge:2026-11-09");
    expect([a.nextUint32(), a.nextUint32()]).not.toEqual([b.nextUint32(), b.nextUint32()]);
  });

  it("keeps int inside its bounds, both ends reachable", () => {
    const r = new Rng("bounds");
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = r.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it("refuses a range that is not valid", () => {
    const r = new Rng("bad");
    expect(() => r.int(5, 4)).toThrow(RangeError);
    expect(() => r.int(0.5, 4)).toThrow(RangeError);
    expect(() => r.pick([])).toThrow(RangeError);
    expect(() => r.weighted([["a", 0]])).toThrow(RangeError);
  });

  it("makes version 4 UUIDs", () => {
    const r = new Rng("ids");
    const ids = Array.from({ length: 200 }, () => r.uuid());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shuffles into a copy with the same items", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = new Rng("shuffle").shuffle(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort()).toEqual(items);
  });
});

describe("fnv1a32", () => {
  it("matches the published FNV-1a values", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });
});
