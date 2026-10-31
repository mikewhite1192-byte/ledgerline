import { describe, expect, it } from "vitest";
import { directionOf, namesWhole } from "./message";

describe("namesWhole", () => {
  it("finds the load number whole, in any case, at any edge or beside punctuation", () => {
    expect(namesWhole("BR-L10247 delivered", "BR-L10247")).toBe(true);
    expect(namesWhole("delivered br-l10247.", "BR-L10247")).toBe(true);
    expect(namesWhole("load (BR-L10247), picked up", "BR-L10247")).toBe(true);
  });

  it("refuses a number with a part missing or a part added", () => {
    expect(namesWhole("10247 delivered", "BR-L10247")).toBe(false);
    expect(namesWhole("L10247 delivered", "BR-L10247")).toBe(false);
    expect(namesWhole("BR-L102470 delivered", "BR-L10247")).toBe(false);
    expect(namesWhole("BR-L10247-2 delivered", "BR-L10247")).toBe(false);
    expect(namesWhole("XBR-L10247 delivered", "BR-L10247")).toBe(false);
    expect(namesWhole("X-BR-L10247 delivered", "BR-L10247")).toBe(false);
    expect(namesWhole("delivered", "BR-L10247")).toBe(false);
  });

  it("finds a whole copy after a partial one", () => {
    expect(namesWhole("BR-L102470 no, I mean BR-L10247", "BR-L10247")).toBe(true);
  });

  it("never matches a number shorter than three characters", () => {
    expect(namesWhole("load 12 delivered", "12")).toBe(false);
  });
});

describe("directionOf", () => {
  it("reads a plain picked up or delivered, in English or Spanish", () => {
    expect(directionOf("Picked up BR-L10247")).toBe("in_transit");
    expect(directionOf("BR-L10247 loaded and rolling")).toBe("in_transit");
    expect(directionOf("Ya cargué BR-L10247")).toBe("in_transit");
    expect(directionOf("BR-L10247 delivered")).toBe("delivered");
    expect(directionOf("Entregué la carga BR-L10247")).toBe("delivered");
    expect(directionOf("BR-L10247 descargado")).toBe("delivered");
  });

  it("gives nothing for a sentence that could turn around, says both, or says neither", () => {
    expect(directionOf("BR-L10247 not delivered yet")).toBeNull();
    expect(directionOf("will be delivered tomorrow")).toBeNull();
    expect(directionOf("todavía no entregado")).toBeNull();
    expect(directionOf("picked up and delivered")).toBeNull();
    expect(directionOf("running late at the shipper")).toBeNull();
  });
});
