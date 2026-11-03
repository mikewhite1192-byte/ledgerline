import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { ConfigError } from "../rules-engine";

// What the pay week roll (D-090) answers when the carrier's pay rules do not read: no config at
// all is "no_pay_config", versions that do not line up are "week_shape", and neither opens a week.

const sortVersions = vi.hoisted(() => vi.fn());
vi.mock("../data/config-version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/config-version")>()),
  sortVersions,
}));
vi.mock("../data/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/read")>()),
  readTable: vi.fn(async () => []),
}));

const { rollPayWeek } = await import("./roll");

const saved = structuredClone(flags.payWeekRoll);
const execute = vi.fn();
const q = {
  query: vi.fn(async (sql: string) => (sql.includes("FROM tenants") ? [{ timezone: "America/New_York" }] : [])),
  execute,
} as unknown as Queryable;
const MONDAY_NOON = new Date("2026-11-02T18:00:00.000Z");

describe("rollPayWeek with pay rules that do not read", () => {
  afterEach(() => {
    flags.payWeekRoll = structuredClone(saved);
    vi.clearAllMocks();
  });

  it("answers no_pay_config when the carrier has no pay rules", async () => {
    flags.payWeekRoll = { enabled: true };
    sortVersions.mockImplementation(() => {
      throw new ConfigError("no_pay_config");
    });
    expect(await rollPayWeek(q, MONDAY_NOON)).toEqual({ opened: false, periodStart: null, reason: "no_pay_config" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["duplicate_effective_from", "week_start_changed"])("answers week_shape for %s, not no_pay_config", async (code) => {
    flags.payWeekRoll = { enabled: true };
    sortVersions.mockImplementation(() => {
      throw new ConfigError(code);
    });
    expect(await rollPayWeek(q, MONDAY_NOON)).toEqual({ opened: false, periodStart: null, reason: "week_shape" });
    expect(execute).not.toHaveBeenCalled();
  });
});
