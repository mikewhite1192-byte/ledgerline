import { stepLabel } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { reasonSentence } from "@/lib/agent/reasons";
import { NOTE_REF_TABLE } from "@/lib/memory/links";
import type { TraceCall, TraceDecision, TraceExtraCall, TraceNote, TraceProposal, TraceStep, TurnTrace } from "./types";

// Fixed words for every code a trace carries. Nothing here does math on money: model spend is
// whole nanocents, cut to tenths of a cent (or whole cents) and always rounded up, so a display
// never looks smaller than the ledger. A cache saving is the opposite: always rounded down, so it
// never looks bigger than it is. Unknown codes read as a generic phrase, never as the code.

// The model wrapper's unit (1 cent is 1,000,000,000 nanocents). Kept here so the screens that use
// this file never load the wrapper itself.
export const NANOCENTS_PER_CENT = 1_000_000_000;
const TENTH = NANOCENTS_PER_CENT / 10;

export const CORE_TARGETS = ["spark", "wonder", "spark_open"] as const;
export const LATER_TARGETS = ["voice", "image", "sam"] as const;

const TARGET_NAMES: Readonly<Record<string, string>> = {
  spark: "Muse Spark",
  wonder: "Muse Wonder",
  spark_open: "Muse Spark Open",
  voice: "Muse Voice Transcribe",
  image: "Muse Image",
  sam: "SAM 3.1",
};

export const OTHER_MODEL = "Other model";

// What each model does in LedgerLine, for the models page.
const TARGET_JOBS: Readonly<Record<string, string>> = {
  spark: "Answers questions in the chat and drafts cards for a person to approve, from the tools' records.",
  wonder: "Takes over when a card will not form, and gives each card its second check.",
  spark_open: "Screens outside text, like an email, before the agent reads it.",
  voice: "Turns a spoken question into text.",
  image: "Reads document images.",
  sam: "Finds faces and license plates in a dock clip so they are blurred, and finds a document in a photo.",
};

const has = (map: Readonly<Record<string, string>>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key);

export function targetName(target: string): string {
  return has(TARGET_NAMES, target) ? TARGET_NAMES[target] : OTHER_MODEL;
}

export function targetJob(target: string): string {
  return has(TARGET_JOBS, target) ? TARGET_JOBS[target] : "A model this page has no description for yet.";
}

// The same jobs in a few words, for the "Models used" group under an answer or a card.
const TARGET_ROLES: Readonly<Record<string, string>> = {
  spark: "Answers and cards",
  wonder: "Second check",
  spark_open: "Screens outside text",
  voice: "Transcribes voice notes",
  image: "Makes images",
  sam: "Finds objects in photos and video",
};

export function targetRole(target: string): string {
  return has(TARGET_ROLES, target) ? TARGET_ROLES[target] : "Other work";
}

const SPARK_VERSION = /^muse-spark-([0-9]{1,2}\.[0-9]{1,2})(?:-contributor)?$/;

// Who serves each target when nothing has gone wrong (the wrapper's TARGETS, kept here so the
// screens never load the wrapper; format.test.ts holds the two equal), and the words for the
// hosts a call can come from instead.
export const PRIMARY_HOSTS: Readonly<Record<string, string>> = {
  spark: "meta",
  wonder: "meta",
  spark_open: "baseten",
  voice: "meta",
  image: "meta",
  sam: "meta",
};

const HOST_NAMES: Readonly<Record<string, string>> = {
  baseten: "Baseten",
  fireworks: "Fireworks",
};

// The model as people know it: "muse-spark-1.3" reads "Muse Spark 1.3". A model string this
// table does not know reads as its target's name; an unknown target reads "Other model". A call
// a standby host served names that host: "Muse Spark Open (via Fireworks)". A call from the
// target's usual host, or with no host given, reads as before.
export function modelName(target: string, model: string, provider?: string): string {
  let name = targetName(target);
  if (target === "spark") {
    const m = SPARK_VERSION.exec(model);
    if (m) name = `Muse Spark ${m[1]}`;
  }
  if (!provider || !has(PRIMARY_HOSTS, target) || PRIMARY_HOSTS[target] === provider) return name;
  return `${name} (via ${has(HOST_NAMES, provider) ? HOST_NAMES[provider] : "another host"})`;
}

