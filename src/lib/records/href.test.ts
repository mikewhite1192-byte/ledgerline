import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/rules-engine/types";
import { RECORD_PAGES, RECORD_TABLES, hrefOrNull, recordHref } from "./href";

const RECORDS_DIR = join(process.cwd(), "src", "app", "records");

describe("recordHref", () => {
  it("links a record in a known table", () => {
    expect(recordHref({ table: "loads", id: "a1b2" })).toBe("/records/loads/a1b2");
  });

  it("knows every table the rules engine cites", () => {
    expect(RECORD_TABLES).toEqual(TABLES);
    expect(recordHref({ table: "customer_payments", id: "CP-1" })).toBe("/records/customer_payments/CP-1");
  });

  it("encodes the id so it stays one path segment", () => {
    expect(recordHref({ table: "advances", id: "x/../y" })).toBe("/records/advances/x%2F..%2Fy");
  });

  it("refuses an unknown table or an empty id", () => {
    expect(() => recordHref({ table: "users", id: "1" })).toThrow(RangeError);
    expect(() => recordHref({ table: "loads", id: "" })).toThrow(RangeError);
  });

  it("refuses a record table that has no page", () => {
    for (const table of ["load_state_miles", "fuel_purchases", "pay_configs", "settlement_lines", "payment_applications"]) {
      expect(() => recordHref({ table, id: "x" })).toThrow(RangeError);
    }
  });
});

describe("RECORD_PAGES", () => {
  it("is exactly this list", () => {
    expect([...RECORD_PAGES].sort()).toEqual(
      [
        "advances",
        "customer_payments",
        "customers",
        "deduction_schedules",
        "driver_days",
        "drivers",
        "invoices",
        "load_accessorials",
        "loads",
        "pay_items",
        "settlement_periods",
        "settlements",
        "vendor_bills",
      ].sort(),
    );
  });

  it("names only record tables", () => {
    for (const table of RECORD_PAGES) expect(RECORD_TABLES).toContain(table);
  });

  it("matches the record page files on disk, both ways", () => {
    const onDisk = readdirSync(RECORDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(RECORDS_DIR, d.name, "[id]", "page.tsx")))
      .map((d) => d.name)
      .sort();
    expect(onDisk).toEqual([...RECORD_PAGES].sort());
  });
});

describe("hrefOrNull", () => {
  it("passes a good link through", () => {
    expect(hrefOrNull(recordHref, { table: "loads", id: "L-1" })).toBe("/records/loads/L-1");
  });

  it("turns a refused ref into null", () => {
    expect(hrefOrNull(recordHref, { table: "users", id: "1" })).toBeNull();
    expect(hrefOrNull(recordHref, { table: "loads", id: "" })).toBeNull();
  });

  it("returns null for every record table off the page list", () => {
    for (const table of RECORD_TABLES.filter((t) => !RECORD_PAGES.includes(t))) {
      expect(hrefOrNull(recordHref, { table, id: "x" })).toBeNull();
    }
    for (const table of RECORD_PAGES) {
      expect(hrefOrNull(recordHref, { table, id: "x" })).toBe(`/records/${table}/x`);
    }
  });

  it("still throws anything that is not a refusal", () => {
    const broken = () => {
      throw new TypeError("broken");
    };
    expect(() => hrefOrNull(broken, { table: "loads", id: "L-1" })).toThrow(TypeError);
  });
});
