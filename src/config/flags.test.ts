import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalDate } from "../lib/time/local-date";
import { flags, type Flags } from "./flags";
import { applyLocalOverrides, LOCAL_OVERRIDABLE } from "./local-overrides";

describe("flags", () => {
  it("ships every outside effect dark", () => {
    expect(flags.aiEnabled).toBe(false);
    expect(flags.aiProofRoute).toBe(false);
    expect(flags.accountingEnabled).toBe(false);
    expect(flags.payoutsEnabled).toBe(false);
    expect(flags.inboundEmailEnabled).toBe(false);
    expect(flags.paymentProvider).toBe("mock");
    // Driver messages are sorted by Muse Spark Open, the open-weights model, unless the owner flips it.
    expect(flags.triageProvider).toBe("baseten");
    expect(flags.inboxEnabled).toBe(false);
    expect(flags.agentEnabled).toBe(false);
    expect(flags.documentsEnabled).toBe(false);
    expect(flags.documentCrop).toBe(false);
    expect(flags.reportsEnabled).toBe(false);
    // Spark Open's standby host is dark until the owner turns it on in its own PR.
    expect(flags.sparkOpenFallback).toBe("off");
    expect(flags.clipsEnabled).toBe(false);
    expect(flags.detentionEnabled).toBe(false);
    // The demo reset page deletes and rewrites a carrier's rows: dark until the owner's go.
    expect(flags.demoResetEnabled).toBe(false);
    expect(flags.rulesByTalkingEnabled).toBe(false);
    expect(flags.fuelAnomalyEnabled).toBe(false);
  });

  it("starts fuel checks on a fixed date and keeps the receipt compare and corrections small", () => {
    expect(flags.fuelAnomalyLimits).toEqual({
      from: "2026-10-27",
      duplicateWindowMinutes: 60,
      chargebackMaxCents: 50_000,
      compareMaxCostCents: 5,
      compareMaxOutputTokens: 200,
      comparesPerRun: 10,
      comparesPerTenantPerDay: 20,
    });
    expect(isLocalDate(flags.fuelAnomalyLimits.from)).toBe(true);
    // A suggested correction the page offers is one the gateway would also accept.
    expect(flags.fuelAnomalyLimits.chargebackMaxCents).toBeLessThanOrEqual(
      flags.gatewayLimits.payCorrectionMaxCents,
    );
  });

  it("tells the release PR beside the fuel start date to move it to go-live with the switch", () => {
    // The start date is production posture, and the switch alone does not keep older fill-ups off
    // the first run: the note beside the date is the release PR's instruction.
    const src = readFileSync(join(__dirname, "flags.ts"), "utf8");
    const at = src.indexOf("fuelAnomalyLimits: {");
    const note = src.slice(at, src.indexOf("from: string;", at)).replace(/\s*\/\/\s*/g, " ");
    expect(note).toContain("The release PR that turns fuelAnomalyEnabled on also sets this to its go-live date");
    expect(note).not.toMatch(/switching on never/);
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
      ruleChangeImpactMaxCents: 500_000,
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

  it("ships the advance take-back off, with a whole-cent cap", () => {
    expect(flags.advanceTakeback).toEqual({ enabled: false, maxCents: 100_000 });
    expect(Number.isSafeInteger(flags.advanceTakeback.maxCents)).toBe(true);
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

  it("keeps collections dark, with no email address allowed, no send date and small caps", () => {
    expect(flags.collectionsEnabled).toBe(false);
    expect(flags.collectionsEmailEnabled).toBe(false);
    expect(flags.collectionsEmailAllowlist).toEqual([]);
    // Not a whole date, so every email is refused until a release PR sets one.
    expect(flags.collectionsEmailFrom).toBe("");
    expect(isLocalDate(flags.collectionsEmailFrom)).toBe(false);
    expect(flags.collectionsLimits).toEqual({
      maxDraftCents: 2,
      maxRunCents: 40,
      maxOutputTokens: 500,
      maxDraftsPerRun: 12,
      minDaysLate: 30,
    });
    for (const v of Object.values(flags.collectionsLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.collectionsLimits.maxDraftCents).toBeLessThan(flags.collectionsLimits.maxRunCents);
    // A local override can never turn collections on: its tool is not on the recorded demo path.
    for (const key of ["collectionsEnabled", "collectionsEmailEnabled"]) {
      expect((LOCAL_OVERRIDABLE as readonly string[]).includes(key)).toBe(false);
    }
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

  it("ships Cash Friday dark, with its explanation and option counts capped", () => {
    expect(flags.cashFridayEnabled).toBe(false);
    expect(flags.cashFridayLimits).toEqual({
      maxExplainCents: 8,
      maxExplainChars: 600,
      maxFactorInvoices: 3,
      maxChaseCustomers: 2,
      graceDays: 14,
      factoringMaxAgeDays: 45,
    });
    for (const v of Object.values(flags.cashFridayLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // The explanation fits the cash_checks.explanation CHECK in migration 0029.
    expect(flags.cashFridayLimits.maxExplainChars).toBeLessThanOrEqual(600);
  });

  it("keeps the sweep's second opinion off, with every cap inside the run's own", () => {
    expect(flags.fanoutEnabled).toBe(false);
    const l = flags.fanoutLimits;
    expect(l).toEqual({
      maxDrivers: 30,
      parallel: 6,
      maxCallsPerDriver: 3,
      maxToolSteps: 4,
      callCents: 3,
      driverCents: 9,
      planCents: 12,
      reconcileCents: 12,
      childTimeoutMs: 15_000,
      tenantDayCents: 1_000,
      runsPerTenantDay: 3,
      runCapCents: 450,
    });
    // A driver's calls fit its own cap, and the sweep's own spend still fits inside the run's.
    expect(l.callCents * l.maxCallsPerDriver).toBeLessThanOrEqual(l.driverCents);
    expect(l.runCapCents).toBeGreaterThan(flags.sweepLimits.maxRunCents);
    // A whole check ends well inside one slice.
    expect(l.childTimeoutMs).toBeLessThan(flags.sweepLimits.sliceMs);
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

  it("ships the Inbox dark, with its daily count, message size and sorting tries capped", () => {
    expect(flags.inboxEnabled).toBe(false);
    expect(flags.inboxLimits).toEqual({ messagesPerDay: 50, maxChars: 20_000, maxAttempts: 3 });
    for (const v of Object.values(flags.inboxLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // The attempts CHECK in migration 0037 holds 0 to 3.
    expect(flags.inboxLimits.maxAttempts).toBeLessThanOrEqual(3);
  });

  it("stops any one model job at $10 in an hour", () => {
    expect(flags.aiJobHourlyCapCents).toBe(1000);
    expect(Number.isSafeInteger(flags.aiJobHourlyCapCents)).toBe(true);
  });

  it("ships the pay run and batch approval dark, with small caps and a start date", () => {
    expect(flags.settlementsEnabled).toBe(false);
    expect(flags.batchApproveEnabled).toBe(false);
    expect(flags.settlementsStart).toBe("2026-10-05");
    expect(flags.settlementLimits).toEqual({
      driversPerRun: 200,
      maxPayoutAttempts: 3,
      legTwoMinRemainingMs: 12_000,
    });
    expect(flags.batchLimits).toEqual({ maxItems: 50, maxTotalCents: 10_000_000, drainBudgetMs: 22_000 });
    for (const v of [...Object.values(flags.settlementLimits), ...Object.values(flags.batchLimits)]) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // The batch cap fits approval_batches.total_cents.
    expect(flags.batchLimits.maxTotalCents).toBeLessThan(1_000_000_000);
  });

  it("ships the profit brief dark, at most 6 cents a brief, and never switched on by local mode", () => {
    expect(flags.profitBriefEnabled).toBe(false);
    expect(flags.profitBriefLimits).toEqual({ maxBriefCents: 6, maxOutputTokens: 700, maxLanes: 10, maxCustomers: 12 });
    for (const v of Object.values(flags.profitBriefLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("profitBriefEnabled");
  });
});

describe("local overrides for the demo-path test", () => {
  const ARN = "arn:aws:rds:us-east-2:000000000000:cluster:example";
  const ALL_ON = JSON.stringify(Object.fromEntries(LOCAL_OVERRIDABLE.map((k) => [k, true])));
  let logged: string[];
  const copy = (): Flags => structuredClone(flags);

  beforeEach(() => {
    logged = [];
    const record = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves the shipped switches alone when nothing is set, as under test", () => {
    const target = copy();
    expect(applyLocalOverrides(target, { NODE_ENV: "development" })).toEqual([]);
    expect(applyLocalOverrides(target, { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: "" })).toEqual([]);
    expect(target).toEqual(flags);
    expect(logged).toEqual([]);
  });

  it("in local mode, turns on the allowlisted switches and nothing else", () => {
    const target = copy();
    const keys = applyLocalOverrides(target, { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: ALL_ON });
    expect(keys).toEqual([...LOCAL_OVERRIDABLE]);
    expect(target.aiEnabled && target.agentEnabled && target.auditorEnabled).toBe(true);
    expect(target.reportsEnabled && target.driverNotesEnabled && target.inboxEnabled).toBe(true);
    expect(target.advancesEnabled && target.payoutsEnabled && target.advancePayouts.armed).toBe(true);
    // Everything else, every cap and limit among it, is exactly as shipped.
    expect({ ...target, advancePayouts: { ...target.advancePayouts, armed: false } }).toEqual({
      ...flags,
      aiEnabled: true,
      agentEnabled: true,
      auditorEnabled: true,
      reportsEnabled: true,
      driverNotesEnabled: true,
      inboxEnabled: true,
      advancesEnabled: true,
      payoutsEnabled: true,
    });
    expect(target.advancePayouts.capCents).toBe(flags.advancePayouts.capCents);
    expect(target.advancePayouts.startDate).toBe(flags.advancePayouts.startDate);
  });

  it("is ignored in a production build", () => {
    const target = copy();
    expect(applyLocalOverrides(target, { NODE_ENV: "production", FLAGS_LOCAL_OVERRIDES: ALL_ON })).toEqual([]);
    expect(target).toEqual(flags);
    expect(logged).toEqual(["flags: FLAGS_LOCAL_OVERRIDES ignored outside local mode"]);
  });

  it("is ignored when NODE_ENV is unset or not exactly development or test, even off Aurora", () => {
    const envs: Record<string, string>[] = [
      { FLAGS_LOCAL_OVERRIDES: ALL_ON },
      { DB_CLUSTER_ARN: "", FLAGS_LOCAL_OVERRIDES: ALL_ON },
      ...["", "staging", "preview", "Development", "production"].map((NODE_ENV) => ({
        NODE_ENV,
        DB_CLUSTER_ARN: "",
        FLAGS_LOCAL_OVERRIDES: ALL_ON,
      })),
    ];
    for (const env of envs) {
      logged = [];
      const target = copy();
      expect(applyLocalOverrides(target, env), JSON.stringify(env.NODE_ENV)).toEqual([]);
      expect(target).toEqual(flags);
      expect(logged).toEqual(["flags: FLAGS_LOCAL_OVERRIDES ignored outside local mode"]);
    }
  });

  it("is ignored whenever an Aurora cluster is configured", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const target = copy();
      const env = { NODE_ENV, DB_CLUSTER_ARN: ARN, FLAGS_LOCAL_OVERRIDES: ALL_ON };
      expect(applyLocalOverrides(target, env)).toEqual([]);
      expect(target).toEqual(flags);
    }
  });

  it("never overrides a cap, a limit, a date or a provider, and then changes nothing at all", () => {
    for (const bad of [
      { agentTurnLimits: { maxTurnCents: 100_000 } },
      { "agentTurnLimits.maxTurnCents": 100_000 },
      { "advancePayouts.capCents": 10_000_000 },
      { advancePayouts: { armed: true, capCents: 10_000_000, startDate: "2020-01-01" } },
      { "advancePayouts.startDate": "2020-01-01" },
      { "inboxLimits.messagesPerDay": 1000 },
      { gatewayLimits: { payCorrectionMaxCents: 1, invoiceFixMaxCents: 1 } },
      { approverRole: { adminAboveCents: 1 } },
      { driverNoteLimits: { maxNoteCents: 1000, maxBatchCents: 1000, maxOutputTokens: 1 } },
      { advancesLimits: { proposalsPerDay: 1000 } },
      { paymentProvider: "stripe" },
      { triageProvider: "meta" },
      { auditorStart: "2020-01-01T00:00:00Z" },
      { accountingEnabled: true },
      { driverNotesEmailEnabled: true },
      { agentEnabled: true, "agentTurnLimits.maxToolSteps": 99 },
      // Not on the demo path yet: adding it is detention's own change, with a re-recorded replay.
      { detentionEnabled: true },
    ]) {
      const target = copy();
      const env = { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: JSON.stringify(bad) };
      expect(applyLocalOverrides(target, env), JSON.stringify(bad)).toEqual([]);
      expect(target, JSON.stringify(bad)).toEqual(flags);
    }
  });

  it("changes nothing for a value that is not JSON, not an object or not a boolean", () => {
    for (const raw of ["{agentEnabled:true}", "[]", "true", "null", '{"agentEnabled":"true"}', '{"agentEnabled":1}']) {
      const target = copy();
      expect(applyLocalOverrides(target, { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: raw }), raw).toEqual([]);
      expect(target, raw).toEqual(flags);
    }
    expect(logged).toHaveLength(6);
  });
});
