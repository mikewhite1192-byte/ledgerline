import { describe, expect, it } from "vitest";
import {
  DEMO_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
  visitCookieOptions,
} from "./cookie";

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

describe("demo visit cookies", () => {
  it("name the visit pc_demo and last the visit's hours, with the session cookie's flags", () => {
    expect(DEMO_COOKIE).toBe("pc_demo");
    expect(visitCookieOptions(2, "production")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 7_200,
    });
    expect(visitCookieOptions(2, "development").secure).toBe(false);
  });

  it("never outlive a normal session, and an unusable length gives a cookie that is already gone", () => {
    expect(visitCookieOptions(48, "production").maxAge).toBe(SESSION_MAX_AGE_SECONDS);
    expect(visitCookieOptions(0, "production").maxAge).toBe(0);
    expect(visitCookieOptions(-1, "production").maxAge).toBe(0);
    expect(visitCookieOptions(Number.NaN, "production").maxAge).toBe(0);
  });
});
