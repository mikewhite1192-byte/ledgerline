// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";

// The public help page: signed out it opens no tenant transaction at all; signed in it reads the
// carrier chip and the worked week's driver inside the session's own tenant; a failed signed-in read
// falls back to the public page and logs only the error's kind.
const SESSION: Session = { sub: "sub-test-1", email: "office@example.test", tenantId: "00000000-0000-4000-8000-000000000001" };
const state = vi.hoisted(() => ({ session: null as Session | null, opened: 0, fail: false, sql: [] as string[] }));

const fakeQ = {
  async query(sql: string) {
    state.sql.push(sql);
    if (state.fail) throw new Error("connection reset by 10.0.0.12");
    if (/FROM tenants/.test(sql)) return [{ name: "Test Carrier", timezone: "America/Chicago" }];
    if (/FROM memberships/.test(sql)) return [{ email: SESSION.email }];
    if (/FROM drivers/.test(sql)) return [];
    throw new Error(`unexpected read: ${sql.slice(0, 80)}`);
  },
} as unknown as Queryable;

vi.mock("@/lib/auth/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/tenant/context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant/context")>();
  return {
    ...real,
    withRequestTenant: async () => {
      throw new Error("the help page never asks for the request's tenant");
    },
    withSessionTenant: async <T,>(s: Session, fn: (q: Queryable) => Promise<T>) => {
      expect(s).toBe(SESSION);
      state.opened += 1;
      return fn(fakeQ);
    },
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/help/how-pay-works",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));
vi.mock("@/app/fonts", () => ({ sans: { variable: "font-sans" } }));

async function show(): Promise<void> {
  const { default: Page } = await import("./page");
  render((await Page()) as ReactNode);
}

beforeEach(() => {
  state.session = null;
  state.opened = 0;
  state.fail = false;
  state.sql = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("/help/how-pay-works", () => {
  it("signed out, reads no carrier's records and offers the sign-in", async () => {
    await show();
    expect(state.opened).toBe(0);
    expect(state.sql).toEqual([]);
    expect(screen.getByRole("heading", { level: 1, name: "How trucking pay works" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "The business",
      "Money in: a load becomes an invoice",
      "Money out: a driver's week becomes a paystub",
      "Why it breaks",
      "What LedgerLine does",
    ]);
    expect(screen.getByRole("link", { name: "Sign in to try the demo" }).getAttribute("href")).toBe("/sign-in");
    expect(screen.queryByRole("link", { name: /See her paystub/ })).toBeNull();
  });

  it("signed in, reads inside the session's own carrier and shows the menu without the sign-in", async () => {
    state.session = SESSION;
    await show();
    expect(state.opened).toBe(1);
    expect(screen.getAllByText("Test Carrier").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Sign in to try the demo" })).toBeNull();
    // This carrier has no driver BR-D07, so there is no link to her paystub.
    expect(screen.queryByRole("link", { name: /See her paystub/ })).toBeNull();
  });

  it("a failed signed-in read shows the public page and logs only the error's kind", async () => {
    state.session = SESSION;
    state.fail = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await show();
    expect(screen.getByRole("link", { name: "Sign in to try the demo" })).toBeTruthy();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe("help: signed-in read failed (Error)");
    expect(log.mock.calls.flat().join(" ")).not.toContain("10.0.0.12");
  });
});
