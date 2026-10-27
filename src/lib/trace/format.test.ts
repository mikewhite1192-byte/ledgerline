import { describe, expect, it } from "vitest";
import {
  decisionSentence,
  effortWords,
  formatCached,
  formatCachedShare,
  formatCallCost,
  formatSaved,
  formatLatency,
  formatSpend,
  modelName,
  traceLines,
  traceTotals,
} from "./format";
import { SAMPLE_CALLS, SAMPLE_PROPOSAL_ID, sampleTrace } from "./sample";
import type { TraceDecision, TraceStep, TurnTrace } from "./types";

const RAW_CODES = [
  "propose_advance",
  "get_pay_items",
  "amount_over_limit",
  "capped_to_eligible",
  "schema_failed_twice",
  "agent_operator_turn",
  "agent_operator_escalation",
  "screen_untrusted_input",
  "spark_open",
  "muse-spark",
  "xhigh",
];

function textOf(trace: TurnTrace, proposalId?: string): string {
  return traceLines(trace, proposalId)
    .map((l) => [l.who, ...l.meta, l.text, l.badge?.label ?? ""].join(" | "))
    .join("\n");
}

describe("cents from nanocents", () => {
  it("shows one call to a tenth of a cent, always rounded up", () => {
    expect(formatCallCost(700_000_000)).toBe("0.7 cents");
    expect(formatCallCost(650_000_000)).toBe("0.7 cents");
    expect(formatCallCost(600_000_001)).toBe("0.7 cents");
    expect(formatCallCost(1)).toBe("0.1 cents");
    expect(formatCallCost(5_800_000_000)).toBe("5.8 cents");
    expect(formatCallCost(12_340_000_000)).toBe("12.4 cents");
  });

  it("says no charge, not settled or unknown instead of guessing", () => {
    expect(formatCallCost(0)).toBe("no charge");
    expect(formatCallCost(null)).toBe("cost not settled");
    expect(formatCallCost(-1)).toBe("cost unknown");
    expect(formatCallCost(1.5)).toBe("cost unknown");
    expect(formatCallCost(Number.NaN)).toBe("cost unknown");
    expect(formatCallCost(2 ** 60)).toBe("cost unknown");
  });

  it("writes a call of a dollar or more in dollars, rounded up to the cent", () => {
    expect(formatCallCost(100_000_000_000)).toBe("$1.00");
    expect(formatCallCost(100_000_000_001)).toBe("$1.01");
  });

  it("writes a total in cents under a dollar and in dollars from there, rounded up", () => {
    expect(formatSpend(0)).toBe("0 cents");
    expect(formatSpend(45_230_000_000)).toBe("45.3 cents");
    expect(formatSpend(99_990_000_000)).toBe("100.0 cents");
    expect(formatSpend(123_400_000_001)).toBe("$1.24");
    expect(formatSpend(1_500_000_000_000_000)).toBe("$15,000.00");
    expect(formatSpend(-5)).toBe("unknown");
    expect(formatSpend(0.5)).toBe("unknown");
  });
});

