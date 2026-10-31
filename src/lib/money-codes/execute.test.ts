import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import type { ProposalRow } from "../proposals/execute";
import { precheckMoneyCode, uniqueViolationCategory } from "./execute";

// The engine's answer for the precheck below: allowed, at an amount the test sets.
const engine = vi.hoisted(() => ({ amountCents: 0 }));
vi.mock("../data/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/read")>()),
  readMoneyCodeInput: async () => ({}),
}));
vi.mock("../rules-engine/money-codes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rules-engine/money-codes")>()),
  checkMoneyCode: () => ({ ok: true, amountCents: engine.amountCents, purpose: "repair", reasons: [] }),
}));

// Which outcome a unique violation (23505) on the approval's code write becomes. Only the two
// live-evidence indexes, named whole, say the evidence is reused; everything else, a missing name
// included, stays a code collision.

describe("a unique violation on the money code write", () => {
  it("says the evidence is reused for the live document and voice note indexes", () => {
    expect(uniqueViolationCategory("money_codes_one_live_per_document")).toBe("evidence_reused");
    expect(uniqueViolationCategory("money_codes_one_live_per_voice_note")).toBe("evidence_reused");
  });

  it("keeps any other index, a near name and a missing name a code collision", () => {
    expect(uniqueViolationCategory("money_codes_one_per_proposal")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("money_codes_pkey")).toBe("code_ref_collision");
    // Whole names only: longer, shorter or differently cased is another constraint.
    expect(uniqueViolationCategory("money_codes_one_live_per_document_old")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("one_live_per_voice_note")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("MONEY_CODES_ONE_LIVE_PER_DOCUMENT")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("")).toBe("code_ref_collision");
    // No constraint name read from the driver: fail closed.
    expect(uniqueViolationCategory(undefined)).toBe("code_ref_collision");
  });
});

// The autopilot's early refusal when the engine no longer allows exactly the proposal's amount:
// the numbers changed (the advance precheck's word), never a bad amount. A person's approval is
// left to the executor, which asks again after the approval.
describe("the money code precheck for the autopilot", () => {
  const saved = structuredClone(flags.moneyCodes);
  const savedPayouts = flags.payoutsEnabled;
  afterEach(() => {
    flags.moneyCodes = structuredClone(saved);
    flags.payoutsEnabled = savedPayouts;
  });

  const LOAD = "11111111-1111-4111-8111-111111111111";
  const DRIVER = "22222222-2222-4222-8222-222222222222";
  const p: ProposalRow = {
    id: "33333333-3333-4333-8333-333333333333",
    conversationId: null,
    turnId: null,
    kind: "money_code",
    subjectTable: "loads",
    subjectId: LOAD,
    amountCents: 12_000,
    direction: "out",
    args: { loadId: LOAD, driverId: DRIVER, amountCents: 12_000, purpose: "repair", source: "form" },
    status: "proposed",
    flaggedInputId: null,
    auditorVerdict: "pass",
    auditorAgrees: true,
    moneyActionId: null,
    traceId: null,
  };
  // The tenant's zone, an armed driver and no code yet on this proposal.
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM tenants")) return [{ timezone: "America/Chicago" }] as T[];
      if (sql.includes("FROM drivers")) return [{ money_armed: true }] as T[];
      return [];
    },
    execute: async () => 0,
  };
  const now = new Date(Date.UTC(2026, 10, 2, 16, 0, 0));
  const autopilot = { session: { sub: "s", email: "e", tenantId: "t" }, opts: { confirmed: false, autopilot: { ruleId: "r", version: 1 } } };
  const person = { session: autopilot.session, opts: { confirmed: false } };

  it("refuses an amount the engine no longer allows to the cent as stale, and lets the same amount through", async () => {
    flags.moneyCodes = { ...saved, enabled: true, armed: true, capCents: 50_000, startDate: "2026-10-28" };
    flags.payoutsEnabled = true;
    engine.amountCents = 11_000;
    expect(await precheckMoneyCode(q, p, now, autopilot)).toEqual({ ok: false, category: "stale_eligibility", retryable: false });
    // A person's press is not refused here for it.
    expect(await precheckMoneyCode(q, p, now, person)).toBeNull();
    engine.amountCents = 12_000;
    expect(await precheckMoneyCode(q, p, now, autopilot)).toBeNull();
  });
});
