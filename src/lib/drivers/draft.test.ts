import { describe, expect, it } from "vitest";
import { DriverDraft, FIELD_SENTENCES, percentToBps, RATE_SENTENCES, readDriverForm, type DriverFormText } from "./draft";

// The Add driver body's rules: the pay basis picks exactly one rate, each bound matches the
// drivers table's CHECKs, the code is kept upper case and the email lower case, and the form's
// text becomes whole cents and basis points (never through a float) or a sentence per field.

const BASE = {
  code: " br-d27 ",
  firstName: " Ana ",
  lastName: "Example",
  email: " Ana.Example@Example.TEST ",
  workerType: "company",
  payBasis: "per_mile",
  perMileCents: 62,
};

// BASE without its rate, for the other pay bases.
const NO_RATE = {
  code: BASE.code,
  firstName: BASE.firstName,
  lastName: BASE.lastName,
  email: BASE.email,
  workerType: BASE.workerType,
};

const TEXT: DriverFormText = {
  code: "br-d27",
  firstName: "Ana",
  lastName: "Example",
  email: "ana@example.test",
  workerType: "company",
  payBasis: "per_mile",
  rate: "0.62",
  advanceLimit: "",
  truckUnit: "",
  tankGallons: "200",
  activeFrom: "2026-11-02",
  ownInsurance: false,
  preferredLanguage: "en",
};