describe("words for codes", () => {
  it("names models as people know them, and an unknown one as Other model", () => {
    expect(modelName("spark", "muse-spark-1.3")).toBe("Muse Spark 1.3");
    expect(modelName("spark", "muse-spark-1.3-contributor")).toBe("Muse Spark 1.3");
    expect(modelName("spark", "muse-spark-1.3-preview")).toBe("Muse Spark");
    expect(modelName("spark", "xmuse-spark-1.3")).toBe("Muse Spark");
    expect(modelName("wonder", "muse-wonder-1.0")).toBe("Muse Wonder");
    expect(modelName("spark_open", "meta-models/muse-spark-open-1026")).toBe("Muse Spark Open");
    expect(modelName("sam", "sam-3.1")).toBe("SAM 3.1");
    expect(modelName("llama", "llama-9")).toBe("Other model");
  });

  it("writes effort and latency in plain words", () => {
    expect(effortWords("low")).toBe("low effort");
    expect(effortWords("xhigh")).toBe("extra high effort");
    expect(effortWords("turbo")).toBeNull();
    expect(effortWords(null)).toBeNull();
    expect(formatLatency(1_840)).toBe("1.8 s");
    expect(formatLatency(1_850)).toBe("1.9 s");
    expect(formatLatency(99)).toBe("under 0.1 s");
    expect(formatLatency(100)).toBe("0.1 s");
    expect(formatLatency(61_000)).toBe("61.0 s");
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(-3)).toBeNull();
    expect(formatLatency(2.5)).toBeNull();
  });

  it("states a block with the eligible limit, and refusals without codes", () => {
    const d: TraceDecision = {
      id: "d",
      tool: "propose_advance",
      decision: "blocked",
      reason: "amount_over_limit",
      limitCents: 41_200,
      issuedBy: null,
      refs: [],
    };
    expect(decisionSentence(d)).toBe("blocked, the amount is over the eligible limit ($412.00)");
    expect(decisionSentence({ ...d, limitCents: null })).toBe("blocked, the amount is over the eligible limit");
    expect(decisionSentence({ ...d, reason: "made_up_reason" })).toBe("blocked, a rule check stopped it");
    expect(decisionSentence({ ...d, decision: "invalid_args" })).toBe("refused, the request was not in the right form");
    expect(decisionSentence({ ...d, decision: "allowed", reason: "capped_to_eligible" })).toBe(
      "allowed, cut to the most the pay rules allow",
    );
    expect(decisionSentence({ ...d, decision: "teleported" })).toBe("outcome not known");
  });
});

