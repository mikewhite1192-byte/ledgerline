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
    expect(flags.documentsEnabled).toBe(false);
    expect(flags.documentCrop).toBe(false);
    expect(flags.reportsEnabled).toBe(false);
    // Spark Open's standby host is dark until the owner turns it on in its own PR.
    expect(flags.sparkOpenFallback).toBe("off");
    expect(flags.clipsEnabled).toBe(false);
    expect(flags.detentionEnabled).toBe(false);
  });

  it("caps dock clips at the header reader's limits and keeps their model calls small", () => {
    expect(flags.clipLimits).toEqual({
      bytes: 700_000,
      durationMs: 20_000,
      frames: 600,
      redactMaxCostCents: 13,
      readMaxCostCents: 10,
      perTenantPerDay: 20,
    });
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

  it("keeps document uploads small, few and cheap to read", () => {
    expect(flags.documentLimits).toEqual({
      maxBytes: 700_000,
      maxPdfPages: 3,
      readMaxCostCents: 8,
      perTenantPerDay: 20,
    });
    for (const v of Object.values(flags.documentLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
  });

  it("ships the advance flow dark, disarmed, capped and dated", () => {
    expect(flags.advancesEnabled).toBe(false);
    expect(flags.advancePayouts).toEqual({ armed: false, capCents: 50_000, startDate: "2026-10-27" });
    expect(isLocalDate(flags.advancePayouts.startDate)).toBe(true);
    expect(flags.advancesLimits).toEqual({
      proposalsPerDay: 30,
      maxPayoutAttempts: 3,
      legTwoMinRemainingMs: 12_000,
    });
    for (const v of [flags.advancePayouts.capCents, ...Object.values(flags.advancesLimits)]) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
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

  it("keeps the sweep off, its schedule off, its fixes unable to run and its caps small", () => {
    expect(flags.sweepEnabled).toBe(false);
    expect(flags.sweepScheduleEnabled).toBe(false);
    expect(flags.payCorrectionsEnabled).toBe(false);
    expect(flags.sweepLimits).toEqual({
      maxItems: 40,
      maxRunCents: 150,
      maxExplainCents: 5,
      sliceMs: 20_000,
      maxAuditAttempts: 3,
    });
    // One slice answers inside the 30 second route limit with room for the last write.
    expect(flags.sweepLimits.sliceMs).toBeLessThan(25_000);
    expect(flags.approveAllLimits).toEqual({ maxItems: 25 });
  });

  it("ships invoicing and customer payments dark, with small caps and a start date", () => {
    expect(flags.invoicesEnabled).toBe(false);
    expect(flags.customerPaymentsEnabled).toBe(false);
    expect(flags.invoiceReviewEnabled).toBe(false);
    expect(flags.invoicesStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(flags.invoicesStart).toBe("2026-10-05");
    expect(flags.invoiceLimits).toEqual({ proposalsPerRun: 50, maxPostAttempts: 3 });
    expect(flags.customerPaymentLimits).toEqual({ perDay: 50, maxCents: 5_000_000 });
    for (const v of [...Object.values(flags.invoiceLimits), ...Object.values(flags.customerPaymentLimits)]) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
  });

  it("ships the portal runner dark, on Muse Spark, with every run capped", () => {
    expect(flags.portalRunnerEnabled).toBe(false);
    expect(flags.portalRunnerModel).toBe("spark");
    expect(flags.portalRunLimits).toEqual({
      maxSteps: 15,
      maxWallMs: 240_000,
      maxRunCents: 150,
      maxCallCents: 25,
      maxActionsPerStep: 8,
      screenshotMaxBytes: 400_000,
      podMaxBytes: 300_000,
      approvalWaitMinutes: 30,
    });
    for (const v of Object.values(flags.portalRunLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.portalRunLimits.maxCallCents).toBeLessThanOrEqual(flags.portalRunLimits.maxRunCents);
  });

  it("ships voice intake dark, with its upload sizes and daily count capped", () => {
    expect(flags.voiceIntakeEnabled).toBe(false);
    expect(flags.voiceLimits).toEqual({
      maxWavBytes: 2_000_000,
      maxOriginalBytes: 700_000,
      maxDurationMs: 60_000,
      voiceNotesPerDay: 20,
    });
    for (const v of Object.values(flags.voiceLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // One stored recording reads back under the Data API's 1 MiB answer limit.
    expect(Math.ceil(flags.voiceLimits.maxOriginalBytes / 3) * 4).toBeLessThan(1_048_576);
    // The longest clip fits the WAV cap (16 kHz 16-bit mono is 32 bytes a millisecond after the
    // 44-byte header), so the duration check is the one that binds.
    expect(flags.voiceLimits.maxDurationMs).toBeLessThanOrEqual(Math.floor((flags.voiceLimits.maxWavBytes - 44) / 32));
  });

  it("stops any one model job at $10 in an hour", () => {
    expect(flags.aiJobHourlyCapCents).toBe(1000);
    expect(Number.isSafeInteger(flags.aiJobHourlyCapCents)).toBe(true);
  });
});
