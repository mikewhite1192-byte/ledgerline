import { describe, expect, it } from "vitest";
import { acceptablePod, isPdf, sameOrigin } from "./driver";

const ORIGIN = "http://localhost:3000";
const PDF = new Uint8Array([...Buffer.from("%PDF-1.4 body")]);

describe("driver guards", () => {
  it("compares origins whole", () => {
    expect(sameOrigin("http://localhost:3000/portal", ORIGIN)).toBe(true);
    expect(sameOrigin("http://localhost:3001/portal", ORIGIN)).toBe(false);
    expect(sameOrigin("https://localhost:3000/portal", ORIGIN)).toBe(false);
    expect(sameOrigin("http://localhost:3000.evil.test/portal", ORIGIN)).toBe(false);
    expect(sameOrigin("not a url", ORIGIN)).toBe(false);
  });

  it("accepts a POD only from the POD path on the origin, within the cap, starting %PDF-", () => {
    const url = `${ORIGIN}/portal/loads/FFE-100001/pod`;
    expect(acceptablePod(url, ORIGIN, PDF, 1_000)).toBe(true);
    expect(acceptablePod(`${ORIGIN}/portal/loads/FFE-100001/pod/x`, ORIGIN, PDF, 1_000)).toBe(false);
    expect(acceptablePod(`${ORIGIN}/api/portal-runs/x/evidence/pod`, ORIGIN, PDF, 1_000)).toBe(false);
    expect(acceptablePod("https://files.example.test/portal/loads/FFE-100001/pod", ORIGIN, PDF, 1_000)).toBe(false);
    expect(acceptablePod(url, ORIGIN, PDF, 5)).toBe(false);
    expect(acceptablePod(url, ORIGIN, new Uint8Array([...Buffer.from("<html>")]), 1_000)).toBe(false);
    expect(isPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });
});