describe("traceLines", () => {
  it("lists the whole turn in order, with the screening after the step that read the text", () => {
    const lines = traceLines(sampleTrace());
    expect(lines.map((l) => l.key)).toEqual([
      "step:1",
      "step:2",
      `call:${SAMPLE_CALLS.screen.id}`,
      "step:3",
      "step:4",
      "step:5",
      "step:6",
      "step:7",
      "step:8",
    ]);
    expect(lines[0]).toMatchObject({
      who: "Muse Spark 1.3",
      meta: ["low effort", "1.8 s", "0.7 cents"],
      text: "Planned the next step: asked for 1 tool",
    });
    expect(lines[1]).toMatchObject({ who: "Gateway", text: "Reading pay items: allowed", badge: null });
    expect(lines[1].refs).toHaveLength(2);
    expect(lines[2]).toMatchObject({
      who: "Muse Spark Open",
      meta: ["0.4 s", "0.1 cents"],
      text: "Screened outside text before the agent read it: clean",
    });
    expect(lines[4]).toMatchObject({
      text: "Checking advance eligibility: blocked, the amount is over the eligible limit ($412.00)",
      badge: { tone: "warning", label: "Blocked" },
    });
    expect(lines[7].text).toBe("Saved the proposal card for a person to approve");
    expect(lines[8].text).toBe("Wrote the answer");
  });

  it("gives a card only its own steps, then the verdicts and the auditor", () => {
    const lines = traceLines(sampleTrace(), SAMPLE_PROPOSAL_ID);
    expect(lines.map((l) => l.key)).toEqual([
      "step:3",
      "step:4",
      "step:5",
      "step:6",
      "step:7",
      `proposal:${SAMPLE_PROPOSAL_ID}:operator`,
      `proposal:${SAMPLE_PROPOSAL_ID}:exception:0`,
      `proposal:${SAMPLE_PROPOSAL_ID}:auditor`,
    ]);
    expect(lines[5]).toMatchObject({ who: "Muse Spark 1.3", text: "Judged it: eligible for part of the ask" });
    expect(lines[6].text).toBe("Cut to the most the pay rules allow after a larger ask was refused.");
    expect(lines[7]).toMatchObject({
      who: "Auditor (Muse Wonder)",
      meta: ["high effort", "4.1 s", "5.8 cents"],
      text: "Checked the proposal and found no problem",
      badge: { tone: "success", label: "Pass" },
    });
  });

  it("returns nothing for a card the trace does not hold", () => {
    expect(traceLines(sampleTrace(), "00000000-0000-4000-8000-000000000000")).toEqual([]);
  });

  it("never shows a raw code, tool name or model string", () => {
    const all = `${textOf(sampleTrace())}\n${textOf(sampleTrace(), SAMPLE_PROPOSAL_ID)}`;
    for (const code of RAW_CODES) expect(all).not.toContain(code);
  });

  it("explains an escalation in plain English and pairs a failed step with its unlinked call", () => {
    const base = sampleTrace();
    const failedCall = { ...SAMPLE_CALLS.ask, id: "c0000001-0000-4000-8000-0000000000aa", status: "failed", failure: "timeout", costNanocents: 0 };
    const wonder = { ...SAMPLE_CALLS.auditor, id: "c0000001-0000-4000-8000-0000000000bb", purpose: "agent_operator_escalation" };
    const trace: TurnTrace = {
      ...base,
      steps: [
        { ...base.steps[0], seq: 1, kind: "model", state: "failed", call: null, category: "timeout", toolCalls: null },
        {
          ...base.steps[0],
          seq: 2,
          kind: "escalation",
          label: "Asking Muse Wonder to form the proposal",
          call: wonder,
          toolCalls: null,
          escalation: { attempts: 2, finishedBy: "wonder" },
        },
      ],
      extraCalls: [{ ...failedCall, afterSeq: 1, screen: null }],
      proposals: [],
    };
    const lines = traceLines(trace);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      who: "Muse Spark 1.3",
      meta: ["low effort", "2.1 s", "no charge"],
      text: "Did not finish thinking it through: the call failed: the model took too long",
      badge: { tone: "destructive", label: "Failed" },
    });
    expect(lines[1]).toMatchObject({
      who: "Muse Wonder",
      meta: ["high effort", "4.1 s", "5.8 cents"],
      text: "Took over after Muse Spark failed the proposal format twice",
      badge: { tone: "info", label: "Escalated" },
    });
    expect(textOf(trace)).not.toContain("schema_failed_twice");
  });

  it("says an escalation that did not finish, and a failed model step with no call", () => {
    const base = sampleTrace();
    const trace: TurnTrace = {
      ...base,
      steps: [
        { ...base.steps[0], seq: 1, kind: "model", state: "failed", call: null, category: "cap" },
        {
          ...base.steps[0],
          seq: 2,
          kind: "escalation",
          state: "failed",
          call: null,
          category: "unavailable",
          escalation: { attempts: 2, finishedBy: "none" },
        },
      ],
      extraCalls: [],
      proposals: [],
    };
    const [model, esc] = traceLines(trace);
    expect(model).toMatchObject({ who: "Muse Spark", meta: [], text: "Did not finish thinking it through: the demo budget was reached" });
    expect(esc.text).toBe(
      "Took over after Muse Spark failed the proposal format twice, but did not finish: the model was not available",
    );
  });

  it("shows a flagged screening under a flagged card, and names an unknown model", () => {
    const base = sampleTrace();
    const trace: TurnTrace = {
      ...base,
      extraCalls: [
        { ...SAMPLE_CALLS.screen, afterSeq: 2, screen: { verdict: "flagged", via: "model" } },
        { ...SAMPLE_CALLS.plan, id: "c0000001-0000-4000-8000-0000000000cc", target: "llama", model: "llama-9", purpose: "something_else", afterSeq: 8, screen: null },
      ],
      proposals: [{ ...base.proposals[0], flagged: true, auditorVerdict: "block" }],
    };
    const card = traceLines(trace, SAMPLE_PROPOSAL_ID);
    expect(card.map((l) => l.badge?.label ?? null)).toContain("Flagged");
    expect(card.find((l) => l.key === `call:${SAMPLE_CALLS.screen.id}`)?.text).toBe(
      "Screened outside text before the agent read it: flagged, so it was shown as data and not followed",
    );
    expect(card.at(-1)).toMatchObject({ text: "Checked the proposal and blocked it", badge: { tone: "destructive", label: "Blocked" } });
    const whole = traceLines(trace);
    expect(whole.at(-1)).toMatchObject({ who: "Other model", text: "Made a model call for this turn" });
  });

  it("says a proposal card was prepared only for a known success or a done step", () => {
    const base = sampleTrace();
    const line = (over: Partial<TraceStep>) =>
      traceLines({ ...base, steps: [{ ...base.steps[6], ...over }], extraCalls: [], proposals: [] })[0];
    const failed = { text: "Could not save the proposal card", badge: { tone: "destructive", label: "Failed" } };

    expect(line({ state: "failed", result: "already_decided", proposalId: null })).toMatchObject({
      text: "That proposal was already decided, so no new card was made",
      badge: null,
    });
    expect(line({ state: "failed", result: "store_failed", proposalId: null })).toMatchObject(failed);
    expect(line({ state: "failed", result: null, proposalId: null })).toMatchObject(failed);
    expect(line({ state: "failed", result: "something_new", proposalId: null })).toMatchObject(failed);
    expect(line({ state: "cancelled", result: null, proposalId: null })).toMatchObject(failed);
    expect(line({ state: "running", result: null, proposalId: null })).toMatchObject({
      text: "Preparing a proposal card",
      badge: null,
    });
    expect(line({ state: "done", result: "something_new" })).toMatchObject({ text: "Prepared a proposal card", badge: null });
    expect(line({ state: "done", result: "duplicate" }).text).toBe(
      "Found the same proposal already on file, so no second card was made",
    );
  });
});

