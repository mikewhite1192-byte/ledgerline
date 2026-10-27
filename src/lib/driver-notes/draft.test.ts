import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { TenantDb } from "../db";
import { draftDriverNotes, NOTE_FORMAT, NOTE_PURPOSE, noteRequest } from "./draft";
import { buildPack, type PackInput } from "./pack";

const saved = { ...flags, driverNoteLimits: { ...flags.driverNoteLimits } };
afterEach(() => {
  Object.assign(flags, saved, { driverNoteLimits: { ...saved.driverNoteLimits } });
});

const SETTLEMENT_ID = "00000000-0000-4000-8000-0000000000aa";
const TRACE = "00000000-0000-4000-8000-0000000000bb";
const INPUT: PackInput = {
  settlement: { id: SETTLEMENT_ID, gross_cents: 100000, deductions_cents: 0, net_cents: 100000, carry_forward_cents: 0 },
  period: { period_start: "2026-10-26", period_end: "2026-11-01" },
  driver: { first_name: "Sam", worker_type: "owner_operator", preferred_language: "en" },
  lines: [{ seq: 1, kind: "load_pay", label: "Load L-7", amount_cents: 100000, sources: [], meta: null }],
  previousNetCents: null,
};

// A database that fails the test if anything reaches it.
const noDb: TenantDb = {
  withTenant: () => {
    throw new Error("the database was reached");
  },
} as unknown as TenantDb;
const SESSION = { sub: "sub-1", email: "", tenantId: "00000000-0000-4000-8000-0000000000cc" };

describe("noteRequest", () => {
  it("asks for the strict note format under the note's own caps, with the pack and no ids", () => {
    const request = noteRequest(buildPack(INPUT), TRACE);
    expect(request.purpose).toBe(NOTE_PURPOSE);
    expect(request.traceId).toBe(TRACE);
    expect(request.maxOutputTokens).toBe(flags.driverNoteLimits.maxOutputTokens);
    expect(request.maxCostCents).toBe(flags.driverNoteLimits.maxNoteCents);
    expect(request.reasoningEffort).toBe("minimal");
    expect(request.format).toBe(NOTE_FORMAT);
    expect(NOTE_FORMAT.strict).toBe(true);
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("Language: English");
    expect(user).toContain("Driver first name: Sam");
    expect(user).toContain("Net pay: $1,000.00");
    expect(JSON.stringify(request)).not.toContain(SETTLEMENT_ID);
  });
});

describe("draftDriverNotes", () => {
  it("does nothing while notes or the models are switched off", async () => {
    const complete = () => {
      throw new Error("the model was called");
    };
    flags.driverNotesEnabled = false;
    flags.aiEnabled = true;
    expect(await draftDriverNotes(SESSION, TRACE, new Date(0), { db: noDb, complete })).toEqual({
      ok: false,
      category: "disabled",
    });
    flags.driverNotesEnabled = true;
    flags.aiEnabled = false;
    expect(await draftDriverNotes(SESSION, TRACE, new Date(0), { db: noDb, complete })).toEqual({
      ok: false,
      category: "ai_disabled",
    });
  });
});
