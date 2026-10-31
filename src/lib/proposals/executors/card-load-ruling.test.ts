import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { autopilotSub } from "../../autopilot/session";
import type { Queryable, TenantDb } from "../../db";
import { serviceSub } from "../../sweep/service-session";
import type { ProposalRow } from "../execute";
import { RULINGS, cardLoadRulingExecutor, deficitNote, precheckCardLoadRuling, rulingOf } from "./card-load-ruling";

// The card load ruling's pure parts and its walls before any read: the ruling an approval carries,
// the deficit's note, the switch and the machine logins. The database half is
// src/lib/card-loads/card-load-ruling.db.test.ts.

const TENANT = "00000000-0000-4000-8000-000000000001";
const ROW = "00000000-0000-4000-8000-0000000000aa";

const saved = structuredClone(flags.cardLoadRuling);
beforeEach(() => {
  flags.cardLoadRuling = { ...saved, enabled: true };
});
afterEach(() => {
  flags.cardLoadRuling = structuredClone(saved);
});

// Any read or write fails the test: these walls stand before the database.
const noQ: Queryable = new Proxy({} as Queryable, {
  get: () => () => {
    throw new Error("the database was reached");
  },
});
const noDb: TenantDb = new Proxy({} as TenantDb, {
  get: () => () => {
    throw new Error("the database was reached");
  },
});

const proposal = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: "00000000-0000-4000-8000-0000000000bb",
  conversationId: null,
  turnId: null,
  kind: "card_load_ruling",
  subjectTable: "card_transactions",
  subjectId: ROW,
  amountCents: 40_000,
  direction: "none",
  args: { transactionId: ROW, amountCents: 40_000, ruling: "deficit" },
  status: "proposed",
  flaggedInputId: null,
  auditorVerdict: "pass",
  auditorAgrees: true,
  moneyActionId: null,
  traceId: null,
  ...over,
});

const person = { sub: "person-1", email: "", tenantId: TENANT };

describe("rulingOf", () => {
  const args = { ruling: "deficit" };

  it("takes the drafted ruling with no edits or empty ones", () => {
    expect(rulingOf(args, null)).toBe("deficit");
    expect(rulingOf(args, {})).toBe("deficit");
  });

  it("takes either ruling from the one key a ruling edit may carry", () => {
    expect(rulingOf(args, { ruling: "owes_nothing" })).toBe("owes_nothing");
    expect(rulingOf(args, { ruling: "deficit" })).toBe("deficit");
    expect([...RULINGS]).toEqual(["owes_nothing", "deficit"]);
  });

  it("refuses any other key, value or extra key, compared whole", () => {
    expect(rulingOf(args, { ruling: "owes" })).toBeNull();
    expect(rulingOf(args, { ruling: "owes_nothing " })).toBeNull();
    expect(rulingOf(args, { ruling: "OWES_NOTHING" })).toBeNull();
    expect(rulingOf(args, { amountCents: "1" })).toBeNull();
    expect(rulingOf(args, { ruling: "owes_nothing", amountCents: "1" })).toBeNull();
  });

  it("refuses drafted args with no ruling or a bad one", () => {
    expect(rulingOf({}, null)).toBeNull();
    expect(rulingOf({ ruling: "maybe" }, null)).toBeNull();
    expect(rulingOf(null, null)).toBeNull();
    expect(rulingOf(["deficit"], null)).toBeNull();
    expect(rulingOf({}, { ruling: "owes_nothing" })).toBeNull();
  });
});

describe("deficitNote", () => {
  it("names the amount, the card's last four and the posting day, within the column's 200", () => {
    const note = deficitNote({ amountCents: 40_000, cardLast4: "4417", postedOn: "2026-10-30" });
    expect(note).toBe("Card load $400.00 on card ending 4417, posted 2026-10-30, no payment record.");
    const big = deficitNote({ amountCents: 999_999_999, cardLast4: "0000", postedOn: "2026-12-31" });
    expect(big.length).toBeLessThanOrEqual(200);
  });
});

describe("the walls before any read", () => {
  it("refuses with the switch off, in the precheck and the executor, before the database", async () => {
    flags.cardLoadRuling = { ...saved, enabled: false };
    expect(await precheckCardLoadRuling(noQ, proposal(), new Date(), { session: person, opts: { confirmed: false } })).toEqual({
      ok: false,
      category: "not_executable",
      retryable: false,
    });
    expect(await cardLoadRulingExecutor(noDb, person, proposal(), { confirmed: false }, {})).toMatchObject({
      ok: false,
      category: "not_executable",
    });
  });

  it("refuses another kind, and a precheck with no person", async () => {
    expect(await precheckCardLoadRuling(noQ, proposal({ kind: "card_match" }), new Date(), { session: person, opts: { confirmed: false } })).toMatchObject({ category: "not_executable" });
    expect(await precheckCardLoadRuling(noQ, proposal(), new Date())).toMatchObject({ category: "not_executable" });
  });

  it("refuses the autopilot's and the sweep's login: a named person rules", async () => {
    for (const sub of [autopilotSub(TENANT), serviceSub(TENANT)]) {
      const session = { sub, email: "", tenantId: TENANT };
      expect(await precheckCardLoadRuling(noQ, proposal(), new Date(), { session, opts: { confirmed: true } }), sub).toMatchObject({
        category: "kind_never_alone",
      });
      expect(await cardLoadRulingExecutor(noDb, session, proposal(), { confirmed: true }, {}), sub).toMatchObject({
        category: "kind_never_alone",
      });
    }
  });

  it("refuses a changed ruling without the second confirm, in the executor before the database", async () => {
    expect(
      await cardLoadRulingExecutor(noDb, person, proposal(), { confirmed: false, edits: { ruling: "owes_nothing" } }, {}),
    ).toMatchObject({ category: "needs_confirm" });
  });
});
