import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  codeToWords,
  KNOWN_LINE_KINDS,
  KNOWN_STATUSES,
  lineKindLabel,
  recordLabel,
  statusLabel,
} from "./labels";

const plain = /^[A-Z][^_]*$/;

describe("statusLabel", () => {
  it("gives every known status a plain label with a capital and no underscore", () => {
    for (const s of KNOWN_STATUSES) expect(statusLabel(s)).toMatch(plain);
  });

  it("covers every vocabulary the app stores", () => {
    const vocabularies = [
      ["planned", "in_transit", "delivered", "invoiced", "cancelled"],
      ["requested", "approved", "paid", "rejected", "cancelled"],
      ["draft", "approved", "paid"],
      ["open", "approved", "paid"],
      ["open", "paid", "void", "partially_paid", "past_due"],
      ["reserved", "sent", "confirmed", "unknown", "failed"],
      ["proposed", "approved", "rejected", "executing", "done", "failed", "unknown"],
      ["reserved", "ok", "incomplete", "failed", "unknown"],
    ];
    for (const s of vocabularies.flat()) expect(KNOWN_STATUSES).toContain(s);
  });

  it("degrades an unknown status to words and never throws", () => {
    expect(statusLabel("partly_shipped")).toBe("Partly shipped");
    expect(statusLabel("")).toBe("Not set");
    expect(statusLabel("__")).toBe("Not set");
    expect(statusLabel("toString")).toBe("Tostring");
  });
});

describe("lineKindLabel", () => {
  it("gives every pay line kind a plain label", () => {
    expect(KNOWN_LINE_KINDS).toHaveLength(10);
    for (const k of KNOWN_LINE_KINDS) expect(lineKindLabel(k)).toMatch(plain);
    expect(lineKindLabel("advance_recovery")).toBe("Advance repaid");
    expect(lineKindLabel("new_kind")).toBe("New kind");
  });
});

describe("codeToWords", () => {
  it("turns separators into single spaces", () => {
    expect(codeToWords("past__due-now")).toBe("Past due now");
  });
});

// Once the rules engine is on main, every status and line kind it defines must have a label.
// Read as text so this file does not depend on the engine being merged yet.
const enginePath = fileURLToPath(new URL("../rules-engine/types.ts", import.meta.url));
describe.runIf(existsSync(enginePath))("the rules engine's vocabularies", () => {
  it("are all covered", () => {
    const source = readFileSync(enginePath, "utf8");
    const arrays = [...source.matchAll(/export const (\w+) = \[([^\]]*)\] as const/g)];
    const pick = (name: RegExp) =>
      arrays
        .filter((m) => name.test(m[1]))
        .flatMap((m) => [...m[2].matchAll(/"([^"]+)"/g)].map((v) => v[1]));
    const statuses = pick(/_STATUSES$/);
    const kinds = pick(/^LINE_KINDS$/);
    expect(statuses.length).toBeGreaterThan(0);
    expect(kinds).toHaveLength(10);
    for (const s of statuses) expect(KNOWN_STATUSES).toContain(s);
    for (const k of kinds) expect(KNOWN_LINE_KINDS).toContain(k);
  });
});

describe("recordLabel", () => {
  it("names a short id in full and a long one by its tail", () => {
    expect(recordLabel({ table: "loads", id: "L-10421" })).toBe("Load L-10421");
    expect(recordLabel({ table: "advances", id: "0b9f6a52-3c1d-4e8f-9a7b-5d2c1e7c41e2" })).toBe(
      "Advance ending 7c41e2",
    );
    expect(recordLabel({ table: "pay_configs", id: "1" })).toBe("Pay rules 1");
    expect(recordLabel({ table: "odd_table", id: "9" })).toBe("Odd table 9");
  });
});
