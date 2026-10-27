// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";

const state = vi.hoisted(() => ({ session: null as unknown, failRead: false }));
const SESSION: Session = { sub: "sub-test-1", email: "office@example.test", tenantId: "00000000-0000-4000-8000-000000000001" };

const fakeQ = {
  async query(sql: string) {
    if (state.failRead) throw new Error("read failed");
    if (/FROM tenants/.test(sql)) return [{ name: "Test Carrier", timezone: "America/Chicago" }];
    if (/FROM memberships/.test(sql)) return [{ email: SESSION.email }];
    throw new Error(`unexpected read: ${sql}`);
  },
} as unknown as Queryable;

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => state.session,
  requireSession: async () => state.session,
}));
vi.mock("@/lib/tenant/context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant/context")>();
  return { ...real, withSessionTenant: async <T,>(_s: Session, fn: (q: Queryable) => Promise<T>) => fn(fakeQ) };
});

import NotFound from "./not-found";

afterEach(() => {
  state.session = null;
  state.failRead = false;
  cleanup();
  vi.restoreAllMocks();
});

function expectNotHere() {
  expect(screen.getByRole("heading", { level: 1, name: "That page is not here" })).toBeTruthy();
  expect(
    screen.getByText("The address may be wrong, or the page may be switched off for this carrier. Nothing changed."),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
  expect(document.body.textContent).not.toMatch(/404|could not be found/);
}

describe("the not-found page", () => {
  it("sits inside the signed-in shell, with the menu, for someone signed in", async () => {
    state.session = SESSION;
    render(await NotFound());
    expectNotHere();
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Test Carrier").length).toBeGreaterThan(0);
  });

  it("stands alone, with the way Home, for someone signed out", async () => {
    render(await NotFound());
    expectNotHere();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("falls back to the page without the shell when the carrier cannot be read, logging only the kind", async () => {
    state.session = SESSION;
    state.failRead = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(await NotFound());
    expectNotHere();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(log).toHaveBeenCalledWith("not-found: shell read failed (Error)");
  });
});