const EFFORT_WORDS: Readonly<Record<string, string>> = {
  minimal: "minimal effort",
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
  xhigh: "extra high effort",
  max: "maximum effort",
};

export function effortWords(effort: string | null): string | null {
  return effort !== null && has(EFFORT_WORDS, effort) ? EFFORT_WORDS[effort] : null;
}

// 1,840 ms reads "1.8 s"; under 100 ms reads "under 0.1 s". Nothing to show reads null.
export function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isSafeInteger(ms) || ms < 0) return null;
  if (ms < 100) return "under 0.1 s";
  const tenths = Math.round(ms / 100);
  return `${Math.floor(tenths / 10)}.${tenths % 10} s`;
}

const isNanocents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// Exact integer ceiling division for safe integers.
function ceilDiv(n: number, unit: number): number {
  const rest = n % unit;
  const whole = (n - rest) / unit;
  return rest === 0 ? whole : whole + 1;
}

// Exact integer floor division for non-negative safe integers.
function floorDiv(n: number, unit: number): number {
  return (n - (n % unit)) / unit;
}

function dollarsUp(nanocents: number): string {
  return formatCents(ceilDiv(nanocents, NANOCENTS_PER_CENT));
}

function tenthsText(tenths: number): string {
  return `${Math.floor(tenths / 10)}.${tenths % 10} cents`;
}

function tenthsOfCent(nanocents: number): string {
  return tenthsText(ceilDiv(nanocents, TENTH));
}

// One call's cost as formatCallCost shows it, in tenths of a cent: rounded up to a tenth under a
// dollar, to a whole cent from there.
function shownTenths(nanocents: number): number {
  return nanocents >= 100 * NANOCENTS_PER_CENT
    ? ceilDiv(nanocents, NANOCENTS_PER_CENT) * 10
    : ceilDiv(nanocents, TENTH);
}

// One call's cost: "0.7 cents", "no charge", or why there is no figure.
export function formatCallCost(nanocents: number | null): string {
  if (nanocents === null) return "cost not settled";
  if (!isNanocents(nanocents)) return "cost unknown";
  if (nanocents === 0) return "no charge";
  return nanocents >= 100 * NANOCENTS_PER_CENT ? dollarsUp(nanocents) : tenthsOfCent(nanocents);
}

// A total: "0 cents", "45.3 cents", then "$1.24" from a dollar up.
export function formatSpend(nanocents: number): string {
  if (!isNanocents(nanocents)) return "unknown";
  if (nanocents === 0) return "0 cents";
  return nanocents >= 100 * NANOCENTS_PER_CENT ? dollarsUp(nanocents) : tenthsOfCent(nanocents);
}

