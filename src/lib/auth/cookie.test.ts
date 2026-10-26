import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionCookieOptions } from "./cookie";

describe("session cookie", () => {
  it("is httpOnly, same-site lax, site-wide and lives as long as the token", () => {
    expect(SESSION_COOKIE).toBe("pc_session");
    expect(SESSION_MAX_AGE_SECONDS).toBe(43_200);
    expect(sessionCookieOptions("production")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 43_200,
    });
  });

  it("is secure only in production, so local http sign-in still works", () => {
    expect(sessionCookieOptions("development").secure).toBe(false);
    expect(sessionCookieOptions("test").secure).toBe(false);
    expect(sessionCookieOptions(undefined).secure).toBe(false);
  });
});
