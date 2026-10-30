import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { ESCROW_RELEASE_PROMPT, operatorPrompt } from "../agent/policy";
import { dedupeKey } from "../agent/gateway/store/proposals";
import type { TenantDb } from "../db";
import { EXECUTORS, type ProposalRow } from "../proposals/execute";
import { escrowReleaseExecutor, executeEscrowRelease, factCategory, releaseArgsOf, uniqueViolationCategory } from "./execute";
import { releaseFactRefusal, type DriverEscrow, type ReleaseRow } from "./read";
import { escrowReleaseGate, escrowReleaseOn } from "./switches";

// The escrow release's pure pieces: the release gate's reasons in order (the cap inclusive, the
// start date on the carrier's local date, a bad date closed), the driver's facts in the card's
// order, the words an approval says, the proposal's args read whole, the one-live index named by
// its whole name, the dedupe key, the registry getter and the prompt section behind the switch.
// No database, no clock.

const saved = structuredClone(flags.escrowRelease);
const savedPayouts = flags.payoutsEnabled;

afterEach(() => {
  flags.escrowRelease = structuredClone(saved);
  flags.payoutsEnabled = savedPayouts;
});

function switchesOn() {
  flags.escrowRelease.enabled = true;
  flags.escrowRelease.armed = true;
  flags.payoutsEnabled = true;
}

const DRIVER = "4b3a2918-0f1e-4d2c-9b8a-7f6e5d4c3b2a";
const terminated: DriverEscrow = { id: DRIVER, code: "DRV-9", activeFrom: "2026-01-05", activeTo: "2026-07-31", balanceCents: 120_000 };
const live: ReleaseRow = {
  id: "5c4b3a29-1f0e-4d2c-9b8a-7f6e5d4c3b2a",
  driverId: DRIVER,
  proposalId: "6d5c4b3a-2f1e-4d2c-9b8a-7f6e5d4c3b2a",
  moneyActionId: null,
  openingBalanceCents: 120_000,
  amountCents: 120_000,
  status: "issuing",
  releasedAt: null,
  createdAt: "2026-11-02T15:00:00.000Z",
};

function proposal(over: Partial<ProposalRow> = {}, args: Record<string, unknown> = {}): ProposalRow {
  return {
    id: "7e6d5c4b-3f2e-4d2c-9b8a-7f6e5d4c3b2a",
    conversationId: null,
    turnId: null,
    kind: "escrow_release",
    subjectTable: "drivers",
    subjectId: DRIVER,
    amountCents: 120_000,
    direction: "out",
    args: { driverId: DRIVER, amountCents: 120_000, balanceAsOf: "2026-11-02", ...args },
    status: "proposed",
    flaggedInputId: null,
    auditorVerdict: "pass",
    auditorAgrees: true,
    moneyActionId: null,
    traceId: null,
    ...over,
  };
}

