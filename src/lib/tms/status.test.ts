import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_LABELS,
  TMS_STATUS_CODES,
  codeOf,
  docKindOf,
  isFinalized,
  isWithdrawn,
  moveOf,
  readLabelMap,
  syntheticLabelMap,
} from "./status";

describe("the status map", () => {
  it("maps every synthetic label to its own code and nothing to custom", () => {
    const map = syntheticLabelMap();
    for (const [code, label] of Object.entries(SYNTHETIC_LABELS)) expect(codeOf(label, map)).toBe(code);
    expect(Object.keys(SYNTHETIC_LABELS)).toHaveLength(TMS_STATUS_CODES.length - 1);
  });

  it("moves on a relabeled status the tenant mapped, by the whole label", () => {
    const map = readLabelMap({ ...syntheticLabelMap(), rolling: "in_transit" });
    expect(codeOf("Rolling", map)).toBe("in_transit");
    expect(codeOf("  ROLLING ", map)).toBe("in_transit");
    expect(moveOf(codeOf("Rolling", map))).toBe("in_transit");
    // A label containing a mapped one is not that one.
    expect(codeOf("Rolling slowly", map)).toBe("custom");
  });

  it("reads a tenant's own status as custom, which never moves", () => {
    const map = syntheticLabelMap();
    expect(codeOf("Yard check", map)).toBe("custom");
    expect(codeOf(null, map)).toBe("custom");
    expect(moveOf("custom")).toBeNull();
  });

  it("moves only on in transit and delivered", () => {
    const moving = TMS_STATUS_CODES.filter((c) => moveOf(c) !== null);
    expect(moving).toEqual(["in_transit", "delivered"]);
  });

  it("reads a stored map strictly: one bad entry empties it, so nothing moves", () => {
    expect(readLabelMap({ delivered: "delivered", rolling: "flying" })).toEqual({});
    expect(readLabelMap({ Delivered: "delivered" })).toEqual({});
    expect(readLabelMap({ ["x".repeat(61)]: "delivered" })).toEqual({});
    expect(readLabelMap([])).toEqual({});
    expect(readLabelMap(null)).toEqual({});
    expect(codeOf("Delivered", readLabelMap("delivered"))).toBe("custom");
  });

  it("names withdrawn and finalized codes", () => {
    expect(TMS_STATUS_CODES.filter(isWithdrawn)).toEqual(["archived", "expired", "cancelled"]);
    expect(TMS_STATUS_CODES.filter(isFinalized)).toEqual(["finalized", "invoiced", "paid"]);
  });

  it("maps document type labels whole, and a tenant's own type to other", () => {
    expect(docKindOf("POD")).toBe("proof_of_delivery");
    expect(docKindOf("Bill of Lading")).toBe("bill_of_lading");
    expect(docKindOf("BOL scan")).toBe("other");
  });
});
