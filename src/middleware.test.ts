import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "./middleware";

// The portal is read-only: GET and HEAD everywhere under /portal, and one POST, the sign-in form.

const at = (method: string, path: string) => middleware(new NextRequest(`https://app.example${path}`, { method }));

describe("portal middleware", () => {
  it("lets reads and the sign-in form through", () => {
    for (const [method, path] of [
      ["GET", "/portal"],
      ["HEAD", "/portal/loads"],
      ["GET", "/portal/loads/FFE-100001/pod"],
      ["POST", "/portal/sign-in"],
    ]) {
      expect(at(method, path).status, `${method} ${path}`).toBe(200);
    }
  });

  it("refuses every other method with 405", () => {
    for (const [method, path] of [
      ["POST", "/portal/loads"],
      ["PUT", "/portal/sign-in"],
      ["DELETE", "/portal/loads/FFE-100001"],
      ["PATCH", "/portal"],
      ["POST", "/portal/sign-in/"],
    ]) {
      const response = at(method, path);
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("matches only the portal's own paths", () => {
    expect(config.matcher).toEqual(["/portal", "/portal/:path*"]);
  });
});
