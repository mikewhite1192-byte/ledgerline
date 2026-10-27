import { describe, expect, it } from "vitest";
import { buildReminderPack, type ReminderFigures } from "./pack";
import { BANNED, MAX_SUBJECT_CHARS, namesInvoice, parseReminder, verifyReminder } from "./verify";

// The check every drafted reminder passes before a person sees it (design 4.2): exact shape, a
// subject that names the invoice, no banned words, and every number from the invoice's own figures
// with the balance due first.

const FIGURES: ReminderFigures = {
  invoiceNumber: "BRF-INV-10012",
  amountCents: 245_000,
  balanceCents: 222_500,
  dueOn: "2026-09-23",
  daysLate: 34,
  asOf: "2026-10-27",
  profileLabel: "repeat_late",
};
const PACK = buildReminderPack(FIGURES, "direct", "Cobble Ridge Furniture", "Example Freight Lines");

const SUBJECT = "Invoice BRF-INV-10012 is past due";
const BODY =
  "Hello Cobble Ridge Furniture team,\n\n" +
  "Our records show a balance of $2,225.00 on invoice BRF-INV-10012 (total $2,450.00), due on " +
  "September 23, 2026, now 34 days past due. Please send payment or let us know when to expect it.\n\n" +
  "Thank you,\nExample Freight Lines";
const reply = (over: Partial<{ subject: string; body: string }> = {}) => JSON.stringify({ subject: SUBJECT, body: BODY, ...over });

describe("verifyReminder", () => {
  it("keeps a reminder that names the invoice and repeats only its figures, balance first", () => {
    const out = verifyReminder(reply(), PACK);
    expect(out).toMatchObject({ ok: true, subject: SUBJECT, body: BODY });
    if (!out.ok) throw new Error("refused");
    expect(out.verification).toEqual({ allowed: [222_500, 245_000], found: [222_500, 245_000], numbers: expect.any(Array), category: null });
  });

  it("a reminder with a figure not in the pack is refused as number_mismatch", () => {
    const amount = verifyReminder(reply({ body: BODY.replace("(total $2,450.00)", "(total $2,500.00)") }), PACK);
    expect(amount).toMatchObject({ ok: false, category: "number_mismatch" });
    if (amount.ok) throw new Error("kept");
    expect(amount.verification.found).toContain(250_000);
    // A bare number the pack does not hold: days late made up.
    const days = verifyReminder(reply({ body: BODY.replace("34 days", "45 days") }), PACK);
    expect(days).toMatchObject({ ok: false, category: "number_mismatch" });
    // A date written with a month number the pack does not hold.
    const date = verifyReminder(reply({ body: BODY.replace("September 23, 2026", "9/23/2026") }), PACK);
    expect(date).toMatchObject({ ok: false, category: "number_mismatch" });
  });

  it("a reminder whose first amount is not the balance is refused", () => {
    const body =
      "Hello,\n\nInvoice BRF-INV-10012 for $2,450.00 has a balance of $2,225.00, 34 days past due. Please pay.\n\nExample Freight Lines";
    expect(verifyReminder(reply({ body }), PACK)).toMatchObject({ ok: false, category: "number_mismatch" });
    // No amount at all is refused too: the balance must be stated.
    const none = "Hello,\n\nInvoice BRF-INV-10012 is 34 days past due. Please pay.\n\nExample Freight Lines";
    expect(verifyReminder(reply({ body: none }), PACK)).toMatchObject({ ok: false, category: "number_mismatch" });
  });

  it("a banned phrase is refused", () => {
    for (const words of [
      "Late fees will apply.",
      "Interest accrues daily.",
      "We may take legal action.",
      "Our attorney will contact you.",
      "This goes to a collection agency next.",
      "Please pay immediately.",
      "A penalty applies.",
    ]) {
      const out = verifyReminder(reply({ body: BODY.replace("Thank you,", `${words}\nThank you,`) }), PACK);
      expect(out, words).toMatchObject({ ok: false, category: "banned_phrase" });
    }
    expect(verifyReminder(reply({ subject: `Legal notice: ${SUBJECT}` }), PACK)).toMatchObject({
      ok: false,
      category: "banned_phrase",
    });
    // Whole words only.
    for (const fine of ["feedback", "interested", "courtesy", "legalese"]) expect(BANNED.test(fine), fine).toBe(false);
  });

  it("refuses a subject that is empty, too long, two lines, or does not name this invoice", () => {
    expect(verifyReminder(reply({ subject: "  " }), PACK)).toMatchObject({ ok: false, category: "subject" });
    expect(verifyReminder(reply({ subject: `${SUBJECT} ${"x".repeat(MAX_SUBJECT_CHARS)}` }), PACK)).toMatchObject({
      ok: false,
      category: "subject",
    });
    expect(verifyReminder(reply({ subject: "Invoice BRF-INV-10012\nis past due" }), PACK)).toMatchObject({
      ok: false,
      category: "subject",
    });
    expect(verifyReminder(reply({ subject: "Your invoice is past due" }), PACK)).toMatchObject({ ok: false, category: "subject" });
    expect(verifyReminder(reply({ subject: "Invoice BRF-INV-100123 is past due" }), PACK)).toMatchObject({
      ok: false,
      category: "subject",
    });
  });

  it("refuses anything but exactly a subject and a body, both text", () => {
    for (const text of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ subject: SUBJECT }),
      JSON.stringify({ subject: SUBJECT, body: BODY, to: "someone@example.test" }),
      JSON.stringify({ subject: SUBJECT, body: 5 }),
    ]) {
      expect(verifyReminder(text, PACK), text).toMatchObject({ ok: false, category: "format" });
    }
    // A link or an empty body fails the shared format check.
    expect(verifyReminder(reply({ body: `${BODY}\nPay at https://pay.example.test` }), PACK)).toMatchObject({
      ok: false,
      category: "format",
    });
    expect(verifyReminder(reply({ body: " " }), PACK)).toMatchObject({ ok: false, category: "format" });
  });

  it("stores amounts and numbers only, never the text, on a refusal", () => {
    const out = verifyReminder(reply({ body: BODY.replace("$2,225.00", "$9,999.00") }), PACK);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.verification)).not.toMatch(/Cobble|Hello|invoice/i);
  });
});

