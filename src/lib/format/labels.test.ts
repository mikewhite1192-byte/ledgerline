import { describe, expect, it } from "vitest";
import * as engine from "@/lib/rules-engine";
import {
  codeToWords,
  KNOWN_LINE_KINDS,
  KNOWN_STATUSES,
  lineKindLabel,
  modelCallStatusLabel,
  paymentHabitLabel,
  recordLabel,
  recordNamer,
  stepLabel,
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

  it("says the in-between states in plain words", () => {
    expect(statusLabel("reserved")).toBe("Waiting to send");
    expect(statusLabel("unknown")).toBe("Not confirmed yet");
    expect(statusLabel("executing")).toBe("Processing");
    expect(statusLabel("incomplete")).toBe("Stopped early");
    expect(statusLabel("cancelled")).toBe("Canceled");
    expect(statusLabel("proposed")).toBe("Waiting for approval");
  });

  it("degrades an unknown status to words and never throws", () => {
    expect(statusLabel("partly_shipped")).toBe("Partly shipped");
    expect(statusLabel("")).toBe("Not set");
    expect(statusLabel("__")).toBe("Not set");
    expect(statusLabel("toString")).toBe("Tostring");
  });

  it("never says a money action is being sent before it is, while a model call that is out says so", () => {
    expect(statusLabel("reserved")).not.toMatch(/being sent/i);
    expect(modelCallStatusLabel("reserved")).toBe("Being sent");
    for (const s of ["ok", "incomplete", "failed", "unknown", "new_code"]) {
      expect(modelCallStatusLabel(s)).toBe(statusLabel(s));
    }
  });

  it("never calls an approved proposal that is running Approving", () => {
    expect(statusLabel("approved")).toBe("Approved");
    expect(statusLabel("executing")).not.toMatch(/approv/i);
  });
});

describe("lineKindLabel", () => {
  it("gives every pay line kind a plain label", () => {
    expect(KNOWN_LINE_KINDS).toHaveLength(11);
    for (const k of KNOWN_LINE_KINDS) expect(lineKindLabel(k)).toMatch(plain);
    expect(lineKindLabel("advance_recovery")).toBe("Advance repaid");
    expect(lineKindLabel("deficit_recovery")).toBe("Owed");
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
    expect(engine.LINE_KINDS).toHaveLength(11);
    for (const s of statuses) expect(KNOWN_STATUSES).toContain(s);
    for (const k of engine.LINE_KINDS) expect(KNOWN_LINE_KINDS).toContain(k);
  });
});

describe("recordLabel", () => {
  it("names a short id in full and a long one by its kind alone, never an id tail", () => {
    expect(recordLabel({ table: "loads", id: "L-10421" })).toBe("Load L-10421");
    expect(recordLabel({ table: "advances", id: "0b9f6a52-3c1d-4e8f-9a7b-5d2c1e7c41e2" })).toBe(
      "Advance",
    );
    expect(recordLabel({ table: "pay_configs", id: "1" })).toBe("Pay rules 1");
    expect(recordLabel({ table: "odd_table", id: "9" })).toBe("Odd table 9");
  });

  it("uses the record's own reference when it has one: a name alone for a person or customer", () => {
    const long = "0b9f6a52-3c1d-4e8f-9a7b-5d2c1e7c41e2";
    expect(recordLabel({ table: "drivers", id: long }, "Monique Vasquez")).toBe("Monique Vasquez");
    expect(recordLabel({ table: "customers", id: long }, "Tanglewood Grocery Supply")).toBe("Tanglewood Grocery Supply");
    expect(recordLabel({ table: "loads", id: long }, "BR-L10244")).toBe("Load BR-L10244");
    expect(recordLabel({ table: "invoices", id: long }, " BR-INV-10001 ")).toBe("Invoice BR-INV-10001");
  });

  it("falls back to the kind when the reference is missing or blank", () => {
    const long = "0b9f6a52-3c1d-4e8f-9a7b-5d2c1e7c41e2";
    for (const none of [undefined, null, "", "   "]) {
      expect(recordLabel({ table: "loads", id: long }, none)).toBe("Load");
      expect(recordLabel({ table: "loads", id: "L-10421" }, none)).toBe("Load L-10421");
    }
  });
});

describe("paymentHabitLabel", () => {
  it("says every way a customer pays in plain words", () => {
    expect(paymentHabitLabel("reliable")).toBe("Reliable");
    expect(paymentHabitLabel("mixed")).toBe("Mixed");
    expect(paymentHabitLabel("repeat_late")).toBe("Often late");
    expect(paymentHabitLabel("brand_new")).toBe("Brand new");
  });
});

describe("recordNamer", () => {
  const LOAD_A = { table: "loads", id: "0b9f6a52-3c1d-4e8f-9a7b-5d2c1e7c41e2" };
  const LOAD_B = { table: "loads", id: "7d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5" };
  const DRIVER = { table: "drivers", id: "11111111-2222-4333-8444-555555555555" };

  it("tells two records of one kind apart by their place, never by an id tail", () => {
    const name = recordNamer([LOAD_A, DRIVER, LOAD_B]);
    expect([LOAD_A, DRIVER, LOAD_B].map(name)).toEqual(["Load 1 of 2", "Driver", "Load 2 of 2"]);
  });

  it("keeps one name for a record listed twice, and the kind alone when it is the only one", () => {
    const name = recordNamer([LOAD_A, LOAD_A, DRIVER]);
    expect([LOAD_A, LOAD_A, DRIVER].map(name)).toEqual(["Load", "Load", "Driver"]);
    expect(recordNamer([LOAD_A, LOAD_B, LOAD_A])(LOAD_A)).toBe("Load 1 of 2");
  });

  it("leaves a short id as it is and names a record it was not given by its kind", () => {
    const short = { table: "loads", id: "L-10421" };
    const name = recordNamer([LOAD_A, short, LOAD_B]);
    expect(name(short)).toBe("Load L-10421");
    expect(name({ table: "loads", id: "99999999-8888-4777-8666-555555555555" })).toBe("Load");
  });
});

describe("stepLabel", () => {
  it("reads a saved step label with an internal word in plain words", () => {
    expect(stepLabel("Reading the proposal and its evidence")).toBe("Reading the card and its evidence");
    expect(stepLabel("Aging the receivables")).toBe("Sorting open invoices by how late they are");
    expect(stepLabel("Preparing a proposal card")).toBe("Preparing a card");
  });

  it("leaves every other label as saved", () => {
    expect(stepLabel("Reading loads")).toBe("Reading loads");
    expect(stepLabel("")).toBe("");
  });
});
