import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { AUTO_ALLOWED_KINDS } from "../money/never-alone";
import { MAX_RULE_CENTS, MAX_RULE_COUNT, RULE_KINDS, parseRuleSave } from "./rules-admin";

// The owner's rule save, parsed with no database: every bound, the never-alone refusal and the
// ceilings in flags.autopilot.kinds. RULE_KINDS is proven equal to the kind checks of 0070 and 0089.

const DIR = path.join(process.cwd(), "db/migrations");

// The kinds listed in the first "kind text ... CHECK (kind IN (...))" of a migration's table.
function kindCheckOf(file: string, table: string): string[] {
  const sql = readFileSync(path.join(DIR, file), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const at = sql.indexOf(`CREATE TABLE ${table} (`);
  expect(at, `${file} creates ${table}`).toBeGreaterThanOrEqual(0);
  const m = /\bkind\s+text\b[^,]*?CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i.exec(sql.slice(at));
  expect(m, `${file} checks ${table}.kind`).not.toBeNull();
  return [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

// A save that passes for a kind with no ceiling and no driver limit.
const PLAIN = { kind: "pay_correction", mode: "ask", maxCents: 100, dayMaxCents: 500, dayMaxCount: 3, expectedVersion: null };
// A driver kind's save inside its ceiling.
const DRIVER = {
  kind: "advance_payout",
  mode: "auto",
  maxCents: 10_000,
  dayMaxCents: 50_000,
  dayMaxCount: 5,
  driverDayMaxCents: 20_000,
  expectedVersion: 2,
};

const fieldOf = (body: unknown) => {
  const r = parseRuleSave(body);
  return r.ok ? "ok" : r.category === "bad_request" ? r.field : r.category;
};

describe("RULE_KINDS", () => {
  it("is exactly the kind check of autopilot_rules (0070) and of autopilot_changes (0089)", () => {
    expect([...RULE_KINDS].sort()).toEqual(kindCheckOf("0070_autopilot.sql", "autopilot_rules").sort());
    expect([...RULE_KINDS].sort()).toEqual(kindCheckOf("0089_autopilot_changes.sql", "autopilot_changes").sort());
    expect(new Set(RULE_KINDS).size).toBe(17);
  });
});

describe("parseRuleSave", () => {
  it("passes a whole save and returns exactly its values", () => {
    expect(parseRuleSave(PLAIN)).toEqual({ ok: true, value: { ...PLAIN, driverDayMaxCents: null } });
    expect(parseRuleSave(DRIVER)).toEqual({ ok: true, value: DRIVER });
    expect(parseRuleSave({ ...PLAIN, driverDayMaxCents: null })).toEqual({ ok: true, value: { ...PLAIN, driverDayMaxCents: null } });
  });

  it("refuses a body that is not an object, an unknown key and an unknown kind or mode", () => {
    for (const body of [null, undefined, "x", 3, [PLAIN]]) expect(fieldOf(body)).toBe("body");
    expect(fieldOf({ ...PLAIN, version: 1 })).toBe("body");
    expect(fieldOf({ ...PLAIN, tenantId: "t" })).toBe("body");
    for (const kind of ["load_move", "card_pullback", "Invoice_post", "", 1, undefined]) expect(fieldOf({ ...PLAIN, kind })).toBe("kind");
    for (const mode of ["Auto", "on", "", null, undefined]) expect(fieldOf({ ...PLAIN, mode })).toBe("mode");
  });

  it("holds every limit to whole cents or a whole count inside the columns' bounds", () => {
    for (const v of [-1, 1.5, MAX_RULE_CENTS + 1, "100", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fieldOf({ ...PLAIN, maxCents: v, dayMaxCents: MAX_RULE_CENTS })).toBe("maxCents");
      expect(fieldOf({ ...PLAIN, maxCents: 0, dayMaxCents: v })).toBe("dayMaxCents");
    }
    expect(fieldOf({ ...PLAIN, maxCents: MAX_RULE_CENTS, dayMaxCents: MAX_RULE_CENTS })).toBe("ok");
    expect(fieldOf({ ...PLAIN, maxCents: 0, dayMaxCents: 0, dayMaxCount: 0 })).toBe("ok");
    // The most each time is never above the most each day.
    expect(fieldOf({ ...PLAIN, maxCents: 501, dayMaxCents: 500 })).toBe("dayMaxCents");
    expect(fieldOf({ ...PLAIN, maxCents: 500, dayMaxCents: 500 })).toBe("ok");
    for (const v of [-1, 2.5, MAX_RULE_COUNT + 1, "3", null]) expect(fieldOf({ ...PLAIN, dayMaxCount: v })).toBe("dayMaxCount");
    expect(fieldOf({ ...PLAIN, dayMaxCount: MAX_RULE_COUNT })).toBe("ok");
  });

  it("needs a driver limit on the driver kinds, between the most each time and the most each day, and none elsewhere", () => {
    for (const kind of ["advance_payout", "money_code"]) {
      const base = { ...DRIVER, kind, mode: "ask", maxCents: 1_000, dayMaxCents: 5_000, dayMaxCount: 1, driverDayMaxCents: 2_000 };
      expect(fieldOf(base)).toBe("ok");
      const { driverDayMaxCents: _drop, ...without } = base;
      void _drop;
      expect(fieldOf(without)).toBe("driverDayMaxCents");
      expect(fieldOf({ ...base, driverDayMaxCents: null })).toBe("driverDayMaxCents");
      expect(fieldOf({ ...base, driverDayMaxCents: 999 })).toBe("driverDayMaxCents");
      expect(fieldOf({ ...base, driverDayMaxCents: 5_001 })).toBe("driverDayMaxCents");
      expect(fieldOf({ ...base, driverDayMaxCents: 1_000 })).toBe("ok");
      expect(fieldOf({ ...base, driverDayMaxCents: 5_000 })).toBe("ok");
    }
    expect(fieldOf({ ...PLAIN, driverDayMaxCents: 100 })).toBe("driverDayMaxCents");
    expect(fieldOf({ ...PLAIN, driverDayMaxCents: 0 })).toBe("driverDayMaxCents");
  });

  it("takes a null version for a first save, or a whole version from 1", () => {
    expect(fieldOf({ ...PLAIN, expectedVersion: 1 })).toBe("ok");
    for (const v of [0, -1, 1.5, "1", undefined]) expect(fieldOf({ ...PLAIN, expectedVersion: v })).toBe("expectedVersion");
  });

  it("refuses Auto on every kind a named person always approves, and passes Off and Ask me there", () => {
    const allowed = new Set<string>(AUTO_ALLOWED_KINDS);
    const never = RULE_KINDS.filter((k) => !allowed.has(k));
    expect(never).toContain("settlement_approve");
    expect(never.length).toBe(12);
    for (const kind of never) {
      expect(parseRuleSave({ ...PLAIN, kind, mode: "auto" }), kind).toEqual({ ok: false, category: "never_alone" });
      expect(fieldOf({ ...PLAIN, kind, mode: "ask" }), kind).toBe("ok");
      expect(fieldOf({ ...PLAIN, kind, mode: "off" }), kind).toBe("ok");
    }
  });

  it("refuses a limit one above a listed kind's ceiling and passes one at the ceiling", () => {
    const kinds = flags.autopilot.kinds;
    for (const kind of AUTO_ALLOWED_KINDS) {
      const c = kinds[kind];
      expect(c, kind).toBeDefined();
      const driver = c!.driverDayMaxCents;
      const at = {
        kind,
        mode: "auto",
        maxCents: c!.maxCents,
        dayMaxCents: c!.dayMaxCents,
        dayMaxCount: c!.dayMaxCount,
        expectedVersion: null,
        ...(driver === undefined ? {} : { driverDayMaxCents: driver }),
      };
      expect(fieldOf(at), kind).toBe("ok");
      const over = (patch: Record<string, number>) => parseRuleSave({ ...at, ...patch });
      const refused = { ok: false, category: "over_ceiling", ceiling: { ...c } };
      // Each limit alone, one cent or one count over (the driver limit stays inside the day).
      expect(over({ maxCents: c!.maxCents + 1, ...(driver === undefined ? {} : { driverDayMaxCents: Math.max(driver, c!.maxCents + 1) }) }), kind).toEqual(refused);
      expect(over({ dayMaxCents: c!.dayMaxCents + 1 }), kind).toEqual(refused);
      expect(over({ dayMaxCount: c!.dayMaxCount + 1 }), kind).toEqual(refused);
      if (driver !== undefined && driver < c!.dayMaxCents) {
        expect(over({ driverDayMaxCents: driver + 1 }), kind).toEqual(refused);
      }
      // The same ceiling holds in Ask me and Off.
      expect(parseRuleSave({ ...at, mode: "ask", dayMaxCount: c!.dayMaxCount + 1 }), kind).toEqual(refused);
    }
  });

  it("holds a kind with no ceiling only to the columns' bounds", () => {
    expect(Object.hasOwn(flags.autopilot.kinds, "pay_correction")).toBe(false);
    expect(fieldOf({ ...PLAIN, maxCents: MAX_RULE_CENTS, dayMaxCents: MAX_RULE_CENTS, dayMaxCount: MAX_RULE_COUNT })).toBe("ok");
  });
});
