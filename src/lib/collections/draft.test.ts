import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { draftCollections, REMINDER_FORMAT, REMINDER_PURPOSE, REMINDER_RULES, REMINDER_TIMEOUT_MS, reminderRequest } from "./draft";
import { buildReminderPack, type ReminderFigures } from "./pack";
import { BANNED } from "./verify";

// The drafting request and the switches drafting re-checks itself. The run itself (reserve first,
// the run cap, the unique key, refusals) is proven on a real database in collections.db.test.ts.

const SESSION: Session = { sub: "sub-1", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
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
const TRACE = "33333333-3333-4333-8333-333333333333";

// A database and a model that fail the test if anything reaches them.
const untouchedDb = (): TenantDb => ({
  withTenant: vi.fn(async () => {
    throw new Error("the database was read");
  }),
});

const saved = { collections: flags.collectionsEnabled, ai: flags.aiEnabled };
beforeEach(() => {
  flags.collectionsEnabled = true;
  flags.aiEnabled = true;
});
afterEach(() => {
  flags.collectionsEnabled = saved.collections;
  flags.aiEnabled = saved.ai;
});

describe("reminderRequest", () => {
  it("asks for one strict subject and body under the reminder's own caps, on the run's trace", () => {
    const request = reminderRequest(PACK, TRACE);
    expect(request).toMatchObject({
      purpose: REMINDER_PURPOSE,
      reasoningEffort: "minimal",
      maxOutputTokens: flags.collectionsLimits.maxOutputTokens,
      maxCostCents: flags.collectionsLimits.maxDraftCents,
      timeoutMs: REMINDER_TIMEOUT_MS,
      traceId: TRACE,
      format: REMINDER_FORMAT,
    });
    expect(REMINDER_PURPOSE).toBe("collections_draft");
    expect(REMINDER_FORMAT.strict).toBe(true);
    expect(REMINDER_FORMAT.schema).toMatchObject({ additionalProperties: false, required: ["subject", "body"] });
    expect(flags.collectionsLimits.maxDraftCents).toBeLessThanOrEqual(2);
    expect(flags.collectionsLimits.maxOutputTokens).toBeLessThanOrEqual(500);
  });

  it("sends the rules as the system message and only the pack's facts as the user message", () => {
    const [system, user] = reminderRequest(PACK, TRACE).messages;
    expect(system).toEqual({ role: "system", content: REMINDER_RULES });
    expect(user.role).toBe("user");
    const text = String(user.content);
    expect(text).toContain("Balance due: $2,225.00");
    expect(text).toContain("Invoice number: BRF-INV-10012");
    // No record id, no address, no trace.
    expect(text).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    // The rules name the banned topics to avoid them; the facts never carry one.
    expect(BANNED.test(text)).toBe(false);
  });
});

describe("draftCollections switches", () => {
  it("collections off: refuses before any read or model call", async () => {
    flags.collectionsEnabled = false;
    const db = untouchedDb();
    const complete = vi.fn();
    const log = vi.fn();
    expect(await draftCollections(SESSION, new Date("2026-10-27T16:00:20Z"), { db, complete, log })).toEqual({
      ok: false,
      category: "disabled",
    });
    expect(db.withTenant).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("models off: refuses before any read or model call", async () => {
    flags.aiEnabled = false;
    const db = untouchedDb();
    const complete = vi.fn();
    expect(await draftCollections(SESSION, new Date("2026-10-27T16:00:20Z"), { db, complete })).toEqual({
      ok: false,
      category: "ai_disabled",
    });
    expect(db.withTenant).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
