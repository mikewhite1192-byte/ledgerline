// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { DEMO_FAULTS, FAULT_WORDS, NO_FAULTS } from "@/lib/adapters/tms-source/faults";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { buildCarrierPlan } from "@/lib/seed/plan";
import { RESET_TABLES, refusalText, type Refusal } from "@/lib/seed/reset";
import { countRows } from "@/lib/seed/summary";
import DemoSettings, { dynamic } from "./page";

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const [BR] = DEMO_CARRIERS;
const PLANNED = countRows(buildCarrierPlan(BR, DEMO_ANCHOR).rows);

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  withRequestTenant: vi.fn(),
  demoCarrierOf: vi.fn(),
  previewDemoReset: vi.fn(),
  readFaultSettings: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));
vi.mock("@/lib/seed/reset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seed/reset")>()),
  demoCarrierOf: mocks.demoCarrierOf,
  previewDemoReset: mocks.previewDemoReset,
}));
vi.mock("@/lib/tms/demo-faults", () => ({ readFaultSettings: mocks.readFaultSettings }));
vi.mock("./reset-action", () => ({ resetDemoAction: vi.fn() }));
vi.mock("./fleet-action", () => ({ moveFleetAction: vi.fn() }));

// The request's transaction, holding one membership with this role.
function signedIn(role: "admin" | "staff") {
  const q: Queryable = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      expect(sql).toBe("SELECT role FROM memberships WHERE cognito_sub = $1");
      expect(params).toEqual([SESSION.sub]);
      return [{ role }] as T[];
    },
    async execute() {
      throw new Error("the page writes nothing");
    },
  };
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => unknown) => fn(q, SESSION));
}

// What the carrier holds now: the plan's rows, plus a flow advance and the agent's rows.
function holding(refusals: Refusal[]) {
  const current = Object.fromEntries(RESET_TABLES.map((t) => [t, 0])) as Record<string, number>;
  Object.assign(current, PLANNED, {
    advances: PLANNED.advances + 1,
    money_actions: 3,
    proposals: 3,
    conversations: 3,
  });
  mocks.previewDemoReset.mockResolvedValue({ carrier: BR, current, refusals });
}

const rowOf = (label: string) =>
  within(screen.getByRole("table"))
    .getByText(label, { selector: "td" })
    .closest("tr") as HTMLTableRowElement;
const cellsOf = (label: string) => [...rowOf(label).querySelectorAll("td")].map((c) => c.textContent);

const savedSync = flags.tmsSync.enabled;
const savedFaults = flags.tmsSync.demoFaultsEnabled;

beforeEach(() => {
  flags.demoResetEnabled = true;
  // The dispatch sync ships off; on here, so the tests show who sees its button.
  flags.tmsSync.enabled = true;
  mocks.demoCarrierOf.mockResolvedValue(BR);
  mocks.readFaultSettings.mockResolvedValue({ kind: "ok", faults: { ...NO_FAULTS, clock_skew: true } });
});

afterEach(() => {
  cleanup();
  flags.demoResetEnabled = false;
  flags.tmsSync.enabled = savedSync;
  flags.tmsSync.demoFaultsEnabled = savedFaults;
  vi.clearAllMocks();
});

