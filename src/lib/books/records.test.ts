import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { recordDocRef, recordLines, recordSwitchOn } from "./records";

// The purchase lines and numbers of a money code and an escrow release (D-104), and their switches.

const TENANT = "5b0e6f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ID = "0123abcd-4567-4ef0-8123-456789abcdef";
const saved = structuredClone(flags.books);

afterEach(() => {
  flags.books.enabled = saved.enabled;
  Object.assign(flags.books.kinds, saved.kinds);
});

describe("books records", () => {
  it("books a money code on driver reimbursements and an escrow release on driver escrow", () => {
    expect(recordLines("money_code_expense", 1_234, "Money code, lumper")).toEqual([
      { role: "driver_reimbursements", amountCents: 1_234, description: "Money code, lumper" },
    ]);
    expect(recordLines("escrow_release_expense", 45_000, "Escrow released")).toEqual([
      { role: "driver_escrow", amountCents: 45_000, description: "Escrow released" },
    ]);
  });

  it("numbers each purchase MC- or ER- from stored ids alone", () => {
    expect(recordDocRef("money_code_expense", TENANT, ID)).toMatch(/^MC-[A-Z0-9]{5}-0123ABCD4567$/);
    expect(recordDocRef("escrow_release_expense", TENANT, ID)).toMatch(/^ER-[A-Z0-9]{5}-0123ABCD4567$/);
    expect(recordDocRef("money_code_expense", TENANT, ID)).toBe(recordDocRef("money_code_expense", TENANT, ID));
  });

  it("posts a kind only with the books switch and its own switch both on", () => {
    flags.books.enabled = false;
    Object.assign(flags.books.kinds, { moneyCodes: true, escrow: true });
    expect(recordSwitchOn("money_code_expense")).toBe(false);
    flags.books.enabled = true;
    flags.books.kinds.escrow = false;
    expect(recordSwitchOn("money_code_expense")).toBe(true);
    expect(recordSwitchOn("escrow_release_expense")).toBe(false);
  });
});
