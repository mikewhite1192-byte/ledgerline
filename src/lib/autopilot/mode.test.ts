import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { autopilotModeFor } from "./mode";
import type { RuleFacts } from "./policy";
import type { PauseRow } from "./read";

// What the autopilot would do with a new proposal of one kind: ask unless it is on, armed, past
// its start date, not paused, and the owner's rule for an approvable kind says Auto; off when the
// owner turned the kind off. The reads are faked; a failed read throws to the caller.

const reads = vi.hoisted(() => ({ readRule: vi.fn(), readPause: vi.fn(), readZone: vi.fn() }));
vi.mock("./read", () => reads);

const q = {} as Queryable;
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const rule = (mode: string): RuleFacts => ({
  id: "77777777-7777-4777-8777-777777777777",
  kind: "invoice_post",
  mode,
  maxCents: 150_000,
  dayMaxCents: 500_000,
  dayMaxCount: 3,
  version: 1,
});
const saved = structuredClone(flags.autopilot);

beforeEach(() => {
  Object.assign(flags.autopilot, { enabled: true, armed: true, startDate: "2026-10-31" });
  reads.readRule.mockResolvedValue(rule("auto"));
  reads.readPause.mockResolvedValue(null);
  reads.readZone.mockResolvedValue("America/Chicago");
});

afterEach(() => {
  Object.assign(flags.autopilot, structuredClone(saved));
  vi.clearAllMocks();
});

describe("autopilotModeFor", () => {
  it("is auto for an approvable kind the owner set to Auto", async () => {
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("auto");
    expect(reads.readRule).toHaveBeenCalledWith(q, "invoice_post", false);
  });

  it("is ask while the autopilot is off or unarmed, before reading anything", async () => {
    flags.autopilot.armed = false;
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("ask");
    flags.autopilot.armed = true;
    flags.autopilot.enabled = false;
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("ask");
    expect(reads.readRule).not.toHaveBeenCalled();
  });

  it("is ask with no rule, a pause, before the start date, or a kind it may never approve", async () => {
    reads.readRule.mockResolvedValueOnce(null);
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("ask");
    const paused: PauseRow = { pausedAtMs: NOW - 1_000, pausedUntilMs: null, pausedBy: "owner" };
    reads.readPause.mockResolvedValueOnce(paused);
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("ask");
    flags.autopilot.startDate = "2026-11-03";
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("ask");
    flags.autopilot.startDate = "2026-10-31";
    expect(await autopilotModeFor(q, "advance_payout", NOW)).toBe("ask");
    reads.readRule.mockResolvedValueOnce(rule("ask"));
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("ask");
  });

  it("reads the start date in the carrier's zone", async () => {
    // 2026-11-03T03:00Z is still Nov 2 in Chicago.
    flags.autopilot.startDate = "2026-11-03";
    expect(await autopilotModeFor(q, "invoice_post", Date.UTC(2026, 10, 3, 3, 0, 0))).toBe("ask");
    expect(await autopilotModeFor(q, "invoice_post", Date.UTC(2026, 10, 3, 7, 0, 0))).toBe("auto");
  });

  it("is off when the owner turned the kind off", async () => {
    reads.readRule.mockResolvedValueOnce(rule("off"));
    expect(await autopilotModeFor(q, "invoice_post", NOW)).toBe("off");
  });

  it("throws when a read fails", async () => {
    reads.readPause.mockRejectedValueOnce(new Error("db down"));
    await expect(autopilotModeFor(q, "invoice_post", NOW)).rejects.toThrow("db down");
  });
});