describe("/settings/demo", () => {
  it("renders per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("does not exist while the switch is off, and reads nothing", async () => {
    flags.demoResetEnabled = false;
    await expect(DemoSettings()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.withRequestTenant).not.toHaveBeenCalled();
  });

  it("shows an admin the counts now and after, what is kept, and the confirm", async () => {
    signedIn("admin");
    holding([]);
    render(await DemoSettings());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Demo reset");
    expect(screen.getByText(`Put ${BR.name} back to its seeded week`)).toBeTruthy();
    expect(screen.getByText(/rewritten exactly as the seed writes it for Nov 2, 2026/)).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(RESET_TABLES.length + 1);
    expect(cellsOf("Customers")).toEqual(["Customers", String(PLANNED.customers), String(PLANNED.customers)]);
    expect(cellsOf("Advances")).toEqual(["Advances", String(PLANNED.advances + 1), String(PLANNED.advances)]);
    expect(cellsOf("Settled payouts and bookings (test mode)")).toEqual([
      "Settled payouts and bookings (test mode)",
      "3",
      "0",
    ]);
    expect(screen.getByText(/^Kept as they are:/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /deletes the demo's agent records/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset the demo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move the fleet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync dispatch now" })).toBeTruthy();
    expect(mocks.previewDemoReset).toHaveBeenCalledWith(expect.anything(), BR);
  });

  it("leaves the dispatch sync off the page while its switch is off", async () => {
    const saved = flags.tmsSync.enabled;
    flags.tmsSync.enabled = false;
    try {
      signedIn("admin");
      holding([]);
      render(await DemoSettings());
      expect(screen.queryByRole("button", { name: "Sync dispatch now" })).toBeNull();
      expect(screen.getByRole("button", { name: "Move the fleet" })).toBeTruthy();
    } finally {
      flags.tmsSync.enabled = saved;
    }
  });

  it("leaves the dispatch faults off the page while their switch is off, and never reads them", async () => {
    flags.tmsSync.demoFaultsEnabled = false;
    signedIn("admin");
    holding([]);
    render(await DemoSettings());
    expect(screen.queryByText("Dispatch faults")).toBeNull();
    expect(mocks.readFaultSettings).not.toHaveBeenCalled();
  });

  it("shows an admin the nine fault switches as saved while their switch is on", async () => {
    flags.tmsSync.demoFaultsEnabled = true;
    signedIn("admin");
    holding([]);
    render(await DemoSettings());
    expect(screen.getByText("Dispatch faults")).toBeTruthy();
    for (const f of DEMO_FAULTS) {
      const box = screen.getByRole("checkbox", { name: new RegExp(FAULT_WORDS[f].title) }) as HTMLInputElement;
      expect(box.checked).toBe(f === "clock_skew");
    }
  });

  it("leaves the dispatch faults off the page for a carrier without the demo feed", async () => {
    flags.tmsSync.demoFaultsEnabled = true;
    mocks.readFaultSettings.mockResolvedValue({ kind: "not_synthetic" });
    signedIn("admin");
    holding([]);
    render(await DemoSettings());
    expect(screen.queryByText("Dispatch faults")).toBeNull();
  });

  it("shows the refusals instead of the button while a person must settle something", async () => {
    signedIn("admin");
    const refusals: Refusal[] = [{ kind: "mismatch", count: 1 }];
    holding(refusals);
    render(await DemoSettings());
    const blocked = screen.getByRole("status");
    expect(blocked.textContent).toContain(refusalText(refusals[0]));
    // Only the reset waits on the person; Move the fleet is its own card.
    expect(screen.queryByRole("button", { name: "Reset the demo" })).toBeNull();
  });

  it("shows a staff login a sentence, never the counts, the button or the fault switches", async () => {
    flags.tmsSync.demoFaultsEnabled = true;
    signedIn("staff");
    render(await DemoSettings());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(mocks.readFaultSettings).not.toHaveBeenCalled();
    expect(screen.getByText("Only an admin of this carrier can reset the demo.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.demoCarrierOf).not.toHaveBeenCalled();
    expect(mocks.previewDemoReset).not.toHaveBeenCalled();
  });

  it("offers nothing on a carrier that is not a demo carrier", async () => {
    signedIn("admin");
    mocks.demoCarrierOf.mockResolvedValue(null);
    render(await DemoSettings());
    expect(screen.getByText(/This carrier is not a demo carrier/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.previewDemoReset).not.toHaveBeenCalled();
  });

  it("fails closed with the unreadable state when the database errs", async () => {
    mocks.withRequestTenant.mockRejectedValue(new DbError("unavailable"));
    render(await DemoSettings());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
