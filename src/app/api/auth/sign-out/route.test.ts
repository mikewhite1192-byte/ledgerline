import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { POST } from "./route";

function signOut(secFetchSite?: string) {
  const headers = secFetchSite ? { "Sec-Fetch-Site": secFetchSite } : undefined;
  return POST(new Request("https://app.example/api/auth/sign-out", { method: "POST", headers }));
}

describe("POST /api/auth/sign-out", () => {
  it("clears the session cookie and redirects to /sign-in for a same-origin form", () => {
    const response = signOut("same-origin");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
    expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({ value: "", maxAge: 0, path: "/" });
  });

  it("refuses a cross-site or same-site post and leaves the cookie alone", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = signOut(site);
      expect(response.status, site).toBe(403);
      expect(response.headers.get("location"), site).toBeNull();
      expect(response.headers.get("set-cookie"), site).toBeNull();
    }
  });

  it("signs out as before when the browser sends no Sec-Fetch-Site", () => {
    const response = signOut();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
    expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
  });
});
