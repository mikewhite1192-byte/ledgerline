import { describe, expect, it } from "vitest";
import { DbError } from "@/lib/db";
import { cursorParam, feedRowOf, parseCursor, type FeedRow } from "./read";
import { ACTOR_LABELS, feedLine, feedLines } from "./words";

// The feed's words from fixed rows, in a fixed zone: every event reads as one plain line, a person
// reads as a role word, and nothing a row is not meant to carry (a login id, an email, a note, an
// outside id, error text) can reach a line.

const ZONE = "America/Chicago";
const AT = "2026-11-10T15:00:00.000000Z";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

function row(over: Partial<FeedRow>): FeedRow {
  return {
    key: `proposal:${ID}:proposed`,
    at: AT,
    event: "proposal_proposed",
    actor: "agent",
    cents: null,
    direction: null,
    title: null,
    kind: null,
    code: null,
    reason: null,
    count: null,
    limitCents: null,
    dayLimitCents: null,
    until: null,
    channel: null,
    system: null,
    once: false,
    record: null,
    ...over,
  };
}

const say = (over: Partial<FeedRow>) => feedLine(row(over), ZONE)?.words ?? null;

// A stored row as the SQL returns it: every column text or null.
function raw(over: Record<string, unknown>): Record<string, unknown> {
  return {
    at: AT,
    key: `money:${ID}:sent`,
    event: "money_sent",
    actor: "admin",
    cents: "12500",
    direction: null,
    title: null,
    kind: "advance_payout",
    code: "sent",
    reason: null,
    n: null,
    limit_cents: null,
    day_cents: null,
    until_at: null,
    channel: "payment",
    system: "fuel_card_sim",
    once: null,
    record_table: "advances",
    record_id: ID,
    ...over,
  };
}