describe("parseReminder and namesInvoice", () => {
  it("reads exactly the two keys", () => {
    expect(parseReminder(reply())).toEqual({ subject: SUBJECT, body: BODY });
    expect(parseReminder(JSON.stringify({ body: BODY, subject: SUBJECT }))).toEqual({ subject: SUBJECT, body: BODY });
    expect(parseReminder("{}")).toBeNull();
  });

  it("matches the invoice number as a whole token", () => {
    expect(namesInvoice("Invoice BRF-INV-10012 is past due", "BRF-INV-10012")).toBe(true);
    expect(namesInvoice("BRF-INV-10012", "BRF-INV-10012")).toBe(true);
    expect(namesInvoice("Re: BRF-INV-10012.", "BRF-INV-10012")).toBe(true);
    expect(namesInvoice("Invoice XBRF-INV-10012", "BRF-INV-10012")).toBe(false);
    expect(namesInvoice("Invoice BRF-INV-100120", "BRF-INV-10012")).toBe(false);
    expect(namesInvoice("Invoice BRF-INV-10012-2", "BRF-INV-10012")).toBe(false);
    // A later whole mention counts even after one inside a longer token.
    expect(namesInvoice("XBRF-INV-10012 and BRF-INV-10012", "BRF-INV-10012")).toBe(true);
    // Pattern characters in the number are plain text.
    expect(namesInvoice("Invoice A.B+1 is past due", "A.B+1")).toBe(true);
    expect(namesInvoice("Invoice AxB+1 is past due", "A.B+1")).toBe(false);
    expect(namesInvoice("Invoice is past due", "")).toBe(false);
  });
});
