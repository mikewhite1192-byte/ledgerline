import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { statusLabel } from "../format/labels";
import { SUBJECT_STATUSES } from "../money/types";
import { cents } from "../rules-engine/money";
import { checkAdvance, outstandingCents } from "../rules-engine/recovery";
import { ADVANCE_STATUSES, type AdvanceRecord } from "../rules-engine/types";
import { cardNameMatches, type CardNameFacts } from "./identity";
import { PARK_REASONS, PARK_REASON_WORDS, isParkReason, parkingOn, parkReasonOf, type ParkFacts } from "./parking";
import { ADVANCE_APPROVE_NOTICE, decisionNoteSentence, outcomeSentence } from "./reasons";

// Parked advances' pure rules: the reason picked from the facts, in order; the statement name
// check, whole value; the switch with its start date; and every sentence a person sees.

const clear: ParkFacts = { cardOnFile: true, nameMatches: true, room: true, overridden: false };

describe("parkReasonOf", () => {
  it("parks nothing when every fact holds, and an unchecked name is not a mismatch", () => {
    expect(parkReasonOf(clear)).toBeNull();
    expect(parkReasonOf({ ...clear, nameMatches: null })).toBeNull();
  });

  it("picks the first reason that holds: card, then name, then room, then override", () => {
    // Every combination of the four facts, against the order written out by hand.
    for (const cardOnFile of [true, false]) {
      for (const nameMatches of [true, false, null]) {
        for (const room of [true, false]) {
          for (const overridden of [true, false]) {
            const expected = !cardOnFile
              ? "card_removed"
              : nameMatches === false
                ? "name_mismatch"
                : !room
                  ? "no_room"
                  : overridden
                    ? "override"
                    : null;
            expect(parkReasonOf({ cardOnFile, nameMatches, room, overridden })).toBe(expected);
          }
        }
      }
    }
  });

  it("knows exactly the four reasons 0079 allows, each in words", () => {
    expect([...PARK_REASONS]).toEqual(["card_removed", "name_mismatch", "no_room", "override"]);
    for (const r of PARK_REASONS) {
      expect(isParkReason(r)).toBe(true);
      expect(PARK_REASON_WORDS[r].length).toBeGreaterThan(0);
    }
    for (const v of ["", "parked", "No_room", "no_room ", null, undefined, 1]) expect(isParkReason(v)).toBe(false);
  });
});

describe("cardNameMatches", () => {
  const named = (statementName: string | null): CardNameFacts => ({
    holderKind: "named",
    cardPortalName: null,
    driverName: "Rosa Delgado",
    driverCode: "BR-D07",
    statementName,
  });

  it("matches the driver's name or code, whatever the case and spacing", () => {
    expect(cardNameMatches(named("ROSA DELGADO"))).toBe(true);
    expect(cardNameMatches(named("  rosa   delgado "))).toBe(true);
    expect(cardNameMatches(named("BR-D07"))).toBe(true);
    expect(cardNameMatches(named("br-d07"))).toBe(true);
  });

  it("refuses a reordered, partial or different name, compared whole", () => {
    expect(cardNameMatches(named("DELGADO ROSA"))).toBe(false);
    expect(cardNameMatches(named("ROSA"))).toBe(false);
    expect(cardNameMatches(named("ROSA DELGADO JR"))).toBe(false);
    expect(cardNameMatches(named("BR-D0"))).toBe(false);
    expect(cardNameMatches(named("SAM PATEL"))).toBe(false);
    // A statement name of a shape no portal shows is never a match.
    expect(cardNameMatches(named("Rosa\u2014Delgado"))).toBe(false);
  });

  it("checks a generic card against its own portal name, not the driver's", () => {
    const generic = (statementName: string): CardNameFacts => ({
      holderKind: "generic",
      cardPortalName: "POOL CARD 3",
      driverName: "Rosa Delgado",
      driverCode: "BR-D07",
      statementName,
    });
    expect(cardNameMatches(generic("POOL CARD 3"))).toBe(true);
    expect(cardNameMatches(generic("pool card 3"))).toBe(true);
    expect(cardNameMatches(generic("POOL CARD 4"))).toBe(false);
    expect(cardNameMatches(generic("ROSA DELGADO"))).toBe(false);
  });

  it("does not check a card with no statement row", () => {
    expect(cardNameMatches(named(null))).toBe(true);
  });
});

describe("parkingOn", () => {
  const saved = flags.advanceParking;
  afterEach(() => {
    flags.advanceParking = saved;
  });

  it("ships on, from its start date", () => {
    expect(parkingOn("2026-11-05T15:00:00.000Z", "America/Chicago")).toBe(true);
  });

  it("is on only with the switch on, for a proposal made on or after the start date in the carrier's zone", () => {
    flags.advanceParking = { enabled: true, startDate: "2026-11-02" };
    expect(parkingOn("2026-11-02T06:00:00.000Z", "America/Chicago")).toBe(true);
    // 2026-11-02 04:00 UTC is still Nov 1 in Chicago.
    expect(parkingOn("2026-11-02T04:00:00.000Z", "America/Chicago")).toBe(false);
    expect(parkingOn("2026-11-02T04:00:00.000Z", "UTC")).toBe(true);
    flags.advanceParking = { enabled: true, startDate: "2026-02-30" };
    expect(parkingOn("2026-11-02T16:00:00.000Z", "UTC")).toBe(false);
  });
});

describe("parked advances' statuses and sentences", () => {
  const record = (status: AdvanceRecord["status"]): AdvanceRecord => ({
    id: "11111111-1111-4111-8111-111111111111",
    driverId: "22222222-2222-4222-8222-222222222222",
    requestRef: "ADV-000000000001",
    requestedAt: "2026-11-02T15:00:00.000Z",
    requestedOn: "2026-11-02",
    amountCents: cents(25_000),
    feeCents: cents(500),
    status,
    recoveredCents: cents(0),
    source: "ui",
    reasonCategory: null,
    paidAt: null,
    loadId: null,
    takenBackCents: cents(0),
  });

  it("is an advance status the engine reads and counts as owing nothing", () => {
    expect(ADVANCE_STATUSES).toContain("parked");
    expect(checkAdvance(record("parked")).status).toBe("parked");
    expect(outstandingCents(record("parked"))).toBe(0);
    expect(statusLabel("parked")).toBe("Parked");
    // The ledger never starts from a parked advance.
    expect(SUBJECT_STATUSES.advances as readonly string[]).not.toContain("parked");
  });

  it("says each park in a fixed sentence the approval card shows", () => {
    expect(outcomeSentence("parked_card_removed")).toBe(
      "Parked: that card is no longer on file. Fix it, then approve again, or reject.",
    );
    for (const code of [
      "parked_card_removed",
      "parked_name_mismatch",
      "parked_no_room",
      "parked_override",
      "parking_off",
      "parked_needs_admin",
    ]) {
      expect(outcomeSentence(code)).not.toBe(outcomeSentence("unavailable"));
      expect(ADVANCE_APPROVE_NOTICE[code]).toBe(outcomeSentence(code));
    }
  });

  it("says a parked advance's reject in words, and only from the fixed note", () => {
    expect(decisionNoteSentence("rejected_parked:wrong_amount")).toBe(
      "Rejected while parked (wrong amount), so nothing was paid.",
    );
    expect(decisionNoteSentence("rejected_parked:Wrong")).toBe("Decision: rejected parked:wrong.");
  });
});
