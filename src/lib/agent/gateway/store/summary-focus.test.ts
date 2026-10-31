import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import type { FocusSubject } from "../focus";
import { buildStateSummary } from "./summary";

// The page focus in the agent's summary (design-ui-pass 2): the record the page is about becomes
// the Subject line, read from the database by the store, with its amount through money() so the
// answer may say it. With the switch off, or no focus, the summary is byte for byte what it was.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-27T15:00:00Z");
const CAP = 10_000;

const saved = { focus: flags.agentFocusEnabled, tms: flags.tmsSync.enabled };
// The dispatch feed line (summary-dispatch.test.ts) is off here, as in the replay's local mode.
beforeEach(() => {
  flags.tmsSync.enabled = false;
});
afterEach(() => {
  flags.agentFocusEnabled = saved.focus;
  flags.tmsSync.enabled = saved.tms;
});

// A carrier whose conversation names a customer as its stored subject. Records every query.
function fakeCarrier(seen: string[]): Queryable {
  return {
    async query<T>(sql: string): Promise<T[]> {
      seen.push(sql);
      if (sql.includes("FROM tenants")) {
        return [{ id: SESSION.tenantId, slug: "blue-ridge", name: "Blue Ridge Freight", timezone: "America/Chicago" }] as T[];
      }
      if (sql.includes("pay_configs")) return [] as T[];
      if (sql.includes("FROM conversations")) return [{ subject_table: "customers", subject_id: CUSTOMER }] as T[];
      if (sql.includes("FROM turns")) return [] as T[];
      if (sql.includes("FROM proposals p")) return [] as T[];
      if (sql.includes("FROM gateway_decisions")) return [] as T[];
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute() {
      throw new Error("the summary only reads");
    },
  };
}

const FOCUS: FocusSubject = {
  table: "settlements",
  id: SETTLEMENT,
  words: ["settlement for Sam Rivera (AG-1)", "week ending 2026-10-25", "status draft"],
  amount: { what: "net", cents: 123_456 },
};

async function summary(focus: FocusSubject | null | undefined, seen: string[] = []) {
  const q = fakeCarrier(seen);
  return focus === undefined
    ? buildStateSummary(q, SESSION, CONVERSATION, NOW, CAP, "Why is this short?", [])
    : buildStateSummary(q, SESSION, CONVERSATION, NOW, CAP, "Why is this short?", [], focus);
}

describe("the page focus in the state summary", () => {
  it("names the record as the Subject line, its net through money(), in place of the stored subject", async () => {
    flags.agentFocusEnabled = true;
    const seen: string[] = [];
    const out = await summary(FOCUS, seen);
    expect(out.text).toContain(
      `Subject:\nsettlements ${SETTLEMENT}, settlement for Sam Rivera (AG-1), week ending 2026-10-25, status draft, net $1,234.56`,
    );
    expect(out.text).not.toContain(`customers ${CUSTOMER}`);
    expect(out.cents).toContain(123_456);
    expect(seen.some((sql) => sql.includes("FROM conversations"))).toBe(false);
    // The person's text never enters the summary.
    expect(out.text).not.toContain("Why is this short?");
  });

  it("states no amount for a record that has none", async () => {
    flags.agentFocusEnabled = true;
    const driver: FocusSubject = { table: "drivers", id: SETTLEMENT, words: ["driver Sam Rivera (AG-1)"], amount: null };
    const out = await summary(driver);
    expect(out.text.endsWith(`Subject:\ndrivers ${SETTLEMENT}, driver Sam Rivera (AG-1)`)).toBe(true);
    expect(out.cents).toEqual([]);
  });

  it("ignores the focus with the switch off: the summary is the one with no focus, byte for byte", async () => {
    flags.agentFocusEnabled = false;
    const off = await summary(FOCUS);
    const none = await summary(undefined);
    expect(off).toEqual(none);
    expect(off.text).toContain(`Subject:\ncustomers ${CUSTOMER}`);
    expect(off.cents).not.toContain(123_456);
  });

  it("with no focus, is the summary it always was, the switch on or off", async () => {
    flags.agentFocusEnabled = false;
    const before = await summary(undefined);
    flags.agentFocusEnabled = true;
    expect(await summary(undefined)).toEqual(before);
    expect(await summary(null)).toEqual(before);
  });
});
