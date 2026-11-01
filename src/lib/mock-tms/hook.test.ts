import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { hookOrigin, sendMockHook } from "./hook";

const KEY = "k".repeat(48);
const TENANT = "11111111-1111-4111-8111-111111111111";
const ENV = { TMS_HOOK_ORIGIN: "http://localhost:3000" };

const saved = { mock: flags.mockTms.enabled, hook: flags.tmsHook.enabled, sync: flags.tmsSync.enabled };

function on() {
  flags.mockTms.enabled = true;
  flags.tmsHook.enabled = true;
  flags.tmsSync.enabled = true;
}

function fetchAnswering(status: number) {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status }));
}

afterEach(() => {
  flags.mockTms.enabled = saved.mock;
  flags.tmsHook.enabled = saved.hook;
  flags.tmsSync.enabled = saved.sync;
  vi.restoreAllMocks();
});

describe("the sample dispatch system's webhook send", () => {
  it("is sent on a 202, to our own route with the stored key and only the record's id", async () => {
    on();
    const f = fetchAnswering(202);
    expect(await sendMockHook(TENANT, "syn:demo:L-1", { fetch: f, key: async () => KEY, env: ENV })).toBe("sent");
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe(`http://localhost:3000/api/internal/tms-hook/${TENANT}?token=${KEY}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ recordType: "load", externalId: "syn:demo:L-1" });
  });

  it("reads a refusal as its status, and an abort as timeout, never sent", async () => {
    on();
    expect(await sendMockHook(TENANT, "x", { fetch: fetchAnswering(409), key: async () => KEY, env: ENV })).toBe("refused_409");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const slow = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      return new Response(null, { status: 202 });
    });
    expect(await sendMockHook(TENANT, "x", { fetch: slow, key: async () => KEY, env: ENV, timeoutMs: 5 })).toBe("timeout");
    const down = vi.fn(async () => {
      throw new TypeError(`fetch failed for token=${KEY}`);
    });
    expect(await sendMockHook(TENANT, "x", { fetch: down, key: async () => KEY, env: ENV })).toBe("unreachable");
    for (const call of err.mock.calls) expect(call.join(" ")).not.toContain(KEY);
  });

  it("sends nothing while its switch is off, or without an origin or a key", async () => {
    const f = fetchAnswering(202);
    expect(await sendMockHook(TENANT, "x", { fetch: f, key: async () => KEY, env: ENV })).toBe("hook_off");
    on();
    expect(await sendMockHook(TENANT, "x", { fetch: f, key: async () => KEY, env: {} })).toBe("not_configured");
    expect(await sendMockHook(TENANT, "x", { fetch: f, key: async () => null, env: ENV })).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("takes an https origin or this machine, never another plain http host", () => {
    expect(hookOrigin({ TMS_HOOK_ORIGIN: "https://app.example.test/x" })).toBe("https://app.example.test");
    expect(hookOrigin({ QBO_REDIRECT_URI: "https://app.example.test/api/qbo/callback" })).toBe("https://app.example.test");
    expect(hookOrigin({ TMS_HOOK_ORIGIN: "http://app.example.test" })).toBeNull();
    expect(hookOrigin({ TMS_HOOK_ORIGIN: "not a url" })).toBeNull();
  });
});
