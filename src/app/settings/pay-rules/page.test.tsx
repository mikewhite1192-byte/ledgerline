// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { rowsFor } from "@/lib/pay-rules/__tests__/rows";
import type { PayRulesPage } from "@/lib/pay-rules/read";
import { CHIP_LABEL, SWITCHED_OFF } from "@/lib/pay-rules/words";
import PayRulesSettings from "./page";

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

const mocks = vi.hoisted(() => ({
  withRequestTenant: vi.fn(),
  readShell: vi.fn(),
  readPayRulesPage: vi.fn(),
  readWaitingRuleChangeViews: vi.fn(),
}));

vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));
vi.mock("@/lib/tenant/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/shell")>()),
  readShell: mocks.readShell,
}));
vi.mock("@/lib/pay-rules/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay-rules/read")>()),
  readPayRulesPage: mocks.readPayRulesPage,
}));
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readWaitingRuleChangeViews: mocks.readWaitingRuleChangeViews,
}));

// The demo carrier's versions as the page reads them; every read is mocked, so the transaction
// is never queried.
const VERSIONS = rowsFor("blue-ridge").pay_configs;
const PAGE: PayRulesPage = {
  timeZone: "America/New_York",
  nextStart: "2026-11-02",
  versions: VERSIONS.map((v) => ({ ...v, weeksPaid: 0, firstWeek: v.effective_from })),
  currentId: VERSIONS[VERSIONS.length - 1].id,
  role: "admin",
};
const q: Queryable = {
  async query() {
    throw new Error("every read is mocked");
  },
  async execute() {
    throw new Error("the page writes nothing");
  },
};

const SWITCHES = ["rulesByTalkingEnabled", "agentEnabled", "aiEnabled"] as const;
const saved = Object.fromEntries(SWITCHES.map((k) => [k, flags[k]]));

function switches(on: Partial<Record<(typeof SWITCHES)[number], boolean>>) {
  for (const k of SWITCHES) flags[k] = on[k] ?? true;
}

const chatButton = () => screen.queryByRole("link", { name: CHIP_LABEL });

beforeEach(() => {
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => unknown) => fn(q, SESSION));
  mocks.readShell.mockResolvedValue({ name: "Blue Ridge", email: SESSION.email, timezone: "America/New_York" });
  mocks.readPayRulesPage.mockResolvedValue(PAGE);
  mocks.readWaitingRuleChangeViews.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  for (const k of SWITCHES) flags[k] = saved[k];
  vi.clearAllMocks();
});

describe("/settings/pay-rules, the button that opens the chat with an example change", () => {
  it("shows while pay rule changes, the agent and the models are all on", async () => {
    switches({});
    render(await PayRulesSettings());
    expect(chatButton()?.getAttribute("href")).toBe("/?rule=1");
  });

  it("is left out while the agent is off, and the rules are still listed", async () => {
    switches({ agentEnabled: false });
    render(await PayRulesSettings());
    expect(chatButton()).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pay rules");
    expect(screen.getAllByText("Starting rules").length).toBeGreaterThan(0);
  });

  it("is left out while the models are off", async () => {
    switches({ aiEnabled: false });
    render(await PayRulesSettings());
    expect(chatButton()).toBeNull();
  });

  it("is left out while pay rule changes are off, which the page says", async () => {
    switches({ rulesByTalkingEnabled: false });
    render(await PayRulesSettings());
    expect(chatButton()).toBeNull();
    expect(screen.getByText(SWITCHED_OFF)).toBeTruthy();
    expect(mocks.readWaitingRuleChangeViews).not.toHaveBeenCalled();
  });
});
