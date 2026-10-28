import { describe, expect, it } from "vitest";
import { reasonSentence } from "../agent/reasons";
import { REFUSAL_SENTENCES } from "../money-codes/words";
import {
  checkMoneyCode,
  MONEY_CODE_REASONS,
  MONEY_CODE_REFUSALS,
  type MoneyCodeInput,
  type MoneyCodeReceipt,
  type MoneyCodeRecord,
} from "./money-codes";
import { InputError } from "./types";

const DRIVER = "driver-a";
const OTHER_DRIVER = "driver-b";
const LOAD = "load-1";
const NOW = "2026-10-28T15:00:00.000Z";
const TODAY = "2026-10-28";

const receipt = (over: Partial<MoneyCodeReceipt> = {}): MoneyCodeReceipt => ({
  readStatus: "read",
  kind: "lumper_receipt",
  totalCents: 15_000,
  loadNumber: "L-1001",
  kindConfidence: "high",
  totalConfidence: "high",
  loadNumberConfidence: "medium",
  ...over,
});

const code = (over: Partial<MoneyCodeRecord> = {}): MoneyCodeRecord => ({
  id: "code-1",
  driverId: DRIVER,
  loadId: LOAD,
  purpose: "lumper",
  amountCents: 15_000,
  status: "issued",
  createdAt: "2026-10-28T09:00:00.000Z",
  createdOn: TODAY,
  ...over,
});

function input(over: Partial<MoneyCodeInput> = {}): MoneyCodeInput {
  return {
    driverId: DRIVER,
    driverArmed: true,
    load: { id: LOAD, driverId: DRIVER, status: "in_transit", loadNumber: "L-1001", deliveredOn: null },
    purpose: "lumper",
    amountCents: 15_000,
    capCents: 50_000,
    perDriverPerDay: 2,
    now: NOW,
    today: TODAY,
    source: "document",
    receipt: receipt(),
    voice: null,
    codes: [],
    ...over,
  };
}

const refusalsOf = (over: Partial<MoneyCodeInput>) => {
  const d = checkMoneyCode(input(over));
  return d.ok ? [] : d.refusals;
};

