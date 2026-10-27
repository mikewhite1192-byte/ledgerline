import { describe, expect, it } from "vitest";
import * as engine from "@/lib/rules-engine";
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

// Every status vocabulary and pay line kind the rules engine exports must have a label. The lists
// are imported, so one that is renamed or moved fails the build instead of skipping this test.
describe("the rules engine's vocabularies", () => {
  it("are all covered", () => {
    // Any other status list the engine exports, including one added later, is checked too.
    const exported = Object.entries(engine)
      .filter(([name, value]) => name.endsWith("_STATUSES") && Array.isArray(value))
      .flatMap(([, value]) => value as readonly string[]);
    const statuses = [
      ...engine.LOAD_STATUSES,
      ...engine.ADVANCE_STATUSES,
      ...engine.PERIOD_STATUSES,
      ...engine.SETTLEMENT_STATUSES,
      ...engine.INVOICE_STATUSES,
      ...exported,
    ];
    expect(engine.LINE_KINDS).toHaveLength(10);
    for (const s of statuses) expect(KNOWN_STATUSES).toContain(s);
    for (const k of engine.LINE_KINDS) expect(KNOWN_LINE_KINDS).toContain(k);
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
