import type { ProposalKind } from "../agent/gateway/types";

// The eval's shapes. Every stored or committed field is a boolean, a number of cents, nanocents
// or milliseconds, a model id, a case key or a fixed category word: never a message or model text.

// The three ways the operator's calls are sent. spark is the product as shipped; wonder and
// spark_open redirect the operator's Muse Spark calls (the escalation is left as it is). The
// second check stays on Muse Wonder in every arm, because that is the product.
export const ARMS = ["spark", "wonder", "spark_open"] as const;
export type Arm = (typeof ARMS)[number];

export const CASE_KINDS = ["pay_check", "payment", "detention", "fuel", "injection"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export type SourceRef = { table: string; id: string };

export type Expected = {
  // The rules engine check (or the injection case) the case plants.
  check: string;
  // The record at fault, cited as the proposal's source or named in the answer.
  sourceTable: string;
  sourceId: string;
  // The engine's amount for the fix, signed for a pay correction (positive is owed to the driver),
  // or the figure an answer-only case must say. Null when no amount applies.
  cents: number | null;
  // The proposal kind the right fix uses, or null when the right outcome is an answer only.
  fixKind: ProposalKind | null;
  // How many proposals of fixKind the engine's fix takes (a fuel item on the wrong driver is two
  // corrections, one per driver); 0 for an answer-only case.
  fixCount: number;
  // The engine's signed amount for each of those proposals, in any order (one per leg); empty for
  // an answer-only case. The right amount is every leg's, not one of them.
  fixCents: readonly number[];
  // Answer-only cases: the whole tokens the answer must hold to name the cause (the engine's own
  // word for it, a dollar figure). A token counts only when a read tool of the turn returned it
  // and the case's sentence does not hold it, so repeating the question never names the cause.
  // Empty when a proposal carries the cause.
  causeTokens: readonly (readonly string[])[];
};

// An injection case (agent-core design section 6): the planted outside input and what is checked.
export type InjectionSpec = {
  seedKey: string;
  inputId: string;
  // Screening categories the screen must report (a subset check).
  categories: readonly string[];
  // Case A only: an advance at the asked amount must be blocked over its limit.
  limit: boolean;
};

// Why a case is not run at all. Fuel cases are reported as not run, never as zero, when the
// product's own fuel checks would not report the planted fill-up.
export type SkipReason = "fuel_before_start";

export type EvalCase = {
  key: string;
  carrierSlug: string;
  kind: CaseKind;
  // The fixed sentence the turn is asked. Never committed anywhere but this source.
  prompt: string;
  expected: Expected;
  injection: InjectionSpec | null;
  skip: SkipReason | null;
};

// scored: the turn finished and was read back. unknown: the outcome is ambiguous (a model call
// failed or timed out, the store failed, a proposal took no second-check verdict), never a pass
// or a fail. not_run: the case was skipped. over_cap: the run's own spend stop was reached, by the
// turn or by its second check, or before the case started.
export const CASE_STATUSES = ["scored", "unknown", "not_run", "over_cap"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export type AuditorVerdict = "pass" | "concerns" | "block" | "unknown";

export type InjectionScore = {
  screenFlagged: boolean | null;
  noUnflaggedProposal: boolean | null;
  limitEnforced: boolean | null;
};

export type CaseScore = {
  status: CaseStatus;
  // Null: not applicable to the case, or not known.
  causeRight: boolean | null;
  amountRight: boolean | null;
  fixRight: boolean | null;
  pass: boolean | null;
  // The operator's fix and amount were right (the agreement stat's "operator right"); null when
  // the case made no proposal or is not scored.
  operatorRight: boolean | null;
  proposalKinds: string[];
  // The second check's verdict across the turn's proposals: the worst one, or null with none.
  auditorVerdict: AuditorVerdict | null;
  // true when the second check passed every proposal, false when it raised a concern or block on
  // any, null when it gave no verdict.
  auditorAgrees: boolean | null;
  injection: InjectionScore | null;
  // How the operator's turn ended, as the turn stored it (a fixed word such as steps, cents or
  // model_too_expensive), so an unknown case says why. Null for a turn that finished with an
  // answer, and for a case whose turn never ran or never ended.
  endedReason: string | null;
  costNanocents: number;
  auditorNanocents: number;
  latencyMs: number;
};

export type CaseResult = { arm: Arm; caseKey: string; kind: CaseKind; cached: boolean; score: CaseScore };

export const isNullableBool = (v: unknown) => v === null || typeof v === "boolean";
export const isCount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// A CaseScore read strictly (a cache file, a recorded results file): anything that is not
// exactly one is refused.
export function isCaseScore(v: unknown): v is CaseScore {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const injection = s.injection;
  const injectionOk =
    injection === null ||
    (typeof injection === "object" &&
      ["screenFlagged", "noUnflaggedProposal", "limitEnforced"].every((k) => isNullableBool((injection as Record<string, unknown>)[k])));
  return (
    (CASE_STATUSES as readonly unknown[]).includes(s.status) &&
    ["causeRight", "amountRight", "fixRight", "pass", "operatorRight", "auditorAgrees"].every((k) => isNullableBool(s[k])) &&
    Array.isArray(s.proposalKinds) &&
    s.proposalKinds.every((k) => typeof k === "string" && /^[a-z_]{1,40}$/.test(k)) &&
    (s.auditorVerdict === null || ["pass", "concerns", "block", "unknown"].includes(s.auditorVerdict as string)) &&
    injectionOk &&
    (s.endedReason === null || (typeof s.endedReason === "string" && /^[a-z_]{2,40}$/.test(s.endedReason))) &&
    isCount(s.costNanocents) &&
    isCount(s.auditorNanocents) &&
    isCount(s.latencyMs)
  );
}

// Muse Spark Open's own numbers: the safety screen and the triage sort.
export type ScreenResult = { key: string; expected: "clean" | "flagged"; verdict: "clean" | "flagged" | null; latencyMs: number | null; costNanocents: number };
export type TriageResult = {
  key: string;
  categoryRight: boolean | null;
  amountRight: boolean | null;
  datesRight: boolean | null;
  driverRight: boolean | null;
  latencyMs: number | null;
  costNanocents: number;
};

export type SparkOpenResults = {
  screenTarget: string;
  triageTarget: string;
  screens: ScreenResult[];
  triage: TriageResult[];
};

export type ArmModel = { arm: Arm; modelId: string | null };

export type EvalResults = {
  // 1: this file's shape. A run of null means no run has been recorded yet.
  version: 1;
  run: {
    anchor: string;
    // When the run finished (an instant, for the README line). Never shown on a page.
    finishedAt: string;
    caseSet: "all" | "10";
    models: ArmModel[];
    auditorModelId: string | null;
    cases: CaseResult[];
    sparkOpen: SparkOpenResults | null;
    spentNanocents: number;
    stoppedAtCap: boolean;
  } | null;
};
