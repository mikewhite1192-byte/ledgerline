import { describe, expect, it } from "vitest";
import {
  activationBlockers,
  ARM_BLOCKERS,
  checklistForPage,
  isActivationStep,
  type ActivationChecklist,
  type ActivationFacts,
} from "./activation";

// The checklist's pure rules: which blockers the facts leave, in the arm's fixed order, and the
// whole-value test a step name must pass.

const CARD = { id: "33333333-3333-4333-8333-333333333333", last4: "4242" };
const ALL_DONE = { identity_confirmed: true, zero_test_sent: true, hand_load_acknowledged: true };
const READY: ActivationFacts = { card: CARD, steps: ALL_DONE, identity: "match", openHandLoads: 0 };

describe("activationBlockers", () => {
  it("gives all three, in order, when there is no card", () => {
    expect(activationBlockers({ ...READY, card: null, identity: "no_card" })).toEqual([...ARM_BLOCKERS]);
    expect(ARM_BLOCKERS).toEqual(["identity_confirm", "activate_without_zero_test", "activate_after_hand_load"]);
  });

  it("gives each missing step its own word", () => {
    expect(activationBlockers({ ...READY, steps: { ...ALL_DONE, identity_confirmed: false } })).toEqual(["identity_confirm"]);
    expect(activationBlockers({ ...READY, steps: { ...ALL_DONE, zero_test_sent: false } })).toEqual([
      "activate_without_zero_test",
    ]);
    expect(activationBlockers({ ...READY, steps: { ...ALL_DONE, hand_load_acknowledged: false } })).toEqual([
      "activate_after_hand_load",
    ]);
    expect(
      activationBlockers({
        ...READY,
        steps: { identity_confirmed: false, zero_test_sent: false, hand_load_acknowledged: false },
      }),
    ).toEqual([...ARM_BLOCKERS]);
  });

  it("still asks for identity when the step is on file but the statement names someone else", () => {
    expect(activationBlockers({ ...READY, identity: "mismatch" })).toEqual(["identity_confirm"]);
  });

  it("still asks about loads when the card was acknowledged but a load is open", () => {
    expect(activationBlockers({ ...READY, openHandLoads: 1 })).toEqual(["activate_after_hand_load"]);
  });

  it("blocks on a count that did not read (unknown is never zero)", () => {
    expect(activationBlockers({ ...READY, openHandLoads: null })).toEqual(["activate_after_hand_load"]);
  });

  it("gives nothing when every step is on file and nothing is open", () => {
    expect(activationBlockers(READY)).toEqual([]);
    expect(activationBlockers({ ...READY, identity: "no_statement" })).toEqual([]);
  });
});

describe("isActivationStep refuses near misses", () => {
  it("takes the three steps whole and nothing else", () => {
    for (const step of ["identity_confirmed", "zero_test_sent", "hand_load_acknowledged"]) {
      expect(isActivationStep(step), step).toBe(true);
    }
    for (const near of ["zero_test_sent ", "ZERO_TEST_SENT", "zero_test", "identity_confirmed_x", "", "armed", null, 1]) {
      expect(isActivationStep(near), String(near)).toBe(false);
    }
  });
});

describe("checklistForPage", () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  const checklist: ActivationChecklist = { ...READY, blockers: [] };
  const card = (id: string, isDefault: boolean, status: "active" | "closed" = "active") => ({ id, isDefault, status });

  it("hands the panel the checklist when its card is the one labeled Default", () => {
    expect(checklistForPage([card(CARD.id, true), card(OTHER, false)], checklist)).toBe(checklist);
    const noCard: ActivationChecklist = { ...checklist, card: null, identity: "no_card", blockers: [...ARM_BLOCKERS] };
    expect(checklistForPage([card(OTHER, true, "closed")], noCard)).toBe(noCard);
    expect(checklistForPage([], null)).toBeNull();
  });

  it("hides it when the default card changed between the two reads", () => {
    expect(checklistForPage([card(CARD.id, false), card(OTHER, true)], checklist)).toBeNull();
    expect(checklistForPage([], checklist)).toBeNull();
    expect(checklistForPage([card(OTHER, true)], { ...checklist, card: null, identity: "no_card" })).toBeNull();
    // A near miss is another card: the compare is of whole values.
    const lettered: ActivationChecklist = { ...checklist, card: { id: "abcdef00-3333-4333-8333-333333333333", last4: "4242" } };
    expect(checklistForPage([card("ABCDEF00-3333-4333-8333-333333333333", true)], lettered)).toBeNull();
    expect(checklistForPage([card(`${CARD.id} `, true)], checklist)).toBeNull();
  });
});
