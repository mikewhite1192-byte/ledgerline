import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTestKey } from "../lib/adapters/payment/stripe-test";
import { assertMoneyEnvSafe, MoneyEnvRefused } from "../lib/money/guard";
import { payoutSwitchOn } from "../lib/money/ledger";
import { DEMO_CARRIERS } from "../lib/seed/carriers";
import { isLocalDate } from "../lib/time/local-date";
import { flags, stepThroughShown, type Flags } from "./flags";
import { LOCAL_SWITCHES } from "../../e2e/env.local-mode";
import { applyLocalOverrides, LOCAL_OFF_ONLY, LOCAL_OVERRIDABLE } from "./local-overrides";

// Keys are put together at run time so no scanner reads a key shape in this file.
const key = (...parts: string[]) => parts.join("_");
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

// Every on/off switch in flags.ts, by path, as the release sets it for the demo carriers.
const RELEASED_ON = [
  "aiEnabled",
  "payoutsEnabled",
  "accountingEnabled",
  "agentEnabled",
  "auditorEnabled",
  "documentsEnabled",
  "advancesEnabled",
  "advanceTakeback.enabled",
  "agentToolSearch",
  "agentPromptCache.enabled",
  "driverNotesEnabled",
  "reportsEnabled",
  "invoicesEnabled",
  "customerPaymentsEnabled",
  "clipsEnabled",
  "inboxEnabled",
  "voiceIntakeEnabled",
  "detentionEnabled",
  "demoResetEnabled",
  "rulesByTalkingEnabled",
  "sweepEnabled",
  "payCorrectionsEnabled",
  "fanoutEnabled",
  "cashFridayEnabled",
  "settlementsEnabled",
  "batchApproveEnabled",
  "invoiceReviewEnabled",
  "collectionsEnabled",
  "profitBriefEnabled",
  "carrierMemoryEnabled",
  "fuelAnomalyEnabled",
  // Writes no money and only reads QuickBooks; its reads and model cents are capped below.
  "cardRecon.enabled",
  // Every finished feature, on for the owner's walk-through (D-056, 2026-10-30). Payments stay in
  // Stripe test mode and accounting in the QuickBooks sandbox; every cap is as it was. Each switch
  // that lets money move is armed in a one-line PR of its own.
  "inboundEmailEnabled",
  "documentCrop",
  "documentMarkupEnabled",
  "sweepScheduleEnabled",
  "advancePayouts.armed",
  "moneyCodes.enabled",
  "moneyCodes.armed",
  "quarterReviewEnabled",
  "iftaEnabled",
  "yearEndEnabled",
  "trustMeterEnabled",
  "stepThrough.staff",
  "judgeAccess.enabled",
  "policyOnboardEnabled",
  "factoring.enabled",
  "groundedRatesEnabled",
  "payCardsEnabled",
  "verification.enabled",
  "evalCardEnabled",
  "deskLoop.enabled",
  "ratecon.enabled",
  "phoneLineEnabled",
  "escrowRelease.enabled",
] as const;

// What stays off, each waiting on a missing piece or an outside send the owner has not released.
const KEPT_OFF = [
  // On only to prove a deploy.
  "aiProofRoute",
  // Outside sends: the pages show "would send" lines instead.
  "driverNotesEmailEnabled",
  "collectionsEmailEnabled",
  // No runner is wired on the hosted site: the page's only action would always refuse.
  "portalRunnerEnabled",
  // Off until the owner asks for the rate confirmation, bill of lading and POD on every approval.
  "factoring.requirePacket",
  // The eval script spends model cents on the developer's ledger; the owner turns it on in its own PR.
  "evalRun.enabled",
  // Factoring, the desk loop and escrow releases ship on and unarmed: each arming is the owner's
  // call, in its own one-line PR.
  "factoring.armed",
  "deskLoop.armed",
  "escrowRelease.armed",
] as const;

// The on/off switches in flags.ts, by path: every top-level boolean and every boolean inside a
// switch object, so a switch added later is caught by the tests below.
function booleanSwitches(f: Flags): [string, boolean][] {
  const out: [string, boolean][] = [];
  for (const [name, value] of Object.entries(f)) {
    if (typeof value === "boolean") out.push([name, value]);
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [inner, v] of Object.entries(value)) if (typeof v === "boolean") out.push([`${name}.${inner}`, v]);
    }
  }
  return out;
}