describe("feedLine", () => {
  it("names who did a step by role, never by login or email", () => {
    expect(ACTOR_LABELS).toEqual({
      admin: "Admin",
      staff: "Staff",
      judge: "Demo visitor",
      autopilot: "Autopilot",
      agent: "Agent",
      desk: "Desk",
      someone: "Someone",
    });
    const decided = { event: "proposal_decided", code: "rejected", title: "Advance for Driver 7" } as const;
    expect(say({ ...decided, actor: "admin" })).toBe("Admin rejected Advance for Driver 7");
    expect(say({ ...decided, actor: "staff" })).toBe("Staff rejected Advance for Driver 7");
    expect(say({ ...decided, actor: "judge" })).toBe("Demo visitor rejected Advance for Driver 7");
    expect(say({ ...decided, actor: "someone" })).toBe("Someone rejected Advance for Driver 7");
  });

  it("reads a proposal as drafted, audited and decided", () => {
    const p = { title: "Advance for Driver 7", cents: 12500, direction: "out", kind: "advance_payout" } as const;
    expect(say({ ...p })).toBe("Agent proposed Advance for Driver 7, $125.00 out");
    expect(say({ ...p, direction: "in" })).toBe("Agent proposed Advance for Driver 7, $125.00 in");
    expect(say({ ...p, direction: "none", cents: 0 })).toBe("Agent proposed Advance for Driver 7");
    expect(say({ ...p, direction: "none", cents: 500 })).toBe("Agent proposed Advance for Driver 7");
    expect(feedLine(row({ ...p, code: "ask", reason: "over_item_limit" }), ZONE)?.tag).toBe(
      "Autopilot: asks a person (over its limit each time)",
    );
    expect(feedLine(row({ ...p, code: "off", reason: "mode_off" }), ZONE)?.tag).toBe("Autopilot: off for this kind");
    expect(feedLine(row({ ...p }), ZONE)?.tag).toBeNull();
    expect(say({ ...p, title: null })).toBe("Agent proposed a proposal, $125.00 out");

    const audit = { ...p, event: "proposal_audited" } as const;
    expect(say({ ...audit, code: "pass" })).toBe("Audit passed: Advance for Driver 7");
    expect(say({ ...audit, code: "concerns" })).toBe("Audit raised concerns: Advance for Driver 7");
    expect(say({ ...audit, code: "block" })).toBe("Audit blocked: Advance for Driver 7");
    expect(say({ ...audit, code: "unknown" })).toBe("Audit could not finish: Advance for Driver 7");

    const decided = { ...p, event: "proposal_decided", code: "approved" } as const;
    expect(say({ ...decided, actor: "admin" })).toBe("Admin approved Advance for Driver 7, $125.00");
    expect(say({ ...decided, actor: "autopilot", limitCents: 50000 })).toBe(
      "Autopilot approved Advance for Driver 7, $125.00, within its limit of $500.00",
    );
    expect(say({ ...decided, actor: "autopilot" })).toBe("Autopilot approved Advance for Driver 7, $125.00");
    expect(say({ ...decided, actor: "staff", direction: "none" })).toBe("Staff approved Advance for Driver 7");
  });

  it("reads a money step sent, unknown, confirmed and failed, and one sent and confirmed at once", () => {
    const m = { kind: "advance_payout", cents: 12500, channel: "payment", system: "fuel_card_sim", actor: "admin" } as const;
    expect(say({ ...m, event: "money_sent", code: "sent" })).toBe("Fuel card load sent, $125.00");
    expect(feedLine(row({ ...m, event: "money_sent", code: "sent" }), ZONE)?.tag).toBe("Test mode");
    expect(say({ ...m, event: "money_sent", code: "unknown" })).toBe(
      "Not confirmed yet: Fuel card load, $125.00; the desk will read it back",
    );
    expect(say({ ...m, event: "money_settled", code: "confirmed" })).toBe("Confirmed: Fuel card load, $125.00");
    expect(say({ ...m, event: "money_settled", code: "confirmed", once: true })).toBe("Paid and confirmed: Fuel card load, $125.00");
    expect(say({ ...m, event: "money_settled", code: "failed", reason: "declined" })).toBe("Failed: Fuel card load, $125.00 (declined)");
    expect(say({ ...m, system: "stripe_test", event: "money_sent", code: "sent" })).toBe("Bank transfer sent, $125.00");

    const qbo = { kind: "invoice", cents: 90000, channel: "accounting", system: "qbo_sandbox" } as const;
    expect(say({ ...qbo, event: "money_sent", code: "sent" })).toBe("Invoice posted to the QuickBooks sandbox, $900.00");
    expect(say({ ...qbo, event: "money_settled", code: "confirmed", once: true })).toBe(
      "Posted and confirmed in the QuickBooks sandbox: Invoice, $900.00",
    );
    expect(feedLine(row({ ...qbo, event: "money_sent", code: "sent" }), ZONE)?.tag).toBe("QuickBooks sandbox");

    expect(say({ kind: "card_pullback", cents: 4000, channel: "payment", system: "fuel_card_sim", event: "money_settled", code: "confirmed" })).toBe(
      "Confirmed: Card pull-back, $40.00",
    );
  });

  it("reads the desk's steps, a held autopilot step, and drops a wake that finished nothing", () => {
    const d = { actor: "desk", key: `desk:${ID}` } as const;
    expect(say({ ...d, event: "desk_claimed", kind: "card_transaction" })).toBe("Desk picked up a card transaction");
    expect(say({ ...d, event: "desk_done", kind: "inbound_message", code: "drafted" })).toBe("Desk finished a message: drafted");
    expect(say({ ...d, event: "desk_failed", kind: "audit", code: "threw" })).toBe("Desk could not finish an audit: threw");
    expect(say({ ...d, event: "desk_skipped", kind: "sweep", code: "switched_off" })).toBe("Desk skipped a pay sweep: switched off");
    expect(say({ ...d, event: "desk_skipped", kind: "autopilot", code: "paused" })).toBe("Autopilot held an autopilot step: paused");
    expect(say({ ...d, event: "desk_skipped", kind: "autopilot", code: "before_start" })).toBe("Autopilot held an autopilot step: before start");
    expect(say({ ...d, event: "desk_skipped", kind: "autopilot", code: "no_rule" })).toBe("Autopilot held an autopilot step: no rule");
    expect(say({ ...d, event: "desk_done", kind: "brand_new_source" })).toBe("Desk finished a brand new source");
    expect(say({ ...d, event: "desk_sleep", count: 3 })).toBe("Desk checked in: 3 things done");
    expect(say({ ...d, event: "desk_sleep", count: 1 })).toBe("Desk checked in: 1 thing done");
    expect(feedLine(row({ ...d, event: "desk_sleep", count: 0 }), ZONE)).toBeNull();
    expect(feedLine(row({ ...d, event: "desk_sleep", count: null }), ZONE)).toBeNull();
    expect(feedLines([row({ ...d, event: "desk_sleep", count: 0 }), row({ ...d, event: "desk_claimed" })], ZONE)).toHaveLength(1);
  });

  it("reads the owner's autopilot changes and an approval over a set", () => {
    const c = { actor: "admin", key: `autopilot:${ID}` } as const;
    expect(say({ ...c, event: "autopilot_pause" })).toBe("Admin paused the autopilot");
    expect(say({ ...c, event: "autopilot_pause", until: "2026-11-10T18:00:00Z" })).toBe(
      "Admin paused the autopilot until Nov 10, 2026, 12:00 PM CST",
    );
    expect(say({ ...c, event: "autopilot_resume", actor: "staff" })).toBe("Staff resumed the autopilot");
    expect(say({ ...c, event: "autopilot_rule", kind: "advance_payout", code: "auto", limitCents: 20000, dayLimitCents: 100000 })).toBe(
      "Admin set Advance payout to Auto, up to $200.00 each, $1,000.00 a day",
    );
    expect(say({ ...c, event: "autopilot_rule", kind: "advance_payout", code: "off", limitCents: 20000 })).toBe(
      "Admin set Advance payout to Off",
    );
    expect(say({ ...c, event: "autopilot_rule", kind: "invoice_post", code: "ask" })).toBe("Admin set Invoice post to Ask me");

    const b = { actor: "admin", key: `batch:${ID}:started` } as const;
    expect(say({ ...b, event: "batch_started", kind: "settlements", count: 4, cents: 812345 })).toBe("Admin approved 4 paystubs, $8,123.45");
    expect(say({ ...b, event: "batch_started", kind: "proposals", count: 1, cents: 5000 })).toBe("Admin approved 1 card, $50.00");
    expect(say({ ...b, event: "batch_finished", kind: "settlements", count: 4, code: "done" })).toBe("Batch of 4 paystubs done");
    expect(say({ ...b, event: "batch_finished", kind: "settlements", count: 4, code: "partial" })).toBe("Batch of 4 paystubs partly done");
    expect(say({ ...b, event: "batch_finished", kind: "proposals", count: 2, code: "refused" })).toBe("Batch of 2 cards refused");
  });

  it("shows the time in the carrier's zone and links a record only when it has a page", () => {
    const line = feedLine(row({ title: "Advance", record: { table: "advances", id: ID } }), ZONE);
    expect(line?.time).toBe("Nov 10, 2026, 9:00 AM CST");
    expect(line?.href).toBe(`/records/advances/${ID}`);
    expect(feedLine(row({ record: { table: "card_pullbacks", id: ID } }), ZONE)?.href).toBeNull();
    expect(feedLine(row({}), ZONE)?.href).toBeNull();
  });
});

