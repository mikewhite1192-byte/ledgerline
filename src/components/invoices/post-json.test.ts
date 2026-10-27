import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "./post-json";

function answer(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postJson", () => {
  it("holds a request that throws as unknown, never as did not go through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    expect(await postJson("/x", { a: 1 })).toEqual({ ok: false, error: "unknown", data: {} });
  });

  it("holds a server error with no readable category as unknown", async () => {
    answer(502, "<html>bad gateway</html>");
    expect(await postJson("/x")).toEqual({ ok: false, error: "unknown", data: {} });
  });

  it("holds a success whose reply cannot be read as unknown", async () => {
    answer(200, "");
    expect(await postJson("/x")).toEqual({ ok: true, error: "unknown", data: {} });
  });

  it("calls any other refusal with no readable category unavailable", async () => {
    answer(404, "not json");
    expect(await postJson("/x")).toEqual({ ok: false, error: "unavailable", data: {} });
  });

  it("passes the server's own category through, and none on a readable success", async () => {
    answer(409, JSON.stringify({ error: "stale" }));
    expect((await postJson("/x")).error).toBe("stale");
    answer(503, JSON.stringify({ error: "unavailable", retryable: true }));
    expect((await postJson("/x")).error).toBe("unavailable");
    answer(200, JSON.stringify({ paymentId: "p1" }));
    expect(await postJson("/x")).toEqual({ ok: true, error: null, data: { paymentId: "p1" } });
  });
});