describe("traceTotals", () => {
  it("sums the distinct calls behind the rows, rounding the cost up", () => {
    expect(traceTotals(sampleTrace())).toBe("5 model calls, 2.6 cents in all, 7.4 s of model time");
    expect(traceTotals(sampleTrace(), SAMPLE_PROPOSAL_ID)).toBe(
      "3 model calls, 7.3 cents in all, 8.1 s of model time",
    );
  });

  it("totals exactly the costs its rows show, never less", () => {
    const tenths = (text: string) => {
      const m = /^([0-9]+)\.([0-9]) cents$/.exec(text);
      return m ? Number(m[1]) * 10 + Number(m[2]) : 0;
    };
    for (const id of [undefined, SAMPLE_PROPOSAL_ID]) {
      const rows = traceLines(sampleTrace(), id).flatMap((l) => l.meta).reduce((sum, m) => sum + tenths(m), 0);
      const footer = /, ([0-9]+\.[0-9] cents) in all/.exec(traceTotals(sampleTrace(), id) ?? "");
      expect(footer).not.toBeNull();
      expect(tenths(footer![1])).toBe(rows);
    }
    // The sample's rows read 0.7 + 0.1 + 0.7 + 0.8 + 0.3 cents; the raw spend, 2.42 cents, rounds to 2.5.
    const rows = traceLines(sampleTrace()).flatMap((l) => l.meta).reduce((sum, m) => sum + tenths(m), 0);
    expect(rows).toBe(26);

    // From a dollar up a row shows whole cents, and the total counts that figure, not the raw one.
    const base = sampleTrace();
    const big: TurnTrace = {
      ...base,
      steps: [
        { ...base.steps[0], call: { ...SAMPLE_CALLS.plan, costNanocents: 100_000_000_001 } },
        { ...base.steps[2], call: { ...SAMPLE_CALLS.ask, costNanocents: 50_000_000 } },
      ],
      extraCalls: [],
      proposals: [],
    };
    expect(traceTotals(big)).toBe("2 model calls, $1.02 in all, 3.9 s of model time");
  });

  it("says when a call is not settled or has no known cost, and is empty with no calls", () => {
    const base = sampleTrace();
    const trace: TurnTrace = {
      ...base,
      steps: [
        { ...base.steps[0], call: { ...SAMPLE_CALLS.plan, costNanocents: null } },
        { ...base.steps[2], call: { ...SAMPLE_CALLS.ask, costNanocents: -1 } },
      ],
      extraCalls: [],
      proposals: [],
    };
    expect(traceTotals(trace)).toBe(
      "2 model calls, 0 cents in all, 3.9 s of model time; 1 call is not settled yet; 1 call has no known cost",
    );
    expect(traceTotals({ ...base, steps: [base.steps[1]], extraCalls: [], proposals: [] })).toBeNull();
  });
});