describe("checkMoneyCode", () => {
  it("allows a code for exactly the receipt total on the driver's load in transit", () => {
    expect(checkMoneyCode(input())).toEqual({
      ok: true,
      amountCents: 15_000,
      purpose: "lumper",
      reasons: ["load_in_transit", "receipt_total_matches", "driver_armed"],
    });
  });

  it("refuses another driver's load and a load that does not exist", () => {
    const other = { id: LOAD, driverId: OTHER_DRIVER, status: "in_transit" as const, loadNumber: "L-1001", deliveredOn: null };
    expect(refusalsOf({ load: other })).toEqual(["load_not_drivers"]);
    expect(refusalsOf({ load: { ...other, driverId: null } })).toEqual(["load_not_drivers"]);
    expect(refusalsOf({ load: null })).toEqual(["load_not_drivers", "receipt_other_load"]);
  });

  it("counts a delivered load as active for three days, then not", () => {
    const delivered = (deliveredOn: string | null) => ({
      id: LOAD,
      driverId: DRIVER,
      status: "delivered" as const,
      loadNumber: "L-1001",
      deliveredOn,
    });
    const ok = checkMoneyCode(input({ load: delivered("2026-10-25") }));
    expect(ok.ok && ok.reasons[0]).toBe("load_delivered_recently");
    expect(refusalsOf({ load: delivered("2026-10-28") })).toEqual([]);
    expect(refusalsOf({ load: delivered("2026-10-24") })).toEqual(["load_not_active"]);
    expect(refusalsOf({ load: delivered("2026-10-29") })).toEqual(["load_not_active"]);
    expect(refusalsOf({ load: delivered(null) })).toEqual(["load_not_active"]);
  });

  it.each(["planned", "cancelled"] as const)("refuses a %s load", (status) => {
    const load = { id: LOAD, driverId: DRIVER, status, loadNumber: "L-1001", deliveredOn: "2026-10-28" };
    expect(refusalsOf({ load })).toEqual(["load_not_active"]);
  });

  it("counts an invoiced load as delivered for a repair or other code, in the same three days", () => {
    const invoiced = (deliveredOn: string | null) => ({
      id: LOAD,
      driverId: DRIVER,
      status: "invoiced" as const,
      loadNumber: "L-1001",
      deliveredOn,
    });
    const form = { source: "form" as const, receipt: null };
    for (const purpose of ["repair", "other"] as const) {
      // Delivered two days ago and invoiced this morning: still allowed.
      expect(checkMoneyCode(input({ ...form, purpose, load: invoiced("2026-10-26") }))).toEqual({
        ok: true,
        amountCents: 15_000,
        purpose,
        reasons: ["load_delivered_recently", "driver_armed"],
      });
      expect(refusalsOf({ ...form, purpose, load: invoiced("2026-10-25") })).toEqual([]);
      expect(refusalsOf({ ...form, purpose, load: invoiced("2026-10-24") })).toEqual(["load_not_active"]);
      expect(refusalsOf({ ...form, purpose, load: invoiced("2026-10-29") })).toEqual(["load_not_active"]);
      expect(refusalsOf({ ...form, purpose, load: invoiced(null) })).toEqual(["load_not_active"]);
    }
    // A repair receipt on an invoiced load is checked like any other.
    expect(
      refusalsOf({ purpose: "repair", receipt: receipt({ kind: "other" }), load: invoiced("2026-10-27") }),
    ).toEqual([]);
  });

  it("refuses a lumper code on an invoiced load, whose invoice can no longer take the lumper line", () => {
    const invoiced = (deliveredOn: string | null) => ({
      id: LOAD,
      driverId: DRIVER,
      status: "invoiced" as const,
      loadNumber: "L-1001",
      deliveredOn,
    });
    expect(checkMoneyCode(input({ load: invoiced("2026-10-27") }))).toEqual({
      ok: false,
      category: "load_invoiced",
      refusals: ["load_invoiced"],
    });
    expect(refusalsOf({ source: "form", receipt: null, load: invoiced("2026-10-28") })).toEqual(["load_invoiced"]);
    expect(refusalsOf({ load: invoiced("2026-10-24") })).toEqual(["load_not_active", "load_invoiced"]);
    // Delivered, not invoiced yet: the lumper line can still reach the invoice.
    expect(refusalsOf({ load: { ...invoiced("2026-10-27"), status: "delivered" } })).toEqual([]);
  });

  it("refuses an amount that is not a positive whole number of cents, and one over the cap", () => {
    for (const amountCents of [0, -100, 150.5, Number.NaN, "15000", null, 2 ** 60]) {
      expect(refusalsOf({ amountCents, source: "chat", receipt: null })).toEqual(["amount_invalid"]);
    }
    expect(refusalsOf({ amountCents: 50_000, capCents: 50_000, source: "chat", receipt: null })).toEqual([]);
    expect(refusalsOf({ amountCents: 50_001, capCents: 50_000, source: "chat", receipt: null })).toEqual([
      "over_code_cap",
    ]);
  });

  it("compares the receipt total as a whole value", () => {
    expect(refusalsOf({ amountCents: 15_001 })).toEqual(["receipt_total_differs"]);
    expect(refusalsOf({ amountCents: 1_500 })).toEqual(["receipt_total_differs"]);
    expect(refusalsOf({ receipt: receipt({ totalCents: 150_000 }), amountCents: 15_000 })).toEqual([
      "receipt_total_differs",
    ]);
  });

  it("refuses a receipt that names another load, or none, by whole value", () => {
    expect(refusalsOf({ receipt: receipt({ loadNumber: "L-10010" }) })).toEqual(["receipt_other_load"]);
    expect(refusalsOf({ receipt: receipt({ loadNumber: "L-100" }) })).toEqual(["receipt_other_load"]);
    expect(refusalsOf({ receipt: receipt({ loadNumber: null }) })).toEqual(["receipt_other_load"]);
    expect(refusalsOf({ receipt: receipt({ loadNumber: "  l-1001 " }) })).toEqual([]);
  });

  it("gives no amount for an unread or unsure receipt", () => {
    for (const r of [
      receipt({ readStatus: "pending" }),
      receipt({ readStatus: "unreadable" }),
      receipt({ readStatus: "budget" }),
      receipt({ totalCents: null }),
      receipt({ totalConfidence: "low" }),
      receipt({ loadNumberConfidence: "low" }),
      receipt({ kindConfidence: "low" }),
      receipt({ totalConfidence: null }),
    ]) {
      expect(refusalsOf({ receipt: r })).toEqual(["receipt_unreadable"]);
    }
    expect(refusalsOf({ receipt: null })).toEqual(["evidence_missing"]);
  });

  it("matches the receipt kind to the purpose", () => {
    expect(refusalsOf({ receipt: receipt({ kind: "fuel_receipt" }) })).toEqual(["receipt_kind"]);
    expect(refusalsOf({ purpose: "repair" })).toEqual(["receipt_kind"]);
    expect(refusalsOf({ purpose: "repair", receipt: receipt({ kind: "other" }) })).toEqual([]);
    expect(refusalsOf({ purpose: "other", receipt: receipt({ kind: "other" }) })).toEqual([]);
  });

  it("takes a voice note's spoken amount only when it is one of them exactly", () => {
    const voice = { driverId: DRIVER, amountsCents: [2_000, 15_000] };
    const ok = checkMoneyCode(input({ source: "voice_note", receipt: null, voice }));
    expect(ok).toEqual({
      ok: true,
      amountCents: 15_000,
      purpose: "lumper",
      reasons: ["load_in_transit", "voice_amount", "driver_armed"],
    });
    expect(refusalsOf({ source: "voice_note", receipt: null, voice: { ...voice, amountsCents: [15_001] } })).toEqual([
      "voice_amount_differs",
    ]);
    expect(refusalsOf({ source: "voice_note", receipt: null, voice: { ...voice, amountsCents: [] } })).toEqual([
      "voice_amount_differs",
    ]);
    expect(refusalsOf({ source: "voice_note", receipt: null, voice: null })).toEqual(["evidence_missing"]);
  });

  it("takes a voice note only from this driver: another driver's or an unmatched sender's is refused", () => {
    const voice = { driverId: DRIVER, amountsCents: [15_000] };
    // Matched to this driver: passes.
    expect(refusalsOf({ source: "voice_note", receipt: null, voice })).toEqual([]);
    // Matched to another driver.
    expect(refusalsOf({ source: "voice_note", receipt: null, voice: { ...voice, driverId: OTHER_DRIVER } })).toEqual([
      "voice_other_driver",
    ]);
    // Matched to no driver: its own reason, even when the amount is spoken exactly.
    expect(checkMoneyCode(input({ source: "voice_note", receipt: null, voice: { ...voice, driverId: null } }))).toEqual({
      ok: false,
      category: "voice_driver_unmatched",
      refusals: ["voice_driver_unmatched"],
    });
    expect(
      refusalsOf({ source: "voice_note", receipt: null, voice: { driverId: null, amountsCents: [15_001] } }),
    ).toEqual(["voice_driver_unmatched", "voice_amount_differs"]);
  });

  it("checks no evidence for a chat or form request", () => {
    expect(checkMoneyCode(input({ source: "form", receipt: null }))).toEqual({
      ok: true,
      amountCents: 15_000,
      purpose: "lumper",
      reasons: ["load_in_transit", "driver_armed"],
    });
  });

  it("refuses a driver nobody armed", () => {
    expect(refusalsOf({ driverArmed: false })).toEqual(["driver_not_armed"]);
  });

  it("refuses the same load, purpose and amount inside 24 hours, live codes only", () => {
    expect(refusalsOf({ codes: [code()] })).toEqual(["duplicate_code"]);
    expect(refusalsOf({ codes: [code({ status: "unknown" })] })).toEqual(["duplicate_code"]);
    expect(refusalsOf({ codes: [code({ status: "issuing" })] })).toEqual(["duplicate_code"]);
    expect(refusalsOf({ codes: [code({ status: "failed" })] })).toEqual([]);
    expect(refusalsOf({ codes: [code({ status: "voided" })] })).toEqual([]);
    expect(refusalsOf({ codes: [code({ amountCents: 15_100 })] })).toEqual([]);
    expect(refusalsOf({ codes: [code({ purpose: "repair" })] })).toEqual([]);
    expect(refusalsOf({ codes: [code({ loadId: "load-2" })] })).toEqual([]);
    // Exactly 24 hours old is outside the window; a second less is inside.
    expect(
      refusalsOf({ codes: [code({ createdAt: "2026-10-27T15:00:00.000Z", createdOn: "2026-10-27" })] }),
    ).toEqual([]);
    expect(
      refusalsOf({ codes: [code({ createdAt: "2026-10-27T15:00:01.000Z", createdOn: "2026-10-27" })] }),
    ).toEqual(["duplicate_code"]);
    // A code stamped after now is not treated as old.
    expect(refusalsOf({ codes: [code({ createdAt: "2026-10-28T16:00:00.000Z" })] })).toEqual(["duplicate_code"]);
  });

  it("allows perDriverPerDay live codes on the tenant-local day", () => {
    const other = (id: string, over: Partial<MoneyCodeRecord> = {}) =>
      code({ id, loadId: `load-${id}`, ...over });
    expect(refusalsOf({ codes: [other("x")] })).toEqual([]);
    expect(refusalsOf({ codes: [other("x"), other("y")] })).toEqual(["daily_limit"]);
    expect(refusalsOf({ codes: [other("x"), other("y", { status: "failed" })] })).toEqual([]);
    expect(refusalsOf({ codes: [other("x"), other("y", { createdOn: "2026-10-27" })] })).toEqual([]);
    expect(refusalsOf({ codes: [other("x"), other("y", { driverId: OTHER_DRIVER })] })).toEqual([]);
    expect(refusalsOf({ perDriverPerDay: 0 })).toEqual(["daily_limit"]);
  });

  it("lists every refusal in a fixed order and names the first", () => {
    const d = checkMoneyCode(
      input({
        driverArmed: false,
        amountCents: 15_001,
        receipt: receipt({ kind: "toll_receipt", loadNumber: "L-9" }),
        codes: [code({ loadId: "load-x" }), code({ loadId: "load-y" })],
      }),
    );
    expect(d).toEqual({
      ok: false,
      category: "receipt_kind",
      refusals: ["receipt_kind", "receipt_total_differs", "receipt_other_load", "driver_not_armed", "daily_limit"],
    });
    if (!d.ok) {
      const order = d.refusals.map((r) => MONEY_CODE_REFUSALS.indexOf(r));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it("throws on malformed caller input, never on the asked amount", () => {
    expect(() => checkMoneyCode(input({ purpose: "fuel" as never }))).toThrow(InputError);
    expect(() => checkMoneyCode(input({ source: "email" as never }))).toThrow(InputError);
    expect(() => checkMoneyCode(input({ now: "2026-10-28" }))).toThrow(InputError);
    expect(() => checkMoneyCode(input({ today: "10/28/2026" }))).toThrow(InputError);
    expect(() => checkMoneyCode(input({ capCents: -1 }))).toThrow(InputError);
    expect(() => checkMoneyCode(input({ driverId: "" }))).toThrow(InputError);
  });
});

describe("money code words", () => {
  it("has a card sentence for every reason and a page sentence for every refusal", () => {
    for (const r of MONEY_CODE_REASONS) expect(reasonSentence(r), r).not.toBe("A rule check found this.");
    for (const r of MONEY_CODE_REFUSALS) expect(REFUSAL_SENTENCES[r], r).toBeTruthy();
  });
});