describe("feedRowOf", () => {
  it("keeps only the fixed fields, so a login id, email, note, outside id or error text never reaches a line", () => {
    const secrets = {
      cognito_sub: "user-sub-1234",
      changed_by: "service:autopilot:abc",
      decided_by: "person-sub-5678",
      email: "owner@example.test",
      decision_note: "private note about the driver",
      outside_id: "ch_test_9988",
      idempotency_key: "idem-4455",
      error: "upstream said: card 4242 declined",
      detail: { runId: "run-1", raw: "raw text" },
    };
    const r = feedRowOf(raw(secrets));
    expect(Object.keys(r).sort()).toEqual(
      [
        "key",
        "at",
        "event",
        "actor",
        "cents",
        "direction",
        "title",
        "kind",
        "code",
        "reason",
        "count",
        "limitCents",
        "dayLimitCents",
        "until",
        "channel",
        "system",
        "once",
        "record",
      ].sort(),
    );
    const line = feedLine(r, ZONE);
    const text = JSON.stringify(line);
    for (const value of ["user-sub", "service:", "person-sub", "@", "private note", "ch_test", "idem-", "upstream", "4242", "run-1", "raw text"]) {
      expect(text, value).not.toContain(value);
    }
    expect(line?.words).toBe("Fuel card load sent, $125.00");
    expect(line?.actor).toBe("Admin");
  });

  it("drops a code word that is not one, and fails a row whose time, key, event, actor or amount does not read", () => {
    expect(feedRowOf(raw({ reason: "Upstream said no" })).reason).toBeNull();
    expect(feedRowOf(raw({ record_table: "advances", record_id: "not-a-uuid" })).record).toBeNull();
    expect(feedRowOf(raw({ once: "yes" })).once).toBe(true);
    expect(feedRowOf(raw({ until_at: "2026-11-10T18:00:00" })).until).toBeNull();
    expect(feedRowOf(raw({ until_at: "2026-11-10T18:00:00.000Z" })).until).toBe("2026-11-10T18:00:00.000Z");
    expect(say({ actor: "admin", key: `autopilot:${ID}`, event: "autopilot_pause", until: "2026-11-10T18:00:00" })).toBe(
      "Admin paused the autopilot",
    );
    for (const bad of [
      { at: "2026-11-10T15:00:00Z" },
      { key: "money:nope" },
      { event: "money_moved" },
      { actor: "owner@example.test" },
      { cents: "12.50" },
      { cents: "-5" },
      { n: "99999999999999999" },
    ]) {
      expect(() => feedRowOf(raw(bad)), JSON.stringify(bad)).toThrow(DbError);
    }
  });
});

describe("parseCursor", () => {
  it("reads back the cursor the Older link writes and refuses anything else", () => {
    const c = { at: AT, key: `proposal:${ID}:decided` };
    expect(parseCursor(cursorParam(c))).toEqual(c);
    for (const bad of [undefined, null, 7, ["a"], "", "nonsense", `${AT}`, `${AT}|`, `|${c.key}`, `2026-11-10T15:00:00Z|${c.key}`, `${AT}|DROP TABLE`]) {
      expect(parseCursor(bad), String(bad)).toBeNull();
    }
  });
});
