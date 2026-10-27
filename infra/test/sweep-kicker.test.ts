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
});
