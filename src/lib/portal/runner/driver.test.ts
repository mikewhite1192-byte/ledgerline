import { describe, expect, it } from "vitest";
import { acceptablePod, isPdf, sameOrigin, socketOnOrigin } from "./driver";

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

  it("lets a WebSocket through only to the portal's own origin, compared whole", () => {
    expect(socketOnOrigin("ws://localhost:3000/_next/webpack-hmr", ORIGIN)).toBe(true);
    expect(socketOnOrigin("wss://portal.example.test/ws", "https://portal.example.test")).toBe(true);
    // Another host, port or scheme pairing is off the origin.
    expect(socketOnOrigin("wss://evil.example.test/ws", "https://portal.example.test")).toBe(false);
    expect(socketOnOrigin("ws://localhost:3001/ws", ORIGIN)).toBe(false);
    expect(socketOnOrigin("wss://localhost:3000/ws", ORIGIN)).toBe(false);
    expect(socketOnOrigin("ws://localhost:3000.evil.test/ws", ORIGIN)).toBe(false);
    expect(socketOnOrigin("wss://user@portal.example.test/ws", "https://user@portal.example.test")).toBe(false);
    // Only ws and wss are sockets at all.
    expect(socketOnOrigin("http://localhost:3000/ws", ORIGIN)).toBe(false);
    expect(socketOnOrigin("not a url", ORIGIN)).toBe(false);
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