describe("DriverDraft", () => {
  it("trims, upper-cases the code, lower-cases the email and fills the defaults", () => {
    expect(DriverDraft.parse(BASE)).toEqual({
      code: "BR-D27",
      firstName: "Ana",
      lastName: "Example",
      email: "ana.example@example.test",
      workerType: "company",
      payBasis: "per_mile",
      perMileCents: 62,
      tankGallons: 200,
      ownInsurance: false,
      preferredLanguage: "en",
    });
  });

  it("parses its own output to the same value, so the service may check a body the route already parsed", () => {
    const once = DriverDraft.parse(BASE);
    expect(DriverDraft.parse(once)).toEqual(once);
  });

  it("takes exactly the one rate its pay basis names", () => {
    const noRate = NO_RATE;
    expect(DriverDraft.safeParse({ ...noRate, payBasis: "percent", percentBps: 7_500 }).success).toBe(true);
    expect(DriverDraft.safeParse({ ...noRate, payBasis: "flat", flatPerLoadCents: 45_000 }).success).toBe(true);
    for (const bad of [
      noRate,
      { ...BASE, percentBps: 7_500 },
      { ...noRate, payBasis: "percent", perMileCents: 62 },
      { ...noRate, payBasis: "flat" },
      { ...BASE, payBasis: "hourly" },
    ]) {
      expect(DriverDraft.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses each value outside the table's bounds", () => {
    for (const over of [
      { code: "B" },
      { code: "BR D27" },
      { code: "BR-D27-XXXXXXXXXXXXXXX" },
      { code: "br_d27" },
      { firstName: "   " },
      { lastName: "x".repeat(61) },
      { firstName: "Ana\nExample" },
      { email: "not-an-email" },
      { email: `${"a".repeat(115)}@x.test` },
      { workerType: "contractor" },
      { perMileCents: 0 },
      { perMileCents: 1_000 },
      { perMileCents: 62.5 },
      { perMileCents: "62" },
      { advanceLimitCents: -1 },
      { advanceLimitCents: 1_000_000_000 },
      { truckUnit: "T 101" },
      { tankGallons: 99 },
      { tankGallons: 401 },
      { activeFrom: "2026-02-30" },
      { activeFrom: "11/02/2026" },
      { preferredLanguage: "fr" },
      { ownInsurance: "yes" },
      { moneyArmed: true },
      { tenantId: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(DriverDraft.safeParse({ ...BASE, ...over }).success, JSON.stringify(over)).toBe(false);
    }
    const noRate = NO_RATE;
    expect(DriverDraft.safeParse({ ...noRate, payBasis: "percent", percentBps: 10_001 }).success).toBe(false);
    expect(DriverDraft.safeParse({ ...noRate, payBasis: "percent", percentBps: 10_000 }).success).toBe(true);
    expect(DriverDraft.safeParse({ ...noRate, payBasis: "flat", flatPerLoadCents: 1_000_000_000 }).success).toBe(false);
    expect(DriverDraft.safeParse({ ...noRate, payBasis: "flat", flatPerLoadCents: 999_999_999 }).success).toBe(true);
  });
});

describe("percentToBps", () => {
  it("reads a percent as typed to whole basis points", () => {
    expect(percentToBps("72.5")).toBe(7_250);
    expect(percentToBps("75")).toBe(7_500);
    expect(percentToBps("0.01")).toBe(1);
    expect(percentToBps("100%")).toBe(10_000);
    for (const bad of ["", "72.555", "-5", "seventy", "1e2", "7 5"]) expect(percentToBps(bad), bad).toBeNull();
  });
});

describe("readDriverForm", () => {
  it("turns the form's text into the route's body in whole cents", () => {
    expect(readDriverForm({ ...TEXT, advanceLimit: "1,250.50", truckUnit: "br-t127", ownInsurance: true })).toEqual({
      ok: true,
      body: {
        code: "BR-D27",
        firstName: "Ana",
        lastName: "Example",
        email: "ana@example.test",
        workerType: "company",
        payBasis: "per_mile",
        perMileCents: 62,
        advanceLimitCents: 125_050,
        truckUnit: "BR-T127",
        tankGallons: 200,
        activeFrom: "2026-11-02",
        ownInsurance: true,
        preferredLanguage: "en",
      },
    });
    const percent = readDriverForm({ ...TEXT, payBasis: "percent", rate: "72.5" });
    expect(percent.ok && percent.body).toMatchObject({ payBasis: "percent", percentBps: 7_250 });
    const flat = readDriverForm({ ...TEXT, payBasis: "flat", rate: "450" });
    expect(flat.ok && flat.body).toMatchObject({ payBasis: "flat", flatPerLoadCents: 45_000 });
    // An empty start date is the carrier's today, set by the service.
    const noDate = readDriverForm({ ...TEXT, activeFrom: "" });
    expect(noDate.ok && "activeFrom" in noDate.body).toBe(false);
  });

  it("answers each wrong field with its own sentence and sends nothing", () => {
    expect(
      readDriverForm({ ...TEXT, code: "x", email: "nope", rate: "abc", tankGallons: "50", advanceLimit: "-3", activeFrom: "2026-13-01" }),
    ).toEqual({
      ok: false,
      errors: {
        code: FIELD_SENTENCES.code,
        email: FIELD_SENTENCES.email,
        rate: RATE_SENTENCES.per_mile,
        tankGallons: FIELD_SENTENCES.tankGallons,
        advanceLimit: FIELD_SENTENCES.advanceLimit,
        activeFrom: FIELD_SENTENCES.activeFrom,
      },
    });
    // A rate in range for one basis and out of range for another is that basis's sentence.
    expect(readDriverForm({ ...TEXT, rate: "10.00" })).toEqual({ ok: false, errors: { rate: RATE_SENTENCES.per_mile } });
    expect(readDriverForm({ ...TEXT, payBasis: "percent", rate: "100.01" })).toEqual({
      ok: false,
      errors: { rate: RATE_SENTENCES.percent },
    });
    expect(readDriverForm({ ...TEXT, firstName: " " })).toEqual({ ok: false, errors: { firstName: FIELD_SENTENCES.firstName } });
  });

  it("names a pick off its list by its field", () => {
    const odd = { ...TEXT, workerType: "contractor" as never, preferredLanguage: "fr" as never };
    expect(readDriverForm(odd)).toEqual({
      ok: false,
      errors: { workerType: FIELD_SENTENCES.workerType, preferredLanguage: FIELD_SENTENCES.preferredLanguage },
    });
  });
});
