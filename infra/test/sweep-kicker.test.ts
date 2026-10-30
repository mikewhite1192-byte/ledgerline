import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The kicker with its two outside calls faked: Secrets Manager and fetch. Nothing leaves the
// machine.
const send = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { handler, readConfig } from "../lambda/sweep-kicker/index.mjs";

const TENANT = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const RUN = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const KEY = "k".repeat(48);
const ENV = {
  APP_URL: "https://main.example.amplifyapp.com",
  TENANT_IDS: TENANT,
  SECRET_ARN: "arn:aws:secretsmanager:us-east-2:000000000000:secret:example-AbCdEf",
};

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("sweep kicker", () => {
  const saved = { ...process.env };
  let logs: string[];
  const fetchMock = vi.fn();

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    vi.stubGlobal("fetch", fetchMock);
    send.mockReset();
    fetchMock.mockReset();
    send.mockResolvedValue({ SecretString: KEY });
    Object.assign(process.env, ENV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const k of Object.keys(ENV)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("reads a whole config, or none", () => {
    expect(readConfig(ENV)).toEqual({
      url: "https://main.example.amplifyapp.com/api/internal/sweep",
      tenants: [TENANT],
      secretArn: ENV.SECRET_ARN,
    });
    expect(readConfig({ ...ENV, APP_URL: "http://main.example.amplifyapp.com" })).toBeNull();
    expect(readConfig({ ...ENV, TENANT_IDS: "acme" })).toBeNull();
    expect(readConfig({ ...ENV, TENANT_IDS: "" })).toBeNull();
    expect(readConfig({ ...ENV, SECRET_ARN: "" })).toBeNull();
    expect(readConfig(ENV, "desk")).toEqual({
      url: "https://main.example.amplifyapp.com/api/internal/desk",
      tenants: [TENANT],
      secretArn: ENV.SECRET_ARN,
    });
  });

  it("calls nothing when it is not configured", async () => {
    delete process.env.APP_URL;
    await expect(handler({}, undefined)).resolves.toEqual({ ok: false, category: "not_configured" });
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts, carries the run on until it is done, and never logs the key", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(200, { runId: RUN, existing: false }))
      .mockResolvedValueOnce(answer(200, { runId: RUN, status: "running" }))
      .mockResolvedValueOnce(answer(200, { runId: RUN, status: "done" }));
    const out = await handler({}, { getRemainingTimeInMillis: () => 290_000 });
    expect(out).toEqual({ ok: true, outcomes: { [TENANT]: "done" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://main.example.amplifyapp.com/api/internal/sweep");
    expect(init.headers["x-sweep-key"]).toBe(KEY);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ action: "advance", tenantId: TENANT, runId: RUN });
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs[0]).toBe(`sweep kicker start tenant=${TENANT} http=200 run=${RUN} status=- error=-`);
  });

  it("waits and retries while another slice holds the run, and stops on a refusal", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(answer(200, { runId: RUN, existing: true }))
        .mockResolvedValueOnce(answer(409, { error: "busy", retryable: true }))
        .mockResolvedValueOnce(answer(409, { error: "schedule_off", retryable: false }));
      const run = handler({}, { getRemainingTimeInMillis: () => 290_000 });
      await vi.runAllTimersAsync();
      await expect(run).resolves.toEqual({ ok: false, outcomes: { [TENANT]: "stopped" } });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the run to the page when time runs short, and skips a run that did not start", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { runId: RUN, existing: false }));
    await expect(handler({}, { getRemainingTimeInMillis: () => 10_000 })).resolves.toEqual({
      ok: false,
      outcomes: { [TENANT]: "left_running" },
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(answer(503, { error: "not_configured", retryable: true }));
    await expect(handler({}, undefined)).resolves.toEqual({ ok: false, outcomes: { [TENANT]: "not_started" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a key of the wrong shape and logs only the error's name", async () => {
    send.mockResolvedValue({ SecretString: "short" });
    await expect(handler({}, undefined)).resolves.toEqual({ ok: false, category: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toEqual(["sweep kicker could not read its key: Error"]);
  });
  describe("the desk job", () => {
    const WAKE = "7c2d0e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";

    it("wakes each carrier's desk loop while the app says work is left, and never logs the key", async () => {
      fetchMock
        .mockResolvedValueOnce(answer(200, { wakeId: WAKE, status: "more", reason: "events_per_wake" }))
        .mockResolvedValueOnce(answer(200, { wakeId: WAKE, status: "done", reason: "no_work" }));
      const out = await handler({ job: "desk" }, { getRemainingTimeInMillis: () => 290_000 });
      expect(out).toEqual({ ok: true, outcomes: { [TENANT]: "done" } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://main.example.amplifyapp.com/api/internal/desk");
      expect(init.headers["x-sweep-key"]).toBe(KEY);
      expect(init.redirect).toBe("error");
      expect(JSON.parse(init.body)).toEqual({ action: "wake", tenantId: TENANT });
      expect(logs.join("\n")).not.toContain(KEY);
      expect(logs[0]).toBe(`desk kicker wake tenant=${TENANT} http=200 wake=${WAKE} status=more`);
      expect(logs[1]).toBe(`desk kicker wake tenant=${TENANT} http=200 wake=${WAKE} status=done`);
      expect(logs[2]).toBe("desk kicker finished: done");
    });

    it("waits while another wake holds the loop or the answer is unknown, and stops on a refusal", async () => {
      vi.useFakeTimers();
      try {
        fetchMock
          .mockResolvedValueOnce(answer(200, { wakeId: WAKE, status: "busy" }))
          .mockRejectedValueOnce(new TypeError("network"))
          .mockResolvedValueOnce(answer(503, { error: "unavailable", retryable: true }))
          .mockResolvedValueOnce(answer(409, { error: "disabled", retryable: false }));
        const run = handler({ job: "desk" }, { getRemainingTimeInMillis: () => 290_000 });
        await vi.runAllTimersAsync();
        await expect(run).resolves.toEqual({ ok: false, outcomes: { [TENANT]: "stopped" } });
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(logs[1]).toBe(`desk kicker wake tenant=${TENANT} http=0 wake=- status=- failure=TypeError`);
        expect(logs[3]).toBe(`desk kicker wake tenant=${TENANT} http=409 wake=- status=- error=disabled`);
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits longer than the desk route's 30 s limit for a wake, keeps room for that wait, and leaves the sweep's call as it was", async () => {
      const timeouts = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
      fetchMock.mockResolvedValueOnce(answer(200, { wakeId: WAKE, status: "done" }));
      await expect(handler({ job: "desk" }, { getRemainingTimeInMillis: () => 290_000 })).resolves.toEqual({
        ok: true,
        outcomes: { [TENANT]: "done" },
      });
      expect(timeouts.mock.calls).toEqual([[35_000]]);
      // 38 s left is short of one more desk call and its margin, but not of a sweep call.
      timeouts.mockClear();
      fetchMock.mockReset();
      await expect(handler({ job: "desk" }, { getRemainingTimeInMillis: () => 38_000 })).resolves.toEqual({
        ok: false,
        outcomes: { [TENANT]: "left_open" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock
        .mockResolvedValueOnce(answer(200, { runId: RUN, existing: false }))
        .mockResolvedValueOnce(answer(200, { runId: RUN, status: "done" }));
      await expect(handler({}, { getRemainingTimeInMillis: () => 38_000 })).resolves.toEqual({
        ok: true,
        outcomes: { [TENANT]: "done" },
      });
      expect(timeouts.mock.calls).toEqual([[25_000], [25_000]]);
    });

    it("stops after twelve wakes or when time runs short, leaving the rest to the next tick", async () => {
      fetchMock.mockImplementation(async () => answer(200, { wakeId: WAKE, status: "more" }));
      await expect(handler({ job: "desk" }, { getRemainingTimeInMillis: () => 290_000 })).resolves.toEqual({
        ok: false,
        outcomes: { [TENANT]: "left_open" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(12);
      fetchMock.mockClear();
      await expect(handler({ job: "desk" }, { getRemainingTimeInMillis: () => 10_000 })).resolves.toEqual({
        ok: false,
        outcomes: { [TENANT]: "left_open" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("calls nothing when it is not configured, and any other event is the sweep", async () => {
      delete process.env.TENANT_IDS;
      await expect(handler({ job: "desk" }, undefined)).resolves.toEqual({ ok: false, category: "not_configured" });
      expect(logs).toEqual(["desk kicker not configured: APP_URL, TENANT_IDS or SECRET_ARN is missing or invalid"]);
      expect(fetchMock).not.toHaveBeenCalled();
      process.env.TENANT_IDS = TENANT;
      fetchMock.mockResolvedValueOnce(answer(503, { error: "not_configured", retryable: true }));
      await expect(handler({ job: "fuel" }, undefined)).resolves.toEqual({ ok: false, outcomes: { [TENANT]: "not_started" } });
      expect(fetchMock.mock.calls[0][0]).toBe("https://main.example.amplifyapp.com/api/internal/sweep");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "start", tenantId: TENANT });
    });
  });
});
