import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { GET } from "./route";

const shipped = structuredClone(flags);

// Every switch the health check reads, off: each test states the switches it needs.
function switchesOff() {
  Object.assign(flags, {
    aiEnabled: false,
    agentEnabled: false,
    auditorEnabled: false,
    reportsEnabled: false,
    driverNotesEnabled: false,
    advancesEnabled: false,
    payoutsEnabled: false,
    accountingEnabled: false,
  });
}

afterEach(() => {
  Object.assign(flags, structuredClone(shipped));
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("reports the build's commit and every feature off while its switches are off", async () => {
    switchesOff();
    vi.stubEnv("APP_COMMIT", "abc1234");
    const body = await GET().json();
    expect(body).toEqual({
      ok: true,
      version: "abc1234",
      features: {
        agent: false,
        auditor: false,
        reports: false,
        driverNotes: false,
        advances: false,
        payouts: false,
        accounting: false,
      },
    });
  });

  it("reports a feature on only when a visitor can use it", async () => {
    switchesOff();
    flags.agentEnabled = true;
    flags.auditorEnabled = true;
    flags.reportsEnabled = true;
    // The agent, its auditor and its reports all need the models.
    expect((await GET().json()).features).toMatchObject({ agent: false, auditor: false, reports: false });
    flags.aiEnabled = true;
    flags.advancesEnabled = true;
    flags.payoutsEnabled = true;
    flags.accountingEnabled = true;
    flags.driverNotesEnabled = true;
    expect((await GET().json()).features).toEqual({
      agent: true,
      auditor: true,
      reports: true,
      driverNotes: true,
      advances: true,
      payouts: true,
      accounting: true,
    });
  });

  it("holds only booleans and the version, never a cap, a key or an environment value", async () => {
    vi.stubEnv("META_API_KEY", "test-key-abcdefghijklmnop");
    const text = JSON.stringify(await GET().json());
    expect(text).not.toContain("test-key");
    expect(Object.values((await GET().json()).features).every((v) => typeof v === "boolean")).toBe(true);
  });
});
