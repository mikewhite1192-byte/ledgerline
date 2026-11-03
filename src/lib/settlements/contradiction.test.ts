import { describe, expect, it } from "vitest";
import { cents as c, type PayLine } from "../rules-engine";
import { findContradictions, parseSourceRef, type SourceFacts } from "./contradiction";
import { linesHash } from "./hash";
import { NamedLineBody, namedItemRef } from "./named-line";

// The contradiction check is pure: no clock, no database. Each case builds the facts the reads
// would return.
const STUB = "00000000-0000-4000-8000-000000000001";
const PERSON = "00000000-0000-4000-8000-000000000002";
const FUEL = "00000000-0000-4000-8000-000000000003";
const LUMPER = "00000000-0000-4000-8000-000000000004";
const ITEM = "00000000-0000-4000-8000-000000000005";
const DAY = ["00000000-0000-4000-8000-0000000000d1", "00000000-0000-4000-8000-0000000000d2"];

type Line = Pick<PayLine, "kind" | "amountCents" | "sources" | "meta" | "enteredBy" | "sourceRef">;

const named = (over: Partial<Line> = {}): Line => ({
  kind: "reimbursement",
  amountCents: c(4_250),
  sources: [{ table: "pay_items", id: ITEM }],
  enteredBy: PERSON,
  sourceRef: `load_accessorials:${LUMPER}`,
  ...over,
});

const insurance = (over: Partial<Line> = {}): Line => ({
  kind: "insurance",
  amountCents: c(-3_000),
  sources: DAY.map((id) => ({ table: "driver_days" as const, id })),
  meta: { days: 2, perDayCents: 1_500 },
  ...over,
});

const facts = (amounts: [string, number | null][] = [], days: [string, string | null][] = []): SourceFacts => ({
  amounts: new Map(amounts),
  days: new Map(days),
});

const BOTH_DAYS: [string, string][] = [
  [`driver_days:${DAY[0]}`, "2026-11-02"],
  [`driver_days:${DAY[1]}`, "2026-11-03"],
];
const LUMPER_FACT: [string, number] = [`load_accessorials:${LUMPER}`, 4_250];

describe("findContradictions", () => {
  it("accepts the engine's own lines and a named line that matches its record", () => {
    const lines: Line[] = [
      { kind: "load_pay", amountCents: c(82_500), sources: [{ table: "loads", id: ITEM }] },
      named(),
      named({ kind: "other_deduction", amountCents: c(-6_100), sourceRef: `fuel_purchases:${FUEL}` }),
      insurance(),
    ];
    const f = facts([LUMPER_FACT, [`fuel_purchases:${FUEL}`, 6_100]], BOTH_DAYS);
    expect(findContradictions(lines, f, STUB)).toEqual([]);
  });

  it("refuses a named line one cent off its record, citing the record", () => {
    expect(findContradictions([named({ amountCents: c(4_251) })], facts([LUMPER_FACT]), STUB)).toEqual([
      { category: "contradicting_line", source: { table: "load_accessorials", id: LUMPER } },
    ]);
  });

  it("refuses a named line whose record is gone or was not read", () => {
    expect(findContradictions([named()], facts([[LUMPER_FACT[0], null]]), STUB)).toHaveLength(1);
    expect(findContradictions([named()], facts(), STUB)).toHaveLength(1);
  });

  it("refuses a named line missing its record or its person, citing the line's source", () => {
    const want = [{ category: "contradicting_line", source: { table: "pay_items", id: ITEM } }];
    expect(findContradictions([named({ sourceRef: null })], facts([LUMPER_FACT]), STUB)).toEqual(want);
    expect(findContradictions([named({ enteredBy: null })], facts([LUMPER_FACT]), STUB)).toEqual(want);
    expect(findContradictions([named({ sourceRef: `loads:${LUMPER}` })], facts([LUMPER_FACT]), STUB)).toEqual(
      want,
    );
  });

  it("refuses insurance days above the day rows it cites, and days with no rows", () => {
    const over = insurance({ amountCents: c(-4_500), meta: { days: 3, perDayCents: 1_500 } });
    expect(findContradictions([over], facts([], BOTH_DAYS), STUB)).toEqual([
      { category: "contradicting_line", source: { table: "driver_days", id: DAY[0] } },
    ]);
    const none = insurance({ sources: [] });
    expect(findContradictions([none], facts(), STUB)).toEqual([
      { category: "contradicting_line", source: { table: "settlements", id: STUB } },
    ]);
  });

  it("refuses insurance whose day row is gone, or two rows on one date counted as two days", () => {
    expect(findContradictions([insurance()], facts([], [BOTH_DAYS[0]]), STUB)).toHaveLength(1);
    const sameDate = facts([], [BOTH_DAYS[0], [BOTH_DAYS[1][0], BOTH_DAYS[0][1]]]);
    expect(findContradictions([insurance()], sameDate, STUB)).toHaveLength(1);
  });

  it("refuses an insurance amount that is not days times the rate, and a missing rate", () => {
    expect(findContradictions([insurance({ amountCents: c(-3_001) })], facts([], BOTH_DAYS), STUB)).toHaveLength(1);
    expect(
      findContradictions([insurance({ meta: { days: 2 } as PayLine["meta"] })], facts([], BOTH_DAYS), STUB),
    ).toHaveLength(1);
    expect(
      findContradictions([insurance({ meta: { days: 2, perDayCents: 1.5 } })], facts([], BOTH_DAYS), STUB),
    ).toHaveLength(1);
  });
});