describe("prompt cache and tool search lines", () => {
  const plan = SAMPLE_CALLS.plan;

  it("states the cached share of one call and what it saved, rounded down", () => {
    // 1,912 cached Muse Spark tokens saved 1,912 x 110,000 nanocents = 0.21 cents.
    expect(formatCached({ ...plan, inputTokens: 2_480, cachedTokens: 1_912, savedNanocents: 1_912 * 110_000 })).toBe(
      "1,912 of 2,480 input tokens from cache, saved 0.2 cents",
    );
    expect(formatCached({ ...plan, inputTokens: 2_480, cachedTokens: 0, savedNanocents: 0 })).toBe("no input tokens from cache");
    expect(formatCached({ ...plan, inputTokens: 2_480, cachedTokens: 1_912, savedNanocents: null })).toBe(
      "1,912 of 2,480 input tokens from cache, saving not known",
    );
  });

  it("shows no cache line when a count is missing or the counts do not fit", () => {
    expect(formatCached(plan)).toBeNull();
    expect(formatCached({ ...plan, inputTokens: 2_480, cachedTokens: null })).toBeNull();
    expect(formatCached({ ...plan, inputTokens: null, cachedTokens: 10 })).toBeNull();
    expect(formatCached({ ...plan, inputTokens: 10, cachedTokens: 11, savedNanocents: 0 })).toBeNull();
    expect(formatCached({ ...plan, inputTokens: 10.5, cachedTokens: 1, savedNanocents: 0 })).toBeNull();
  });

  it("rounds a saving down, never up, the opposite of spend", () => {
    expect(formatSaved(199_999_999)).toBe("0.1 cents");
    expect(formatSpend(199_999_999)).toBe("0.2 cents");
    expect(formatSaved(99_999_999)).toBe("under 0.1 cents");
    expect(formatSaved(0)).toBe("nothing");
    expect(formatSaved(84_390_000_000)).toBe("84.3 cents");
    expect(formatSaved(124_900_000_000)).toBe("$1.24");
    expect(formatSaved(null)).toBe("not known");
    expect(formatSaved(-1)).toBe("not known");
  });

  it("writes the cached share as a whole percent, and under 1% rather than 0% when some was cached", () => {
    expect(formatCachedShare(71, 1_912)).toBe("71%");
    expect(formatCachedShare(0, 3)).toBe("under 1%");
    expect(formatCachedShare(0, 0)).toBe("0%");
    expect(formatCachedShare(null, 0)).toBeNull();
    expect(formatCachedShare(101, 5)).toBeNull();
  });

  it("puts the cache line under each model call that has counts, and says a search on its step", () => {
    const trace = sampleTrace();
    const cached = { ...plan, inputTokens: 2_480, cachedTokens: 1_912, savedNanocents: 1_912 * 110_000 };
    trace.steps[0] = { ...trace.steps[0], call: cached, toolSearches: 1 };
    const lines = traceLines(trace);
    expect(lines[0]).toMatchObject({
      text: "Planned the next step: asked for 1 tool, after one tool search",
      cache: "1,912 of 2,480 input tokens from cache, saved 0.2 cents",
    });
    // A gateway row shows no model call, so it has no cache line; calls with no counts have none.
    expect(lines[1]).not.toHaveProperty("cache");
    expect(lines.filter((l) => l.cache !== undefined)).toHaveLength(1);

    trace.steps[0] = { ...trace.steps[0], toolSearches: 2 };
    expect(traceLines(trace)[0].text).toBe("Planned the next step: asked for 1 tool, after 2 tool searches");
    trace.steps[0] = { ...trace.steps[0], toolSearches: 0 };
    expect(traceLines(trace)[0].text).toBe("Planned the next step: asked for 1 tool");
  });
});
