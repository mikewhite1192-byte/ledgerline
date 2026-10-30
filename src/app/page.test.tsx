// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { nextWeekStart } from "@/lib/pay-rules/words";
import Home from "./page";

// The home screen's ?rule=1 path, from the Pay rules page's button: the question box starts with
// the example change and the help under it, both dated the first week a change can start. Every
// read is faked and the clock is fixed; nothing reads the wall clock.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

const mocks = vi.hoisted(() => ({
  withRequestTenant: vi.fn(),
  readNextWeekStart: vi.fn(),
  readRecentAgentTurns: vi.fn(),
}));

vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));
vi.mock("@/lib/pay-rules/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay-rules/read")>()),
  readNextWeekStart: mocks.readNextWeekStart,
}));
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readRecentAgentTurns: mocks.readRecentAgentTurns,
}));
// The chat itself is a client component with its own tests; here only what the page hands it.
vi.mock("@/components/agent/turn-view", () => ({
  AgentChat: ({ initialDraft, initialHelp }: { initialDraft?: string; initialHelp?: string }) => (
    <div>
      <p data-testid="draft">{initialDraft ?? ""}</p>
      <p data-testid="help">{initialHelp ?? ""}</p>
    </div>
  ),
}));
vi.mock("./ai-proof-form", () => ({ AiProofForm: () => null }));

// The request's transaction: one carrier in New York, one member, and its record counts.
const q: Queryable = {
  async query<T>(sql: string): Promise<T[]> {
    if (sql.startsWith("SELECT name, timezone FROM tenants")) {
      return [{ name: "Blue Ridge", timezone: "America/New_York" }] as T[];
    }
    if (sql.startsWith("SELECT email, role FROM memberships")) return [{ email: SESSION.email, role: "staff" }] as T[];
    if (sql.includes("FROM drivers")) return [{ drivers: 1, loads: 2, periods: 3 }] as T[];
    throw new Error(`unexpected read: ${sql}`);
  },
  async execute() {
    throw new Error("the page writes nothing");
  },
};

const SWITCHES = ["rulesByTalkingEnabled", "agentEnabled", "aiEnabled"] as const;
// The switches whose reads the fake transaction above does not answer (the needs-you rows of the
// pay run, advances, invoices and the chat loop's escalations, the sweep's line, Friday's cash
// card): off, so the page reads only what this test fakes.
const OFF = ["settlementsEnabled", "advancesEnabled", "invoicesEnabled", "sweepEnabled", "cashFridayEnabled"] as const;
const saved = Object.fromEntries([...SWITCHES, ...OFF].map((k) => [k, flags[k]]));
const savedVerification = flags.verification;

beforeEach(() => {
  // Tuesday Nov 10, 2026, after the week of Nov 9 has begun.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
  for (const k of SWITCHES) flags[k] = true;
  for (const k of OFF) flags[k] = false;
  flags.verification = { ...savedVerification, enabled: false };
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => unknown) => fn(q, SESSION));
  mocks.readNextWeekStart.mockImplementation(async (_q: Queryable, now: Date) =>
    nextWeekStart(now, "America/New_York", 1),
  );
  mocks.readRecentAgentTurns.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const k of [...SWITCHES, ...OFF]) flags[k] = saved[k];
  flags.verification = savedVerification;
  vi.clearAllMocks();
});

describe("home, ?rule=1", () => {
  it("starts the box with the example and its help dated the next week start, past Nov 9", async () => {
    render(await Home({ searchParams: Promise.resolve({ rule: "1" }) }));
    expect(screen.getByTestId("draft").textContent).toBe("Starting Nov 16, owner-operator insurance goes to $12 a day");
    expect(screen.getByTestId("help").textContent).toBe(
      "Say the rule, the new amount and the date it starts. Example: 'From Nov 16, the net pay floor is $350 a week.'",
    );
  });

  it("starts the box empty while pay rule changes are off", async () => {
    flags.rulesByTalkingEnabled = false;
    render(await Home({ searchParams: Promise.resolve({ rule: "1" }) }));
    expect(screen.getByTestId("draft").textContent).toBe("");
    expect(screen.getByTestId("help").textContent).toBe("");
    expect(mocks.readNextWeekStart).not.toHaveBeenCalled();
  });
});