describe("parseSourceRef", () => {
  it("reads the whole value only, for the two tables", () => {
    expect(parseSourceRef(`fuel_purchases:${FUEL}`)).toEqual({ table: "fuel_purchases", id: FUEL });
    expect(parseSourceRef(`load_accessorials:${LUMPER}`)).toEqual({ table: "load_accessorials", id: LUMPER });
    for (const near of [
      `loads:${FUEL}`,
      `Fuel_purchases:${FUEL}`,
      `fuel_purchases:${FUEL.slice(1)}`,
      `fuel_purchases:${FUEL} `,
      ` fuel_purchases:${FUEL}`,
      "fuel_purchases:0000000A-0000-4000-8000-00000000000B",
      `fuel_purchases:${FUEL}:x`,
      "",
    ]) {
      expect(parseSourceRef(near)).toBeNull();
    }
    expect(parseSourceRef(null)).toBeNull();
    expect(parseSourceRef(42)).toBeNull();
  });
});

describe("a named line's body and key", () => {
  it("takes whole cents above zero and refuses any other key", () => {
    const ok = { kind: "reimbursement", sourceRef: `fuel_purchases:${FUEL}`, amountCents: 6_100 };
    expect(NamedLineBody.safeParse(ok).success).toBe(true);
    expect(NamedLineBody.safeParse({ ...ok, amountCents: 61.5 }).success).toBe(false);
    expect(NamedLineBody.safeParse({ ...ok, amountCents: 0 }).success).toBe(false);
    expect(NamedLineBody.safeParse({ ...ok, kind: "fuel" }).success).toBe(false);
    expect(NamedLineBody.safeParse({ ...ok, enteredBy: PERSON }).success).toBe(false);
    expect(NamedLineBody.safeParse({ ...ok, label: "a\u0007b" }).success).toBe(false);
    expect(NamedLineBody.safeParse({ ...ok, label: "x".repeat(81) }).success).toBe(false);
  });

  it("is one key per paystub and record", () => {
    expect(namedItemRef(STUB, { table: "fuel_purchases", id: FUEL })).toBe(`named:${STUB}:fuel_purchases:${FUEL}`);
  });
});

describe("a named line in the fingerprint", () => {
  it("hashes exactly as the same engine line, so the person and record change no card", () => {
    const plain = { kind: "reimbursement", amountCents: 4_250, sources: [{ table: "pay_items" as const, id: ITEM }] };
    const typed = { ...plain, enteredBy: PERSON, sourceRef: `load_accessorials:${LUMPER}` };
    expect(linesHash([typed])).toBe(linesHash([plain]));
  });
});