describe("escrowReleaseGate", () => {
  it("names the first closed switch, in order", () => {
    flags.escrowRelease = { enabled: false, armed: false, capCents: 500_000, startDate: "2026-11-02" };
    expect(escrowReleaseGate(120_000, "2026-11-02")).toBe("escrow_off");
    flags.escrowRelease.enabled = true;
    flags.payoutsEnabled = false;
    expect(escrowReleaseGate(120_000, "2026-11-02")).toBe("escrow_payouts_off");
    flags.payoutsEnabled = true;
    expect(escrowReleaseGate(120_000, "2026-11-02")).toBe("escrow_not_armed");
    flags.escrowRelease.armed = true;
    expect(escrowReleaseGate(500_001, "2026-11-02")).toBe("over_escrow_cap");
    expect(escrowReleaseGate(120_000, "2026-11-01")).toBe("escrow_before_start");
    expect(escrowReleaseGate(120_000, "2026-11-02")).toBeNull();
  });

  it("takes the cap itself and refuses one cent over it, or an amount that is not whole cents", () => {
    switchesOn();
    expect(flags.escrowRelease.capCents).toBe(500_000);
    expect(escrowReleaseGate(500_000, "2026-11-02")).toBeNull();
    expect(escrowReleaseGate(500_001, "2026-11-02")).toBe("over_escrow_cap");
    expect(escrowReleaseGate(1_000.5, "2026-11-02")).toBe("over_escrow_cap");
  });

  it("reads a start date that is not a real date as closed", () => {
    switchesOn();
    flags.escrowRelease.startDate = "2026-02-30";
    expect(escrowReleaseGate(120_000, "2026-11-02")).toBe("escrow_before_start");
  });

  it("ships on and armed with its cap and start date: a release at or under the cap from the start date opens", () => {
    expect(saved).toEqual({ enabled: true, armed: true, capCents: 500_000, startDate: "2026-10-30" });
    expect(escrowReleaseOn()).toBe(true);
    expect(escrowReleaseGate(120_000, "2026-11-02")).toBeNull();
    expect(escrowReleaseGate(120_000, "2026-10-29")).toBe("escrow_before_start");
    expect(escrowReleaseGate(500_001, "2026-11-02")).toBe("over_escrow_cap");
    flags.escrowRelease.enabled = false;
    expect(escrowReleaseOn()).toBe(false);
  });
});

describe("releaseFactRefusal", () => {
  it("names the first fact that fails, in the card's order", () => {
    expect(releaseFactRefusal(null, live, 120_000, "2026-11-02")).toBe("driver_not_found");
    expect(releaseFactRefusal({ ...terminated, activeTo: null }, live, 120_000, "2026-11-02")).toBe("driver_active");
    expect(releaseFactRefusal({ ...terminated, activeTo: "2026-11-02" }, live, 120_000, "2026-11-02")).toBe("driver_active");
    expect(releaseFactRefusal(terminated, live, 120_000, "2026-11-02")).toBe("release_exists");
    expect(releaseFactRefusal({ ...terminated, balanceCents: 0 }, null, 0, "2026-11-02")).toBe("zero_balance");
    expect(releaseFactRefusal(terminated, null, 120_001, "2026-11-02")).toBe("amount_mismatch");
    expect(releaseFactRefusal(terminated, null, 119_999, "2026-11-02")).toBe("amount_mismatch");
    expect(releaseFactRefusal(terminated, null, 120_000, "2026-11-02")).toBeNull();
  });

  it("reads a last active day of yesterday as terminated", () => {
    expect(releaseFactRefusal({ ...terminated, activeTo: "2026-11-01" }, null, 120_000, "2026-11-02")).toBeNull();
  });

  it("says a balance that moved is stale, and a missing driver not found, in the approval's words", () => {
    expect(factCategory("amount_mismatch")).toBe("stale");
    expect(factCategory("zero_balance")).toBe("stale");
    expect(factCategory("driver_not_found")).toBe("not_found");
    expect(factCategory("driver_active")).toBe("driver_active");
    expect(factCategory("release_exists")).toBe("release_exists");
  });
});

describe("releaseArgsOf", () => {
  it("reads a well-formed proposal whole", () => {
    expect(releaseArgsOf(proposal())).toEqual({ driverId: DRIVER, amountCents: 120_000, balanceAsOf: "2026-11-02" });
  });

  it.each([
    ["another kind", proposal({ kind: "advance_payout" })],
    ["another subject table", proposal({ subjectTable: "loads" })],
    ["a subject that is not a canonical id", proposal({ subjectId: DRIVER.toUpperCase() }, { driverId: DRIVER.toUpperCase() })],
    ["args naming another driver", proposal({}, { driverId: live.id })],
    ["args with another amount", proposal({}, { amountCents: 120_001 })],
    ["a zero amount", proposal({ amountCents: 0 }, { amountCents: 0 })],
    ["an amount in fractions of a cent", proposal({ amountCents: 1.5 }, { amountCents: 1.5 })],
    ["no balance date", proposal({}, { balanceAsOf: undefined })],
    ["a balance date that is not a date", proposal({}, { balanceAsOf: "2026-13-01" })],
  ])("refuses %s as not executable", (_what, p) => {
    expect(releaseArgsOf(p)).toBeNull();
  });
});