export function countWords(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// A total in dollars and cents for copy that a person reads as money ("$0.00 of $2.00"), rounded
// up to the cent so it never looks smaller than the ledger.
export function formatDollars(nanocents: number): string {
  if (!isNanocents(nanocents)) return "unknown";
  return dollarsUp(nanocents);
}

// A cache saving, rounded down: "0.2 cents", "84.3 cents", then "$1.24" from a dollar up, and
// "under 0.1 cents" for a saving too small to show.
export function formatSaved(nanocents: number | null): string {
  if (nanocents === null || !isNanocents(nanocents)) return "not known";
  if (nanocents === 0) return "nothing";
  if (nanocents >= 100 * NANOCENTS_PER_CENT) return formatCents(floorDiv(nanocents, NANOCENTS_PER_CENT));
  const tenths = floorDiv(nanocents, TENTH);
  return tenths === 0 ? "under 0.1 cents" : tenthsText(tenths);
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// Under one model call: how much of its input the prompt cache served and what that saved.
// Null when either count is missing or they do not fit together (a call not metered in tokens,
// or one not settled).
export function formatCached(call: TraceCall): string | null {
  const { inputTokens: input, cachedTokens: cached } = call;
  if (!isCount(input) || !isCount(cached) || cached > input) return null;
  if (cached === 0) return "no input tokens from cache";
  const part = `${cached.toLocaleString("en-US")} of ${input.toLocaleString("en-US")} input tokens from cache`;
  return call.savedNanocents === null ? `${part}, saving not known` : `${part}, saved ${formatSaved(call.savedNanocents)} at list price`;
}

// The share of input tokens served from the cache, as the models page shows it.
export function formatCachedShare(share: number | null, cached: number): string | null {
  if (share === null || !isCount(share) || share > 100) return null;
  return share === 0 && cached > 0 ? "under 1%" : `${share}%`;
}

const FAILURE_WORDS: Readonly<Record<string, string>> = {
  disabled: "the models are switched off",
  not_configured: "the model is not set up",
  cap: "the demo budget was reached",
  job_cap: "the job used more than its hourly allowance and was stopped",
  too_expensive: "the call would have cost more than one call may",
  rate_limited: "the model was busy",
  unavailable: "the model was not available",
  timeout: "the model took too long",
  bad_request: "the model refused the request",
  auth: "the model login failed",
  billing: "the model account has a billing problem",
  too_long: "the request was too long",
  network: "the connection dropped",
  unknown: "the cause is not known",
};

export function failureWords(category: string | null): string {
  return category !== null && has(FAILURE_WORDS, category) ? FAILURE_WORDS[category] : "the cause is not known";
}

// The decision sentence for a safety check step, after the step's own fixed label.
const DECISION_WORDS: Readonly<Record<string, string>> = {
  allowed: "passed the safety check",
  blocked: "blocked",
  invalid_args: "refused, the request was not in the right form",
  denied: "refused, this assistant may not use that tool",
  unknown_tool: "refused, there is no such tool",
  failed: "did not finish",
};

const BLOCK_REASONS: Readonly<Record<string, string>> = {
  amount_over_limit: "the amount is over the eligible limit",
  unknown_record: "the record is not on file",
  engine_refused: "the pay rules refused it",
  limit_unavailable: "the limit could not be read, so nothing was allowed",
  screen_flagged: "outside text was flagged",
  screen_error: "outside text could not be screened",
  budget: "the turn ran out of budget",
  duplicate: "the same request was already made",
  role_not_allowed: "this assistant may not use that tool",
};

export function decisionSentence(d: TraceDecision): string {
  const head = has(DECISION_WORDS, d.decision) ? DECISION_WORDS[d.decision] : "outcome not known";
  if (d.decision === "allowed") {
    if (d.reason === "capped_to_eligible") return "passed the safety check, cut to the most the pay rules allow";
    if (d.reason === "result_truncated") return "passed the safety check, the result was cut to fit";
    if (d.reason === "duplicate") return "passed the safety check, the same request was already answered";
    return head;
  }
  if (d.decision !== "blocked") return head;
  const why = has(BLOCK_REASONS, d.reason) ? BLOCK_REASONS[d.reason] : "a rule check stopped it";
  const limit =
    d.reason === "amount_over_limit" && d.limitCents !== null && Number.isSafeInteger(d.limitCents)
      ? ` (${formatCents(d.limitCents)})`
      : "";
  return `blocked, ${why}${limit}`;
}

const OPERATOR_VERDICTS: Readonly<Record<string, string>> = {
  eligible: "eligible",
  partial: "eligible for part of the ask",
  ineligible: "not eligible",
  owed_to_driver: "money is owed to the driver",
  owed_by_driver: "money is owed by the driver",
};

// The second check's four results (migration 0014), worded as the card words them.
const AUDITOR_VERDICTS: Readonly<Record<string, string>> = {
  pass: "Gave the card a second check: passed",
  concerns: "Gave the card a second check: has concerns",
  block: "Gave the card a second check: did not pass",
  unknown: "Could not decide",
};

const PROPOSAL_RESULTS: Readonly<Record<string, string>> = {
  created: "Saved the card for a person to approve",
  duplicate: "Found the same card already saved, so no second card was made",
  live_exists: "A card for this is already waiting for approval, so no new card was made",
  already_decided: "That card was already decided, so no new card was made",
  store_failed: "Could not save the card",
};

const SCREEN_PURPOSE = "screen_untrusted_input";

const PURPOSE_WORDS: Readonly<Record<string, string>> = {
  agent_operator_turn: "Thought it through",
  agent_operator_escalation: "Formed the card",
  screen_untrusted_input: "Screened outside text before the agent read it",
};

export type TraceTone = "neutral" | "info" | "success" | "warning" | "destructive";

// One row of the disclosure: who did it, its time and cost, and what happened. effort and cache
// are the row's details, shown only when a person opens Details: the reasoning effort the call
// asked for, and the prompt cache line, each set only for a row that names a model call with that
// figure. A ref's label, when set, is the words its link shows (a carrier note's short label).
export type TraceLine = {
  key: string;
  who: string;
  meta: string[];
  effort?: string;
  cache?: string;
  text: string;
  badge: { tone: TraceTone; label: string } | null;
  refs: { table: string; id: string; label?: string }[];
};

// The carrier notes the turn's summary held (carrierMemoryEnabled), each linking to its row on the
// Memory page. A note removed since is counted, never named.
function notesLine(notes: readonly TraceNote[]): TraceLine | null {
  if (notes.length === 0) return null;
  return notesRow("memory", `Remembered ${countWords(notes.length, "note", "notes")} from the office`, notes);
}

// The key of a card's line for the notes its second check saw.
export const auditorNotesKey = (proposalId: string) => `proposal:${proposalId}:notes`;

// Whether a line lists carrier notes (its links read "Notes it read").
export const isNotesLine = (line: TraceLine) => line.key === "memory" || /^proposal:[^:]+:notes$/.test(line.key);

// The carrier notes a card's second check saw (carrierMemoryEnabled), each linking to its row on
// the Memory page; office context for the check, never its evidence for an amount.
function auditorNotesLine(p: TraceProposal): TraceLine | null {
  const notes = p.auditorNotes ?? [];
  if (notes.length === 0) return null;
  return notesRow(auditorNotesKey(p.id), `Notes the second check saw: ${countWords(notes.length, "note", "notes")} from the office`, notes);
}

function notesRow(key: string, head: string, notes: readonly TraceNote[]): TraceLine {
  const present = notes.filter((n): n is { id: string; label: string } => n.label !== null);
  const removed = notes.length - present.length;
  const text = removed > 0 ? `${head}; ${countWords(removed, "has", "have")} since been removed` : head;
  return {
    key,
    who: "Memory",
    meta: [],
    text,
    badge: null,
    refs: present.map((n) => ({ table: NOTE_REF_TABLE, id: n.id, label: n.label })),
  };
}

function callMeta(call: TraceCall): string[] {
  const out: string[] = [];
  const latency = formatLatency(call.durationMs);
  if (latency) out.push(latency);
  out.push(formatCallCost(call.costNanocents));
  return out;
}

// Adds a model call's effort to its row's details when the call names a known effort.
function withEffort(line: TraceLine, call: TraceCall | null): TraceLine {
  const effort = call ? effortWords(call.effort) : null;
  return effort === null ? line : { ...line, effort };
}

const CALL_FAILED = new Set(["failed", "unknown", "reserved"]);

function callTrouble(call: TraceCall): string | null {
  if (call.status === "failed") return `the call failed: ${failureWords(call.failure)}`;
  if (call.status === "unknown") return "the call's outcome is not known";
  if (call.status === "reserved") return "the call has not finished";
  return null;
}

function modelStepLine(s: TraceStep, call: TraceCall | null): TraceLine {
  const who = call ? modelName(call.target, call.model, call.provider) : "Muse Spark";
  const meta = call ? callMeta(call) : [];
  if (s.state === "failed" || (call && CALL_FAILED.has(call.status))) {
    const trouble = call ? callTrouble(call) : null;
    return {
      key: `step:${s.seq}`,
      who,
      meta,
      text: `Did not finish thinking it through: ${trouble ?? failureWords(s.category)}`,
      badge: { tone: "destructive", label: "Failed" },
      refs: [],
    };
  }
  if (s.state === "running") {
    return { key: `step:${s.seq}`, who, meta, text: "Still thinking it through", badge: null, refs: [] };
  }
  const n = s.toolCalls ?? 0;
  let text = n > 0 ? `Planned the next step: asked for ${countWords(n, "tool", "tools")}` : "Wrote the answer";
  const searches = s.toolSearches ?? 0;
  if (searches > 0) text += searches === 1 ? ", after one tool search" : `, after ${countWords(searches, "tool search", "tool searches")}`;
  if (s.incomplete) text += ", but the reply was cut short";
  return { key: `step:${s.seq}`, who, meta, text, badge: null, refs: [] };
}

function toolStepLine(s: TraceStep): TraceLine {
  const d = s.decision;
  if (!d) {
    const text = s.state === "running" ? `${stepLabel(s.label)}: still running` : `${stepLabel(s.label)}: did not finish`;
    return { key: `step:${s.seq}`, who: "Safety check", meta: [], text, badge: null, refs: [] };
  }
  const badge: TraceLine["badge"] =
    d.decision === "allowed"
      ? null
      : d.decision === "blocked"
        ? { tone: "warning", label: "Blocked" }
        : d.decision === "failed"
          ? { tone: "destructive", label: "Failed" }
          : { tone: "warning", label: "Refused" };
  return {
    key: `step:${s.seq}`,
    who: "Safety check",
    meta: [],
    text: `${stepLabel(s.label)}: ${decisionSentence(d)}`,
    badge,
    refs: d.refs,
  };
}

function escalationLine(s: TraceStep, call: TraceCall | null): TraceLine {
  const attempts = s.escalation?.attempts ?? 2;
  const times = attempts === 2 ? "twice" : countWords(attempts, "time", "times");
  let text = `Took over after Muse Spark could not form the card ${times}`;
  const done = s.escalation?.finishedBy === "wonder" && s.state === "done";
  if (s.state === "running") text += ", still working";
  else if (!done) {
    const trouble = call ? callTrouble(call) : s.category !== null ? failureWords(s.category) : null;
    text += trouble ? `, but did not finish: ${trouble}` : ", but did not finish the card";
  }
  return {
    key: `step:${s.seq}`,
    who: call ? modelName(call.target, call.model, call.provider) : "Muse Wonder",
    meta: call ? callMeta(call) : [],
    text,
    badge: done ? { tone: "info", label: "Escalated" } : { tone: "destructive", label: "Failed" },
    refs: [],
  };
}

// An unknown result says a card was prepared only when its step is done; otherwise it reads as
// not saved, so no line claims a card that was never made.
function proposalStepLine(s: TraceStep): TraceLine {
  const result = s.result !== null && has(PROPOSAL_RESULTS, s.result) ? s.result : null;
  const text =
    result !== null
      ? PROPOSAL_RESULTS[result]
      : s.state === "running"
        ? "Preparing a card"
        : s.state === "done"
          ? "Prepared a card"
          : PROPOSAL_RESULTS.store_failed;
  const failed = result !== null ? result === "store_failed" : s.state !== "running" && s.state !== "done";
  const badge: TraceLine["badge"] = failed ? { tone: "destructive", label: "Failed" } : null;
  return { key: `step:${s.seq}`, who: "LedgerLine", meta: [], text, badge, refs: [] };
}

function extraLine(c: TraceExtraCall): TraceLine {
  const who = modelName(c.target, c.model, c.provider);
  const meta = callMeta(c);
  if (c.purpose === SCREEN_PURPOSE || c.screen) {
    const flagged = c.screen?.verdict === "flagged";
    const trouble = callTrouble(c);
    const text = trouble
      ? `Screened outside text before the agent read it, but ${trouble}`
      : flagged
        ? "Screened outside text before the agent read it: flagged, so it was shown as data and not followed"
        : c.screen?.verdict === "clean"
          ? "Screened outside text before the agent read it: clean"
          : "Screened outside text before the agent read it";
    return {
      key: `call:${c.id}`,
      who,
      meta,
      text,
      badge: flagged ? { tone: "warning", label: "Flagged" } : trouble ? { tone: "destructive", label: "Failed" } : null,
      refs: [],
    };
  }
  const base = has(PURPOSE_WORDS, c.purpose) ? PURPOSE_WORDS[c.purpose] : "Made a model call for this turn";
  const trouble = callTrouble(c);
  return {
    key: `call:${c.id}`,
    who,
    meta,
    text: trouble ? `${base}, but ${trouble}` : base,
    badge: trouble ? { tone: "destructive", label: "Failed" } : null,
    refs: [],
  };
}

const PAIRED_PURPOSE: Readonly<Record<string, string>> = {
  model: "agent_operator_turn",
  escalation: "agent_operator_escalation",
};

// A failed model or escalation step does not link its call; the call is still in the trace. Pair
// each such step with the unlinked call of the same purpose made while it was the latest step.
function pairFailedSteps(trace: TurnTrace): { calls: Map<number, TraceCall>; used: Set<string> } {
  const calls = new Map<number, TraceCall>();
  const used = new Set<string>();
  for (const s of trace.steps) {
    if (s.call || !has(PAIRED_PURPOSE, s.kind)) continue;
    const match = trace.extraCalls.find(
      (c) => !used.has(c.id) && c.afterSeq === s.seq && c.purpose === PAIRED_PURPOSE[s.kind],
    );
    if (match) {
      calls.set(s.seq, match);
      used.add(match.id);
    }
  }
  return { calls, used };
}

// Adds a model call's details to its row: its effort, and its cache line when the call has the
// counts for one.
function withCache(line: TraceLine, call: TraceCall | null): TraceLine {
  const cache = call ? formatCached(call) : null;
  const out = withEffort(line, call);
  return cache === null ? out : { ...out, cache };
}

// Tool and proposal rows show no model call, so they carry no details.
function stepLine(s: TraceStep, call: TraceCall | null): TraceLine {
  return withCache(lineOfStep(s, call), s.kind === "tool" || s.kind === "proposal" ? null : call);
}

function lineOfStep(s: TraceStep, call: TraceCall | null): TraceLine {
  switch (s.kind) {
    case "model":
      return modelStepLine(s, call);
    case "tool":
      return toolStepLine(s);
    case "escalation":
      return escalationLine(s, call);
    case "proposal":
      return proposalStepLine(s);
    default:
      return {
        key: `step:${s.seq}`,
        who: call ? modelName(call.target, call.model, call.provider) : "LedgerLine",
        meta: call ? callMeta(call) : [],
        text: stepLabel(s.label),
        badge: null,
        refs: [],
      };
  }
}

function proposalLines(p: TraceProposal, operator: TraceCall | null): TraceLine[] {
  const out: TraceLine[] = [];
  if (has(OPERATOR_VERDICTS, p.operatorVerdict)) {
    out.push({
      key: `proposal:${p.id}:operator`,
      who: operator ? modelName(operator.target, operator.model, operator.provider) : "Muse Spark",
      meta: [],
      text: `Judged it: ${OPERATOR_VERDICTS[p.operatorVerdict]}`,
      badge: null,
      refs: [],
    });
  }
  p.exceptions.forEach((category, i) => {
    out.push({
      key: `proposal:${p.id}:exception:${i}`,
      who: "Safety check",
      meta: [],
      text: reasonSentence(category),
      badge: null,
      refs: [],
    });
  });
  if (p.flagged) {
    out.push({
      key: `proposal:${p.id}:flagged`,
      who: "Safety check",
      meta: [],
      text: "Outside text this turn read was flagged, so this card needs a closer look before approval",
      badge: { tone: "warning", label: "Flagged" },
      refs: [],
    });
  }
  if (p.auditorVerdict !== null || p.auditorCall) {
    const verdict =
      p.auditorVerdict !== null && has(AUDITOR_VERDICTS, p.auditorVerdict)
        ? AUDITOR_VERDICTS[p.auditorVerdict]
        : "Has not finished the second check yet";
    out.push(withCache({
      key: `proposal:${p.id}:auditor`,
      who: `Second check (${p.auditorCall ? modelName(p.auditorCall.target, p.auditorCall.model, p.auditorCall.provider) : "Muse Wonder"})`,
      meta: p.auditorCall ? callMeta(p.auditorCall) : [],
      text: verdict,
      badge:
        p.auditorVerdict === "block"
          ? { tone: "destructive", label: "Did not pass" }
          : p.auditorVerdict === "concerns"
            ? { tone: "warning", label: "Concerns" }
            : p.auditorVerdict === "pass"
              ? { tone: "success", label: "Passed" }
              : null,
      refs: [],
    }, p.auditorCall));
  }
  const notes = auditorNotesLine(p);
  if (notes) out.push(notes);
  return out;
}

// The steps that led to one proposal: the gateway attempts of its tool since the previous card of
// that tool (a blocked first try among them), the escalation that formed it, the model steps that
// asked for those tools, the step that saved it, and a flagged screening when it is flagged.
function proposalSeqs(trace: TurnTrace, p: TraceProposal): { seqs: Set<number>; operator: TraceCall | null } {
  const seqs = new Set<number>();
  const own = trace.steps.find((s) => s.decision?.id === p.gatewayDecisionId);
  if (own?.decision) {
    const tool = own.decision.tool;
    const others = new Set(trace.proposals.filter((x) => x.id !== p.id).map((x) => x.gatewayDecisionId));
    const floor = Math.max(
      0,
      ...trace.steps
        .filter((s) => s.seq < own.seq && s.decision?.tool === tool && others.has(s.decision.id))
        .map((s) => s.seq),
    );
    const issuers = new Set<string>();
    for (const s of trace.steps) {
      if (s.seq <= floor || s.seq > own.seq) continue;
      if (s.kind === "escalation" || s.decision?.tool === tool) {
        seqs.add(s.seq);
        if (s.decision?.issuedBy) issuers.add(s.decision.issuedBy);
      }
    }
    for (const s of trace.steps) {
      if (s.call && issuers.has(s.call.id)) seqs.add(s.seq);
    }
  }
  for (const s of trace.steps) if (s.proposalId === p.id) seqs.add(s.seq);
  const issuer = own?.decision?.issuedBy ?? null;
  const operator = issuer ? (trace.steps.find((s) => s.call?.id === issuer)?.call ?? null) : null;
  return { seqs, operator };
}

// The disclosure's rows, in the order things happened. With a proposal id, only that card's rows
// and its verdict lines; without, the whole turn.
export function traceLines(trace: TurnTrace, proposalId?: string): TraceLine[] {
  const { calls: paired, used } = pairFailedSteps(trace);
  const proposal = proposalId ? (trace.proposals.find((p) => p.id === proposalId) ?? null) : null;
  if (proposalId && !proposal) return [];
  const subset = proposal ? proposalSeqs(trace, proposal) : null;
  const auditorCalls = new Set(trace.proposals.flatMap((p) => (p.auditorCall ? [p.auditorCall.id] : [])));
  const extras = trace.extraCalls.filter((c) => !used.has(c.id) && !auditorCalls.has(c.id));
  const out: TraceLine[] = [];
  const pushExtras = (after: number) => {
    for (const c of extras) {
      if (c.afterSeq !== after) continue;
      if (proposal && !(proposal.flagged && c.screen?.verdict === "flagged")) continue;
      out.push(withCache(extraLine(c), c));
    }
  };
  // The notes were read before the first step, so they show first, on the whole turn's view only.
  const notes = proposal ? null : notesLine(trace.notesUsed ?? []);
  if (notes) out.push(notes);
  pushExtras(0);
  for (const s of trace.steps) {
    if (!subset || subset.seqs.has(s.seq)) out.push(stepLine(s, s.call ?? paired.get(s.seq) ?? null));
    pushExtras(s.seq);
  }
  // Calls placed after a step this trace does not list still show, at the end.
  const known = new Set([0, ...trace.steps.map((s) => s.seq)]);
  for (const c of extras) {
    if (known.has(c.afterSeq)) continue;
    if (proposal && !(proposal.flagged && c.screen?.verdict === "flagged")) continue;
    out.push(withCache(extraLine(c), c));
  }
  if (proposal) out.push(...proposalLines(proposal, subset?.operator ?? null));
  return out;
}

// The distinct model calls behind these rows, in the order the rows name them.
function traceCalls(trace: TurnTrace, proposalId?: string): TraceCall[] {
  const keys = new Set(traceLines(trace, proposalId).map((l) => l.key));
  const { calls: paired } = pairFailedSteps(trace);
  const calls = new Map<string, TraceCall>();
  for (const s of trace.steps) {
    if (!keys.has(`step:${s.seq}`)) continue;
    const c = s.call ?? paired.get(s.seq) ?? null;
    if (c) calls.set(c.id, c);
  }
  for (const c of trace.extraCalls) if (keys.has(`call:${c.id}`)) calls.set(c.id, c);
  for (const p of trace.proposals) {
    if (p.auditorCall && keys.has(`proposal:${p.id}:auditor`)) calls.set(p.auditorCall.id, p.auditorCall);
  }
  return [...calls.values()];
}

// Time and cost of a set of calls. The cost is the sum of each call's shown figure, so the rows
// add up to it and it is never below the ledger; from a dollar up it reads in whole cents, rounded
// up.
type CallSum = { calls: number; spend: string; ms: number; unsettled: number; unknown: number };

function sumCalls(calls: readonly TraceCall[]): CallSum {
  let tenths = 0;
  let unsettled = 0;
  let unknown = 0;
  let ms = 0;
  for (const c of calls) {
    if (c.costNanocents === null) unsettled++;
    else if (isNanocents(c.costNanocents)) tenths += shownTenths(c.costNanocents);
    else unknown++;
    if (c.durationMs !== null && Number.isSafeInteger(c.durationMs) && c.durationMs > 0) ms += c.durationMs;
  }
  const spend = tenths === 0 ? "0 cents" : tenths >= 1_000 ? formatCents(ceilDiv(tenths, 10)) : tenthsText(tenths);
  return { calls: calls.length, spend, ms, unsettled, unknown };
}

// The footer: the distinct model calls behind these rows, their time and cost.
export function traceTotals(trace: TurnTrace, proposalId?: string): string | null {
  const calls = traceCalls(trace, proposalId);
  if (calls.length === 0) return null;
  const sum = sumCalls(calls);
  const parts = [countWords(sum.calls, "model call", "model calls"), `${sum.spend} in all`];
  const time = formatLatency(sum.ms);
  if (time && sum.ms > 0) parts.push(`${time} of model time`);
  let line = parts.join(", ");
  if (sum.unsettled > 0) line += `; ${countWords(sum.unsettled, "call is", "calls are")} not settled yet`;
  if (sum.unknown > 0) line += `; ${countWords(sum.unknown, "call has", "calls have")} no known cost`;
  return line;
}

// One model in the "Models used" group: its name as the rows show it, its job in a few words, and
// its calls, time and cost behind these rows, summed the way the footer sums them, so the models
// add up to the footer.
export type TraceModel = { key: string; name: string; job: string; calls: string; time: string | null; cost: string };

export function traceModels(trace: TurnTrace, proposalId?: string): TraceModel[] {
  const groups = new Map<string, { target: string; calls: TraceCall[] }>();
  for (const c of traceCalls(trace, proposalId)) {
    const name = modelName(c.target, c.model, c.provider);
    const group = groups.get(name);
    if (group) group.calls.push(c);
    else groups.set(name, { target: c.target, calls: [c] });
  }
  return [...groups.entries()].map(([name, g]) => {
    const sum = sumCalls(g.calls);
    let cost = sum.spend;
    if (sum.unsettled > 0) cost += `, ${countWords(sum.unsettled, "call", "calls")} not settled yet`;
    if (sum.unknown > 0) cost += `, ${countWords(sum.unknown, "call", "calls")} with no known cost`;
    return {
      key: name,
      name,
      job: targetRole(g.target),
      calls: countWords(sum.calls, "call", "calls"),
      time: sum.ms > 0 ? formatLatency(sum.ms) : null,
      cost,
    };
  });
}