describe("flags", () => {
  it("releases every finished feature for the demo carriers, and nothing else", () => {
    const switches = Object.fromEntries(booleanSwitches(flags));
    for (const name of RELEASED_ON) expect(switches[name], name).toBe(true);
    for (const name of KEPT_OFF) expect(switches[name], name).toBe(false);
    // auditorRequired ships on with the auditor: a proposal waits for its verdict, and
    // verifyEngineMismatchBlocks ships on with the pay rules check: a mismatch waits for a person.
    // Step through ships on for development and test runs, as it merged; the release does not set
    // dev.
    expect(Object.keys(switches).sort()).toEqual(
      [...RELEASED_ON, ...KEPT_OFF, "auditorRequired", "verifyEngineMismatchBlocks", "stepThrough.dev"].sort(),
    );
    expect(flags.auditorRequired).toBe(true);
    expect(flags.verifyEngineMismatchBlocks).toBe(true);
    expect(flags.advancePayouts.armed).toBe(true);
    expect(flags.stepThrough.dev).toBe(true);
  });

  it("keeps the email sends, the proof route and the standby host off, and the test-mode writes capped", () => {
    expect(flags.aiProofRoute).toBe(false);
    expect(flags.inboundEmailEnabled).toBe(true);
    expect(flags.documentCrop).toBe(true);
    expect(flags.documentMarkupEnabled).toBe(true);
    // Money codes issue through the simulated provider only, released with their cap and date kept.
    expect(flags.moneyCodes).toEqual({
      enabled: true,
      armed: true,
      capCents: 50_000,
      perDriverPerDay: 2,
      startDate: "2026-10-28",
    });
    expect(isLocalDate(flags.moneyCodes.startDate)).toBe(true);
    expect(flags.driverNotesEmailEnabled).toBe(false);
    expect(flags.collectionsEmailEnabled).toBe(false);
    expect(flags.sweepScheduleEnabled).toBe(true);
    // Pay rules from a policy document: two Muse Spark calls a run and a new version on approval.
    expect(flags.policyOnboardEnabled).toBe(true);
    // Spark Open's standby host stays dark: Baseten serves screening and sorting alone.
    expect(flags.sparkOpenFallback).toBe("off");
    // Driver messages and voice notes are sorted by Muse Spark Open, the open-weights model.
    expect(flags.triageProvider).toBe("baseten");
    // The desk loop hands work to the agents on its own, each under its own switch and caps, once
    // the owner arms it.
    expect(flags.deskLoop.enabled).toBe(true);
    expect(flags.deskLoop.armed).toBe(false);
    // The demo visitor sign-in, inside the visit limits below.
    expect(flags.judgeAccess.enabled).toBe(true);
    // Factoring submits to the simulated partner only, released unarmed with its cap, packet rule and
    // date kept.
    expect(flags.factoring).toEqual({
      enabled: true,
      armed: false,
      maxNetCents: 2_500_000,
      requirePacket: false,
      startDate: "2026-10-28",
    });
    expect(isLocalDate(flags.factoring.startDate)).toBe(true);
    // The models page's eval card and the eval script that spends model cents.
    expect(flags.evalCardEnabled).toBe(true);
    expect(flags.evalRun).toEqual({ enabled: false, maxRunCents: 1_500, reserveCents: 4_000 });
    expect(flags.groundedRatesEnabled).toBe(true);
  });

  it("keeps a rate lookup small and its switch out of the local overrides", () => {
    expect(flags.ratesLimits).toEqual({ lookupMaxCostCents: 5, lookupsPerTenantPerDay: 20, maxSearchCalls: 2 });
    // The demo path turns every local override on; the read tool must stay out of its tool list.
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("groundedRatesEnabled");
  });

  it("keeps a demo visit small: a dollar of model time, 25 turns, $8.00 a day across every visit", () => {
    expect(flags.judgeAccess).toEqual({
      enabled: true,
      sessionCapCents: 100,
      turnsPerSession: 25,
      dayCapCents: 800,
      sessionsPerIpPerHour: 5,
      sessionsPerHour: 40,
      sessionsPerDay: 150,
      cookieHours: 2,
    });
    // Five judging days at the day cap fit the $40.00 reserve with nothing else drawing on it.
    expect(flags.judgeAccess.dayCapCents * 5).toBeLessThanOrEqual(4_000);
    expect(flags.judgeAccess.sessionCapCents).toBeLessThanOrEqual(flags.judgeAccess.dayCapCents);
    // The hour's limit across every address never lets more in than the day's.
    expect(flags.judgeAccess.sessionsPerHour).toBeLessThanOrEqual(flags.judgeAccess.sessionsPerDay);
  });

  it("pays through Stripe test mode only, and the start-up check still refuses a live key", () => {
    expect(flags.payoutsEnabled).toBe(true);
    expect(flags.paymentProvider).toBe("stripe_test");
    for (const live of [key("sk", "live", "0".repeat(24)), key("rk", "live", "0".repeat(24))]) {
      expect(isTestKey(live)).toBe(false);
      expect(() => assertMoneyEnvSafe(env({ STRIPE_SECRET_KEY: live }), flags)).toThrow(MoneyEnvRefused);
    }
    expect(isTestKey(key("sk", "test", "0".repeat(24)))).toBe(true);
    // Stripe test mode sends every transfer to the one test account, so weekly pay goes out there
    // only for the two demo carriers; any other carrier is held as if payouts were off.
    for (const c of DEMO_CARRIERS) {
      expect(payoutSwitchOn("settlement_payout", "stripe_test", c)).toBe(true);
    }
    const other = { slug: "another-carrier", name: "Another Carrier", timezone: "America/Chicago" };
    expect(payoutSwitchOn("settlement_payout", "stripe_test", other)).toBe(false);
    expect(readFileSync(join(__dirname, "flags.ts"), "utf8")).toMatch(
      /a weekly pay payout \(the bank rail\) runs only for the two demo carriers[^;]*payoutsEnabled: boolean;/,
    );
  });

  it("books to the QuickBooks sandbox only, and the start-up check refuses anything else", () => {
    expect(flags.accountingEnabled).toBe(true);
    const refused = (vars: Record<string, string>) => {
      try {
        assertMoneyEnvSafe(env(vars), flags);
      } catch (err) {
        if (err instanceof MoneyEnvRefused) return err.variable;
        throw err;
      }
      return null;
    };
    expect(refused({ QBO_ENVIRONMENT: "production", QBO_ALLOWED_REALM_ID: "1234567890123456" })).toBe("QBO_ENVIRONMENT");
    expect(refused({ QBO_ALLOWED_REALM_ID: "1234567890123456" })).toBe("QBO_ENVIRONMENT");
    expect(refused({ QBO_ENVIRONMENT: "sandbox" })).toBe("QBO_ALLOWED_REALM_ID");
    expect(refused({ QBO_ENVIRONMENT: "sandbox", QBO_ALLOWED_REALM_ID: "1234567890123456" })).toBeNull();
  });

  it("dates every start so the seeded demo weeks work after a reset and nothing older is sent", () => {
    // Audits every proposal made from the day before the release's first build on.
    expect(flags.auditorStart).toBe("2026-10-27T00:00:00Z");
    expect(Number.isNaN(Date.parse(flags.auditorStart))).toBe(false);
    // Advance payouts (Stripe test mode) open on the release date, read as the approval's own date.
    expect(flags.advancePayouts.startDate).toBe("2026-10-29");
    // The seeded weeks' loads and pay periods start Oct 4 and 5; the open weeks (Oct 25 and 26)
    // are the ones a person runs and invoices.
    expect(flags.invoicesStart).toBe("2026-10-05");
    expect(flags.settlementsStart).toBe("2026-10-05");
    // The first day of the earlier seeded open week, so every planted fill-up lists.
    expect(flags.fuelAnomalyLimits.from).toBe("2026-10-25");
    // Email stays off; the driver note date is the one a later release arms with, and the
    // collections date is empty, which refuses every email even if its switch were on.
    expect(flags.driverNotesEmailFrom).toBe("2026-10-27");
    expect(flags.collectionsEmailFrom).toBe("");
    for (const d of [
      flags.advancePayouts.startDate,
      flags.invoicesStart,
      flags.settlementsStart,
      flags.fuelAnomalyLimits.from,
      flags.driverNotesEmailFrom,
    ]) {
      expect(isLocalDate(d), d).toBe(true);
    }
    expect(isLocalDate(flags.collectionsEmailFrom)).toBe(false);
  });

  it("ships the sweep's checks and the chat loop's checks on, with three attempts before a person", () => {
    expect(flags.verification).toEqual({ enabled: true, maxAttempts: 3 });
  });

  it("ships rate confirmations into loads on, with a start date, a per-read cap and a daily limit", () => {
    expect(flags.ratecon).toEqual({ enabled: true, startDate: "2026-10-30", readMaxCostCents: 8, perTenantPerDay: 20 });
    expect(isLocalDate(flags.ratecon.startDate)).toBe(true);
  });

  it("ships the phone line on, with its segment size, call length, daily calls and hand-offs capped", () => {
    expect(flags.phoneLineEnabled).toBe(true);
    expect(flags.phoneLineLimits).toEqual({
      maxSegmentBytes: 1_000_000,
      maxSegmentMs: 30_000,
      maxSegmentsPerCall: 120,
      maxCallMs: 3_600_000,
      callsPerDay: 20,
      maxHandOffsPerCall: 3,
      maxUpdateCents: 3,
      idleEndMs: 600_000,
    });
    for (const v of Object.values(flags.phoneLineLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    const limits = flags.phoneLineLimits;
    // The longest segment fits the byte cap (32 bytes a millisecond after the 44-byte header), and
    // the CHECKs in migration 0068 hold every segment and hand-off these limits allow.
    expect(limits.maxSegmentMs).toBeLessThanOrEqual(Math.floor((limits.maxSegmentBytes - 44) / 32));
    expect(limits.maxSegmentMs).toBeLessThanOrEqual(30_000);
    expect(limits.maxSegmentsPerCall).toBeLessThanOrEqual(1000);
    expect(limits.maxCallMs).toBeLessThanOrEqual(3_600_000);
    expect(limits.maxHandOffsPerCall).toBeLessThanOrEqual(100);
  });

  it("ships escrow releases on and unarmed, with a $5,000 cap and a start date", () => {
    expect(flags.escrowRelease).toEqual({ enabled: true, armed: false, capCents: 500_000, startDate: "2026-10-30" });
    expect(isLocalDate(flags.escrowRelease.startDate)).toBe(true);
  });

  it("pins every switch that ships on for the demo-path run, on or off as its replay was recorded", () => {
    const local = [...LOCAL_OVERRIDABLE, ...LOCAL_OFF_ONLY] as readonly string[];
    // The two lists never share a switch.
    expect(LOCAL_OVERRIDABLE.filter((k) => (LOCAL_OFF_ONLY as readonly string[]).includes(k))).toEqual([]);
    // stepThrough.dev reads NODE_ENV, not local mode, and local mode may never set it. The two
    // guards that hold a proposal for a person stay on in every run, so local mode never sets them.
    const guards = ["auditorRequired", "verifyEngineMismatchBlocks", "stepThrough.dev"];
    for (const [name, on] of booleanSwitches(flags)) {
      if (on && !guards.includes(name)) expect(local, name).toContain(name);
    }
    // Nothing that stays off can be switched by local mode at all.
    for (const name of KEPT_OFF) expect(local).not.toContain(name);
  });

  it("releases carrier memory, with the agent's suggestions and the second check's notes few", () => {
    expect(flags.carrierMemoryEnabled).toBe(true);
    expect(flags.carrierMemoryAgentLimits).toEqual({ maxSuggestionsPerTurn: 2, maxSuggestionsWaiting: 20, maxAuditorNotes: 4 });
    for (const v of Object.values(flags.carrierMemoryAgentLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.carrierMemoryAgentLimits.maxSuggestionsWaiting).toBeLessThan(flags.carrierMemoryLimits.maxNotesPerCarrier);
  });

  it("starts fuel checks on a fixed date and keeps the receipt compare and corrections small", () => {
    expect(flags.fuelAnomalyEnabled).toBe(true);
    expect(flags.fuelAnomalyLimits).toEqual({
      from: "2026-10-25",
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

  it("says beside the fuel start date that only the demo carriers run the checks, and what another carrier needs", () => {
    // The start date is one date for every carrier: the note beside it says why the demo
    // carriers' date is what it is, that the checks run for them alone, and what a carrier with
    // real history needs first.
    const src = readFileSync(join(__dirname, "flags.ts"), "utf8");
    const at = src.indexOf("fuelAnomalyLimits: {");
    const note = src.slice(at, src.indexOf("from: string;", at)).replace(/\s*\/\/\s*/g, " ");
    expect(note).toContain("first day of the earlier seeded open week");
    expect(note).toContain("which is why only the demo carriers run the checks");
    expect(note).toContain("a carrier with real history needs its own go-live date before it can");
    expect(note).not.toMatch(/switching on never/);
  });

  it("releases the card check, with its window, read-backs and model spend small", () => {
    expect(flags.cardRecon.enabled).toBe(true);
    expect(flags.cardRecon.limits).toEqual({
      windowDays: 14,
      maxBreaks: 50,
      maxReadBacksPerSystem: 40,
      readBackTimeoutMs: 5_000,
      maxExplainCents: 3,
      matchMaxCents: 3,
      maxRunCents: 100,
      sliceMs: 20_000,
    });
    for (const v of Object.values(flags.cardRecon.limits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.cardRecon.limits.sliceMs).toBeLessThan(25_000);
  });

  it("starts the desk loop on a fixed date and keeps its wakes short and its spend small", () => {
    expect(flags.deskLoop).toEqual({
      enabled: true,
      armed: false,
      startDate: "2026-10-30",
      limits: {
        sliceMs: 20_000,
        leaseMs: 55_000,
        eventsPerWake: 20,
        eventsPerDay: 300,
        maxAttempts: 3,
        wakeCents: 60,
        dayCents: 400,
      },
    });
    expect(isLocalDate(flags.deskLoop.startDate)).toBe(true);
    for (const v of Object.values(flags.deskLoop.limits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // One wake ends inside the route's 30 s, and its lease outlives the route.
    expect(flags.deskLoop.limits.sliceMs).toBeLessThan(25_000);
    expect(flags.deskLoop.limits.leaseMs).toBeGreaterThan(30_000);
    expect(flags.deskLoop.limits.wakeCents).toBeLessThanOrEqual(flags.deskLoop.limits.dayCents);
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
      maxModelCalls: 6,
      maxTurnCents: 40,
      wallClockMs: 22_000,
      summaryChars: 10_000,
    });
    for (const v of Object.values(flags.agentTurnLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.agentTurnLimits.wallClockMs).toBeLessThan(30_000);
    // One ceiling over every run; the tighter caps above still win.
    expect(flags.runLimits).toEqual({ maxTurns: 30 });
    expect(flags.runLimits.maxTurns).toBeGreaterThanOrEqual(flags.agentTurnLimits.maxModelCalls);
    expect(flags.proposalMaxAgeDays).toBe(7);
    // The auditor and its requirement go on together, so a proposal can be approved at all.
    expect(flags.auditorEnabled).toBe(true);
    expect(flags.auditorRequired).toBe(true);
    // A mismatch with the rules engine's recompute is held for a person's reason.
    expect(flags.verifyEngineMismatchBlocks).toBe(true);
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

  it("keeps a policy run small: one file of three pages, two calls under 16 cents, five runs a day", () => {
    expect(flags.policyLimits).toEqual({
      maxBytes: 700_000,
      maxPdfPages: 3,
      readMaxCostCents: 10,
      proposeMaxCostCents: 6,
      perTenantPerDay: 5,
      readTimeoutMs: 25_000,
      proposeTimeoutMs: 20_000,
    });
    for (const v of Object.values(flags.policyLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // One stage runs in one request, under the hosting request limit of about 30 seconds.
    expect(flags.policyLimits.readTimeoutMs).toBeLessThan(28_000);
    expect(flags.policyLimits.proposeTimeoutMs).toBeLessThan(28_000);
    // The table's own limits (0013): 700,000 bytes and 3 pages.
    expect(flags.policyLimits.maxBytes).toBeLessThanOrEqual(700_000);
    expect(flags.policyLimits.maxPdfPages).toBeLessThanOrEqual(3);
  });

  it("keeps the marked copy small: two cents an edit, four a check, ten a day, the upload size cap", () => {
    expect(flags.markupLimits).toEqual({
      editMaxCostCents: 2,
      checkMaxCostCents: 4,
      perTenantPerDay: 10,
      maxBytes: 700_000,
    });
    for (const v of Object.values(flags.markupLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // A marked copy is never larger than the largest upload, so reading it alone stays under the
    // database's answer limit exactly as an upload does.
    expect(flags.markupLimits.maxBytes).toBeLessThanOrEqual(flags.documentLimits.maxBytes);
  });

  it("releases the advance flow with payouts armed, its cap kept and dated from the release", () => {
    expect(flags.advancesEnabled).toBe(true);
    expect(flags.advancePayouts).toEqual({ armed: true, capCents: 50_000, startDate: "2026-10-29" });
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

  it("releases the advance take-back, with its whole-cent cap kept", () => {
    expect(flags.advanceTakeback).toEqual({ enabled: true, maxCents: 100_000 });
    expect(Number.isSafeInteger(flags.advanceTakeback.maxCents)).toBe(true);
  });

  it("releases tool search and the prompt cache, keeping the default retention", () => {
    expect(flags.agentToolSearch).toBe(true);
    // "24h" has its own price; the release keeps the default.
    expect(flags.agentPromptCache).toEqual({ enabled: true, retention: "in_memory" });
  });

  it("releases driver notes with their email off, no email address allowed and small caps", () => {
    expect(flags.driverNotesEnabled).toBe(true);
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

  it("releases pay cards, with small caps and a picture size limit", () => {
    expect(flags.payCardsEnabled).toBe(true);
    expect(flags.payCardLimits).toEqual({
      checkMaxCostCents: 3,
      maxBatchCents: 40,
      cardsPerTenantPerDay: 100,
      maxPngBytes: 400_000,
    });
    for (const v of Object.values(flags.payCardLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(flags.payCardLimits.checkMaxCostCents).toBeLessThan(flags.payCardLimits.maxBatchCents);
    // The byte_length CHECK in migration 0052 holds 1 to 400,000 bytes: a larger limit would pass
    // the check and then fail at the save.
    expect(flags.payCardLimits.maxPngBytes).toBeLessThanOrEqual(400_000);
  });

  it("releases collections with their email off, no email address allowed, no send date and small caps", () => {
    expect(flags.collectionsEnabled).toBe(true);
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
    for (const name of ["collectionsEnabled", "collectionsEmailEnabled"]) {
      expect((LOCAL_OVERRIDABLE as readonly string[]).includes(name)).toBe(false);
    }
  });

  it("releases the sweep, its fixes and its nightly kicker, with its caps small", () => {
    expect(flags.sweepEnabled).toBe(true);
    expect(flags.sweepScheduleEnabled).toBe(true);
    expect(flags.payCorrectionsEnabled).toBe(true);
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

  it("releases Cash Friday, with its explanation and option counts capped", () => {
    expect(flags.cashFridayEnabled).toBe(true);
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

  it("releases the sweep's second opinion, with every cap inside the run's own", () => {
    expect(flags.fanoutEnabled).toBe(true);
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

  it("releases invoicing, invoice review and customer payments, with small caps and a start date", () => {
    expect(flags.invoicesEnabled).toBe(true);
    expect(flags.customerPaymentsEnabled).toBe(true);
    expect(flags.invoiceReviewEnabled).toBe(true);
    expect(flags.invoicesStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(flags.invoicesStart).toBe("2026-10-05");
    expect(flags.invoiceLimits).toEqual({ proposalsPerRun: 50, maxPostAttempts: 3 });
    expect(flags.customerPaymentLimits).toEqual({ perDay: 50, maxCents: 5_000_000 });
    for (const v of [...Object.values(flags.invoiceLimits), ...Object.values(flags.customerPaymentLimits)]) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
  });

  it("keeps the portal runner off until a runner is wired, on Muse Spark, with every run capped", () => {
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

  it("releases voice intake, with its upload sizes and daily count capped", () => {
    expect(flags.voiceIntakeEnabled).toBe(true);
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

  it("releases the Inbox, with its daily count, message size and sorting tries capped", () => {
    expect(flags.inboxEnabled).toBe(true);
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

  it("releases the pay run and batch approval, with small caps and a start date", () => {
    expect(flags.settlementsEnabled).toBe(true);
    expect(flags.batchApproveEnabled).toBe(true);
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

  it("releases the profit brief, at most 6 cents a brief, and never switched on by local mode", () => {
    expect(flags.profitBriefEnabled).toBe(true);
    expect(flags.profitBriefLimits).toEqual({ maxBriefCents: 6, maxOutputTokens: 700, maxLanes: 10, maxCustomers: 12 });
    for (const v of Object.values(flags.profitBriefLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("profitBriefEnabled");
  });

  it("releases the quarter review, at most 30 cents a review, and never switched on by local mode", () => {
    expect(flags.quarterReviewEnabled).toBe(true);
    expect(flags.quarterReviewLimits).toEqual({ maxReviewCents: 30, maxOutputTokens: 1600, maxInputChars: 40_000 });
    for (const v of Object.values(flags.quarterReviewLimits)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    // The wrapper refuses an output budget over 8192 tokens.
    expect(flags.quarterReviewLimits.maxOutputTokens).toBeLessThanOrEqual(8192);
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("quarterReviewEnabled");
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("quarterReviewLimits");
  });

  it("releases the IFTA quarter report, and never switched on by local mode", () => {
    expect(flags.iftaEnabled).toBe(true);
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("iftaEnabled");
  });

  it("releases the year-end 1099 report, and never switched on by local mode", () => {
    expect(flags.yearEndEnabled).toBe(true);
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("yearEndEnabled");
    // Local mode may only turn it off, so the demo path's tool list is the one its replay recorded.
    expect(LOCAL_OFF_ONLY as readonly string[]).toContain("yearEndEnabled");
  });

  it("releases the review trust meter, and never switched on by local mode", () => {
    expect(flags.trustMeterEnabled).toBe(true);
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("trustMeterEnabled");
    // Local mode may only turn it off, so the demo path's tool list is the one its replay recorded.
    expect(LOCAL_OFF_ONLY as readonly string[]).toContain("trustMeterEnabled");
  });
});

describe("step through", () => {
  it("ships on for staff, and with staff off is on in development and tests only", () => {
    expect(flags.stepThrough).toEqual({ dev: true, staff: true });
    expect(stepThroughShown(flags, { NODE_ENV: "production" })).toBe(true);
    const devOnly = { stepThrough: { dev: true, staff: false } };
    expect(stepThroughShown(devOnly, { NODE_ENV: "production" })).toBe(false);
    expect(stepThroughShown(devOnly, { NODE_ENV: "test" })).toBe(true);
    expect(stepThroughShown(devOnly, { NODE_ENV: "development" })).toBe(true);
    // Unset or unknown reads as production.
    expect(stepThroughShown(devOnly, {})).toBe(false);
    expect(stepThroughShown(devOnly, { NODE_ENV: "staging" })).toBe(false);
    expect(stepThroughShown({ stepThrough: { dev: true, staff: true } }, { NODE_ENV: "production" })).toBe(true);
    expect(stepThroughShown({ stepThrough: { dev: false, staff: false } }, { NODE_ENV: "development" })).toBe(false);
    expect(LOCAL_OVERRIDABLE as readonly string[]).not.toContain("stepThrough");
  });
});

describe("local overrides for the demo-path test", () => {
  const ARN = "arn:aws:rds:us-east-2:000000000000:cluster:example";
  const ALL_ON = JSON.stringify(Object.fromEntries(LOCAL_OVERRIDABLE.map((k) => [k, true])));
  let logged: string[];
  const copy = (): Flags => structuredClone(flags);
  // The shipped flags with one switch set, by path, as the override sets it.
  const withSwitch = (f: Flags, name: string, value: boolean): Flags => {
    const [outer, inner] = name.split(".");
    if (inner === undefined) return { ...f, [outer]: value };
    return { ...f, [outer]: { ...(f[outer as keyof Flags] as object), [inner]: value } };
  };
  // A copy with every overridable switch off, so turning them on can be seen.
  const dark = (): Flags => LOCAL_OVERRIDABLE.reduce((f, k) => withSwitch(f, k, false), copy());

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
    const target = dark();
    const before = structuredClone(target);
    const keys = applyLocalOverrides(target, { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: ALL_ON });
    expect(keys).toEqual([...LOCAL_OVERRIDABLE]);
    expect(target.aiEnabled && target.agentEnabled && target.auditorEnabled).toBe(true);
    expect(target.reportsEnabled && target.driverNotesEnabled && target.inboxEnabled).toBe(true);
    expect(target.advancesEnabled && target.payoutsEnabled && target.advancePayouts.armed).toBe(true);
    // Everything else, every cap and limit among it, is exactly as it was.
    expect(target).toEqual(LOCAL_OVERRIDABLE.reduce((f, k) => withSwitch(f, k, true), before));
    expect(target.advancePayouts.capCents).toBe(flags.advancePayouts.capCents);
    expect(target.advancePayouts.startDate).toBe(flags.advancePayouts.startDate);
  });

  it("in local mode, turns an off-only switch off, and nothing else", () => {
    for (const name of LOCAL_OFF_ONLY) {
      const target = copy();
      const env = { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: JSON.stringify({ [name]: false }) };
      expect(applyLocalOverrides(target, env), name).toEqual([name]);
      expect(target, name).toEqual(withSwitch(flags, name, false));
    }
  });

  it("never turns an off-only switch on, and then changes nothing at all", () => {
    for (const name of LOCAL_OFF_ONLY) {
      logged = [];
      const target = withSwitch(copy(), name, false);
      const before = structuredClone(target);
      const env = { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: JSON.stringify({ [name]: true }) };
      expect(applyLocalOverrides(target, env), name).toEqual([]);
      expect(target, name).toEqual(before);
      expect(logged).toEqual(["flags: FLAGS_LOCAL_OVERRIDES sets something it may not; nothing changed"]);
      // Mixed with an allowed key, the whole value is refused.
      const mixed = { NODE_ENV: "development", FLAGS_LOCAL_OVERRIDES: JSON.stringify({ agentEnabled: false, [name]: true }) };
      expect(applyLocalOverrides(target, mixed), name).toEqual([]);
      expect(target, name).toEqual(before);
    }
  });

  it("runs the demo path on the switches its replay was recorded with", () => {
    const target = copy();
    const keys = applyLocalOverrides(target, { NODE_ENV: "test", FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES });
    expect(keys).toEqual([...LOCAL_OVERRIDABLE, ...LOCAL_OFF_ONLY]);
    for (const name of LOCAL_OVERRIDABLE) expect(Object.fromEntries(booleanSwitches(target))[name], name).toBe(true);
    for (const name of LOCAL_OFF_ONLY) expect(Object.fromEntries(booleanSwitches(target))[name], name).toBe(false);
    // Caps, limits, dates, providers and every kept-off switch are exactly as shipped.
    const on = LOCAL_OVERRIDABLE.reduce((f, k) => withSwitch(f, k, true), copy());
    const expected = [...LOCAL_OFF_ONLY].reduce((f, k) => withSwitch(f, k, false), on);
    expect(target).toEqual(expected);
  });

  it("is ignored in a production build", () => {
    // The recorded set turns shipped switches off, so a change would show.
    const target = copy();
    expect(applyLocalOverrides(target, { NODE_ENV: "production", FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES })).toEqual([]);
    expect(target).toEqual(flags);
    expect(logged).toEqual(["flags: FLAGS_LOCAL_OVERRIDES ignored outside local mode"]);
  });

  it("is ignored when NODE_ENV is unset or not exactly development or test, even off Aurora", () => {
    const envs: Record<string, string>[] = [
      { FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES },
      { DB_CLUSTER_ARN: "", FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES },
      ...["", "staging", "preview", "Development", "production"].map((NODE_ENV) => ({
        NODE_ENV,
        DB_CLUSTER_ARN: "",
        FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES,
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
      const env = { NODE_ENV, DB_CLUSTER_ARN: ARN, FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES };
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
      { payCardLimits: { checkMaxCostCents: 1000, maxBatchCents: 100_000 } },
      { payCardsEnabled: true },
      { advancesLimits: { proposalsPerDay: 1000 } },
      { paymentProvider: "stripe" },
      { triageProvider: "meta" },
      { auditorStart: "2020-01-01T00:00:00Z" },
      { accountingEnabled: true },
      { driverNotesEmailEnabled: true },
      { agentEnabled: true, "agentTurnLimits.maxToolSteps": 99 },
      { runLimits: { maxTurns: 1000 } },
      { "runLimits.maxTurns": 1000 },
      // Off-only: on locally, it would add a tool the recorded replay never saw.
      { detentionEnabled: true },
      { collectionsEnabled: true },
      { "agentPromptCache.enabled": true },
      { sparkOpenFallback: "fireworks" },
      // Off-only: local mode may never turn these on.
      { inboundEmailEnabled: true },
      { sweepScheduleEnabled: true },
      // Off-only, and not on the demo path: its tools stay out of the replay's tool list.
      { cardRecon: { enabled: true } },
      { "cardRecon.enabled": true },
      // The desk loop is the owner's release, like the sweep.
      { deskLoop: { enabled: true, armed: true } },
      { "deskLoop.enabled": true },
      { "deskLoop.armed": true },
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
