import { describe, expect, it, vi } from "vitest";
import type { CallOutcome } from "../types";
import { categoryForStatus, post, upstreamIdFrom, usageFrom, type FetchFn } from "./http";

// Not a real key: low entropy on purpose, so the secret scan has nothing to match.
const FAKE_KEY = "x".repeat(20);
const CALL = {
  url: "https://model.example/v1/x",
  key: FAKE_KEY,
  body: "{}",
  timeoutMs: 5_000,
};
const UPSTREAM_TEXT = "upstream detail naming a person";

const answered: CallOutcome = {
  kind: "answered",
  status: "ok",
  httpStatus: 200,
  upstreamId: "resp_1",
  usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
  text: "hi",
  toolCalls: [],
  replay: [],
};

function respond(status: number, headers?: Record<string, string>) {
  const body = JSON.stringify({ error: { message: UPSTREAM_TEXT, type: "x", code: "y" } });
  return vi.fn<FetchFn>(async () => new Response(body, { status, headers }));
}

describe("post", () => {
  it("sends one POST with the bearer key, JSON, no redirects and a timeout signal", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => Response.json({ ok: true }));
    const parse = vi.fn(() => answered);
    expect(await post(fetchFn, CALL, parse)).toBe(answered);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(CALL.url);
    expect(init).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${CALL.key}`, "content-type": "application/json" },
      body: "{}",
      redirect: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(parse).toHaveBeenCalledWith({ ok: true }, 200);
  });

  it("maps every documented refusal to its category and releases it, never retrying", async () => {
    const cases: [number, string][] = [
      [400, "bad_request"],
      [401, "auth"],
      [402, "billing"],
      [404, "bad_request"],
      [413, "too_long"],
      [429, "rate_limited"],
    ];
    for (const [status, category] of cases) {
      const fetchFn = respond(status, status === 429 ? { "retry-after": "1" } : undefined);
      const parse = vi.fn(() => answered);
      const outcome = await post(fetchFn, CALL, parse);
      expect(outcome, String(status)).toEqual({ kind: "refused", category, httpStatus: status });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain(UPSTREAM_TEXT);
    }
  });

  it("keeps a 5xx and any other status unknown, because it may have been charged", async () => {
    const cases: [number, string][] = [
      [403, "auth"],
      [500, "unavailable"],
      [502, "unavailable"],
      [503, "unavailable"],
      [504, "timeout"],
      [418, "unknown"],
      [201, "unknown"],
    ];
    for (const [status, category] of cases) {
      const fetchFn = respond(status, status === 503 ? { "retry-after": "60" } : undefined);
      const outcome = await post(fetchFn, CALL, () => answered);
      expect(outcome, String(status)).toEqual({ kind: "unknown", category, httpStatus: status });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("treats a thrown fetch as unknown: timeout or network", async () => {
    const timedOut = vi.fn<FetchFn>(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await post(timedOut, CALL, () => answered)).toEqual({
      kind: "unknown",
      category: "timeout",
      httpStatus: null,
    });
    const offline = vi.fn<FetchFn>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await post(offline, CALL, () => answered)).toEqual({
      kind: "unknown",
      category: "network",
      httpStatus: null,
    });
  });

  it("aborts through the signal it passes when the timeout passes", async () => {
    // Never answers; only the call's own timeout signal ends it.
    const hangs = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    expect(await post(hangs, { ...CALL, timeoutMs: 1 }, () => answered)).toEqual({
      kind: "unknown",
      category: "timeout",
      httpStatus: null,
    });
  });

  it("treats a 200 that is not JSON as unknown", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => new Response("<html>", { status: 200 }));
    const parse = vi.fn(() => answered);
    expect(await post(fetchFn, CALL, parse)).toEqual({
      kind: "unknown",
      category: "unknown",
      httpStatus: 200,
    });
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("categoryForStatus", () => {
  it("covers the 5xx range and nothing past it", () => {
    expect(categoryForStatus(599)).toBe("unavailable");
    expect(categoryForStatus(600)).toBe("unknown");
    expect(categoryForStatus(302)).toBe("unknown");
  });
});

describe("usageFrom", () => {
  it("takes whole non-negative counts, defaulting only the details to zero", () => {
    expect(usageFrom(10, undefined, 5, null)).toEqual({
      input: 10,
      cached: 0,
      output: 5,
      reasoning: 0,
    });
    expect(usageFrom(10, 4, 5, 3)).toEqual({ input: 10, cached: 4, output: 5, reasoning: 3 });
  });

  it("refuses counts that are missing, negative, fractional, strings or do not add up", () => {
    const bad: unknown[][] = [
      [undefined, 0, 5, 0],
      [10, 0, undefined, 0],
      [-1, 0, 5, 0],
      [10, 0, 5.5, 0],
      ["10", 0, 5, 0],
      [10, 11, 5, 0],
      [10, 0, 5, 6],
      [2 ** 31, 0, 5, 0],
    ];
    for (const args of bad) {
      expect(usageFrom(args[0], args[1], args[2], args[3]), JSON.stringify(args)).toBeNull();
    }
  });
});

describe("upstreamIdFrom", () => {
  it("keeps a plain id and drops anything else", () => {
    expect(upstreamIdFrom("resp_abc-123")).toBe("resp_abc-123");
    expect(upstreamIdFrom("a".repeat(121))).toBeNull();
    expect(upstreamIdFrom("resp 1\nai: forged log line")).toBeNull();
    expect(upstreamIdFrom(42)).toBeNull();
    expect(upstreamIdFrom("")).toBeNull();
  });
});