describe("uniqueViolationCategory", () => {
  it("reads only the whole one-live index name as another live release", () => {
    expect(uniqueViolationCategory("escrow_releases_one_live_per_driver")).toBe("release_exists");
    expect(uniqueViolationCategory("escrow_releases_one_live_per_driver_x")).toBe("release_ref_collision");
    expect(uniqueViolationCategory("escrow_releases_one_per_proposal")).toBe("release_ref_collision");
    expect(uniqueViolationCategory(undefined)).toBe("release_ref_collision");
  });
});

describe("the dedupe key", () => {
  it("is the same for the same release whatever the args' order, and differs for another amount or day", () => {
    const a = dedupeKey("escrow_release", DRIVER, { driverId: DRIVER, amountCents: 120_000, balanceAsOf: "2026-11-02" });
    const b = dedupeKey("escrow_release", DRIVER, { balanceAsOf: "2026-11-02", amountCents: 120_000, driverId: DRIVER });
    expect(a).toBe(b);
    expect(a).toMatch(new RegExp(`^escrow_release:${DRIVER}:[0-9a-f]{64}$`));
    expect(dedupeKey("escrow_release", DRIVER, { driverId: DRIVER, amountCents: 120_001, balanceAsOf: "2026-11-02" })).not.toBe(a);
    expect(dedupeKey("escrow_release", DRIVER, { driverId: DRIVER, amountCents: 120_000, balanceAsOf: "2026-11-03" })).not.toBe(a);
  });
});

describe("the executor behind the switch", () => {
  it("is registered only while the switch is on, with its precheck", () => {
    flags.escrowRelease.enabled = false;
    expect(EXECUTORS.escrow_release).toBeUndefined();
    flags.escrowRelease.enabled = true;
    expect(EXECUTORS.escrow_release).toBe(escrowReleaseExecutor);
    expect(typeof EXECUTORS.escrow_release?.precheck).toBe("function");
    flags.escrowRelease.enabled = false;
    expect(EXECUTORS.escrow_release).toBeUndefined();
  });

  it("refuses with the switch off before opening a transaction", async () => {
    flags.escrowRelease.enabled = false;
    const withTenant = vi.fn();
    const db = { withTenant } as unknown as TenantDb;
    const session = { sub: "sub-1", email: "", tenantId: "8f7e6d5c-4b3a-4d2c-9b8a-7f6e5d4c3b2a" };
    const out = await executeEscrowRelease(db, session, proposal({ status: "approved" }), { confirmed: false }, { db });
    expect(out).toEqual({ ok: false, category: "escrow_off", retryable: false });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("refuses args that do not read whole before opening a transaction", async () => {
    switchesOn();
    const withTenant = vi.fn();
    const db = { withTenant } as unknown as TenantDb;
    const session = { sub: "sub-1", email: "", tenantId: "8f7e6d5c-4b3a-4d2c-9b8a-7f6e5d4c3b2a" };
    const bad = proposal({ status: "approved" }, { amountCents: 1 });
    expect(await executeEscrowRelease(db, session, bad, { confirmed: false }, { db })).toEqual({
      ok: false,
      category: "not_executable",
      retryable: false,
    });
    expect(withTenant).not.toHaveBeenCalled();
  });
});

describe("the operator prompt", () => {
  it("adds the escrow release section only while the propose tool is offered", () => {
    const without = operatorPrompt(["get_driver"], false);
    expect(without).not.toContain("Escrow releases:");
    const withTool = operatorPrompt(["get_driver", "propose_escrow_release"], false);
    expect(withTool).toBe(`${without}\n${ESCROW_RELEASE_PROMPT}`);
  });
});
