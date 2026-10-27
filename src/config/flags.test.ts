import { describe, expect, it } from "vitest";
import { isLocalDate } from "../lib/time/local-date";
import { flags } from "./flags";

describe("flags", () => {
  it("ships every outside effect dark", () => {
    expect(flags.aiEnabled).toBe(false);
    expect(flags.aiProofRoute).toBe(false);
    expect(flags.accountingEnabled).toBe(false);
    expect(flags.payoutsEnabled).toBe(false);
    expect(flags.inboundEmailEnabled).toBe(false);
    expect(flags.paymentProvider).toBe("mock");
    expect(flags.triageProvider).toBe("meta");
    expect(flags.agentEnabled).toBe(false);
    expect(flags.reportsEnabled).toBe(false);
    // Spark Open's standby host is dark until the owner turns it on in its own PR.
    expect(flags.sparkOpenFallback).toBe("off");
    expect(flags.detentionEnabled).toBe(false);
  });

  it("keeps the agent gateway's limits small and the screener on its probed output mode", () => {
    expect(flags.screenOutputMode).toBe("text");
    expect(flags.gatewayLimits).toEqual({
      payCorrectionMaxCents: 50_000,
      invoiceFixMaxCents: 250_000,
      detentionChargeMaxCents: 100_000,
    });
    for (const v of Object.values(flags.gatewayLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
  });

  it("caps every agent turn and keeps approval with people", () => {
    expect(flags.agentStreamMode).toBe("sse");
    expect(flags.agentTurnLimits).toEqual({
      maxToolSteps: 6,
      maxModelCalls: 4,
      maxTurnCents: 40,
      wallClockMs: 22_000,
      summaryChars: 10_000,
    });
    for (const v of Object.values(flags.agentTurnLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.agentTurnLimits.wallClockMs).toBeLessThan(30_000);
    expect(flags.proposalMaxAgeDays).toBe(7);
    expect(flags.auditorEnabled).toBe(false);
    expect(flags.auditorRequired).toBe(true);
    expect(Number.isNaN(Date.parse(flags.auditorStart))).toBe(false);
    expect(flags.approverRole).toEqual({ adminAboveCents: 200_000 });
  });

  it("ships tool search and the prompt cache off, with the default retention", () => {
    expect(flags.agentToolSearch).toBe(false);
    expect(flags.agentPromptCache).toEqual({ enabled: false, retention: "in_memory" });
  });

  it("keeps driver notes dark, with no email address allowed and small caps", () => {
    expect(flags.driverNotesEnabled).toBe(false);
    expect(flags.driverNotesEmailEnabled).toBe(false);
    expect(flags.driverNotesEmailAllowlist).toEqual([]);
    expect(flags.driverNotesEmailFrom).toBe("2026-10-27");
    expect(isLocalDate(flags.driverNotesEmailFrom)).toBe(true);
    expect(flags.driverNoteLimits).toEqual({ maxNoteCents: 3, maxBatchCents: 60, maxOutputTokens: 400 });
    for (const v of Object.values(flags.driverNoteLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.driverNoteLimits.maxNoteCents).toBeLessThan(flags.driverNoteLimits.maxBatchCents);
  });
});
