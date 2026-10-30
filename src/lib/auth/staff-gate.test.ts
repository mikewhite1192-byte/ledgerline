import { afterEach, describe, expect, it, vi } from "vitest";
import { DbError } from "../db";

const mocks = vi.hoisted(() => ({ role: vi.fn<() => Promise<unknown[]>>() }));

// The tenant transaction runs the callback on a fake connection whose one row is the role.
vi.mock("../tenant/context", async (importOriginal) => {
  const real = await importOriginal<typeof import("../tenant/context")>();
  return {
    ...real,
    withSessionTenant: async (_s: unknown, fn: (q: unknown) => Promise<unknown>) =>
      fn({ query: async () => mocks.role() }),
  };
});

import { staffGate } from "./staff-gate";

const SESSION = { sub: "sub-1", email: "x@example.com", tenantId: "00000000-0000-4000-8000-000000000001" };

afterEach(() => {
  vi.restoreAllMocks();
  mocks.role.mockReset();
});

describe("staffGate", () => {
  it("answers null for admin and staff", async () => {
    mocks.role.mockResolvedValueOnce([{ role: "admin" }]).mockResolvedValueOnce([{ role: "staff" }]);
    expect(await staffGate(SESSION)).toBeNull();
    expect(await staffGate(SESSION)).toBeNull();
  });

  it("refuses a judge with 403 judge, not retryable, never cached", async () => {
    mocks.role.mockResolvedValue([{ role: "judge" }]);
    const res = await staffGate(SESSION);
    expect(res?.status).toBe(403);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(await res?.json()).toEqual({ error: "judge", retryable: false });
  });

  it("refuses no membership with 403 forbidden", async () => {
    mocks.role.mockResolvedValue([]);
    const res = await staffGate(SESSION);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "forbidden", retryable: false });
  });

  it("refuses an unknown failure as 503 unavailable and logs the error name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("relation memberships: secret detail 42");
    mocks.role.mockRejectedValueOnce(err).mockRejectedValueOnce(new DbError("timeout"));
    const res = await staffGate(SESSION);
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: "unavailable", retryable: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret detail");
    const second = await staffGate(SESSION);
    expect(second?.status).toBe(503);
    expect(log.mock.calls.map((c) => c[1])).toEqual(["Error", "DbError"]);
  });
});
