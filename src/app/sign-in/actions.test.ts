import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { DbError } from "@/lib/db";

// With judge access off, the password form reads the login's role once, before the cookie: a
// judge is refused like a wrong password, a role that cannot be read sets nothing, and admin and
// staff sign in as before. With the switch on there is no extra read.

const mocks = vi.hoisted(() => {
  // redirect() throws in Next; the fake throws a marker carrying the target.
  class Redirected extends Error {
    constructor(readonly to: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    Redirected,
    signIn: vi.fn(),
    verifyIdToken: vi.fn(),
    cookieSet: vi.fn(),
    role: vi.fn<() => Promise<unknown[]>>(),
    withSessionTenant: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new mocks.Redirected(to);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));
vi.mock("@/lib/auth/cognito", () => ({ signIn: mocks.signIn }));
vi.mock("@/lib/auth/verify", () => ({ verifyIdToken: mocks.verifyIdToken }));
// The tenant transaction runs the callback on a fake connection whose rows are the role read.
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withSessionTenant: mocks.withSessionTenant,
}));

import { signInAction } from "./actions";

const TOKEN = "id-token-test";
const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

let savedEnabled: boolean;

beforeEach(() => {
  savedEnabled = flags.judgeAccess.enabled;
  flags.judgeAccess.enabled = false;
  mocks.signIn.mockResolvedValue({ ok: true, idToken: TOKEN });
  mocks.verifyIdToken.mockResolvedValue(SESSION);
  mocks.withSessionTenant.mockImplementation(async (_s: Session, fn: (q: unknown) => Promise<unknown>) =>
    fn({ query: async () => mocks.role() }),
  );
});

afterEach(() => {
  flags.judgeAccess.enabled = savedEnabled;
  vi.restoreAllMocks();
  for (const m of [mocks.signIn, mocks.verifyIdToken, mocks.cookieSet, mocks.role, mocks.withSessionTenant]) {
    m.mockReset();
  }
});

// Where the action sent the browser.
async function submit(): Promise<string> {
  const form = new FormData();
  form.set("email", "desk@example.test");
  form.set("password", "pw-test");
  try {
    await signInAction(form);
  } catch (err) {
    if (err instanceof mocks.Redirected) return err.to;
    throw err;
  }
  throw new Error("signInAction returned without a redirect");
}

describe("signInAction with judge access off", () => {
  it("refuses a judge login like a wrong password and sets no cookie", async () => {
    mocks.role.mockResolvedValue([{ role: "judge" }]);
    expect(await submit()).toBe("/sign-in?error=invalid");
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.withSessionTenant).toHaveBeenCalledTimes(1);
    expect(mocks.withSessionTenant.mock.calls[0][0]).toEqual(SESSION);
  });

  it("signs in staff and admin after the one role read", async () => {
    for (const role of ["staff", "admin"]) {
      mocks.role.mockResolvedValueOnce([{ role }]);
      expect(await submit(), role).toBe("/");
    }
    expect(mocks.withSessionTenant).toHaveBeenCalledTimes(2);
    expect(mocks.cookieSet).toHaveBeenCalledTimes(2);
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      SESSION_COOKIE,
      TOKEN,
      expect.objectContaining({ httpOnly: true, path: "/" }),
    );
  });

  it("fails closed as unavailable with no cookie when the role cannot be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // A database timeout, an error with upstream detail, no membership row, and a role the code
    // does not know.
    mocks.role
      .mockRejectedValueOnce(new DbError("timeout"))
      .mockRejectedValueOnce(new Error("relation memberships: secret detail 42"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ role: "owner" }]);
    for (let i = 0; i < 4; i++) expect(await submit(), String(i)).toBe("/sign-in?error=unavailable");
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[1])).toEqual(["DbError", "Error", "ForbiddenError", "ForbiddenError"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret detail");
  });
});

describe("signInAction with judge access on", () => {
  it("signs a judge login in with no role read", async () => {
    flags.judgeAccess.enabled = true;
    mocks.role.mockResolvedValue([{ role: "judge" }]);
    expect(await submit()).toBe("/");
    expect(mocks.withSessionTenant).not.toHaveBeenCalled();
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.cookieSet).toHaveBeenCalledWith(SESSION_COOKIE, TOKEN, expect.objectContaining({ httpOnly: true }));
  });
});
