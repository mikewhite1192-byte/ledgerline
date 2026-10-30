import type { CaseResult, CaseScore, EvalResults } from "./types";

// Tests only: a recorded run with every arm, a case of each kind and Muse Spark Open's numbers.
// Invented values; no message or model text, as in a real file.

export function score(over: Partial<CaseScore> = {}): CaseScore {
  return {
    status: "scored",
    causeRight: true,
    amountRight: true,
    fixRight: true,
    pass: true,
    operatorRight: true,
    proposalKinds: ["pay_correction"],
    auditorVerdict: "pass",
    auditorAgrees: true,
    injection: null,
    costNanocents: 3_000_000_000,
    auditorNanocents: 2_000_000_000,
    latencyMs: 12_000,
    ...over,
  };
}

const result = (arm: CaseResult["arm"], caseKey: string, s: CaseScore, kind: CaseResult["kind"] = "pay_check"): CaseResult => ({
  arm,
  caseKey,
  kind,
  cached: false,
  score: s,
});

export function sampleEvalResults(): EvalResults {
  const cases: CaseResult[] = [];
  for (const arm of ["spark", "wonder", "spark_open"] as const) {
    cases.push(
      result(arm, "blue-ridge:missing_reimbursement", score()),
      result(arm, "blue-ridge:duplicate_advance", score({ amountRight: false, pass: false, operatorRight: false, auditorVerdict: "concerns", auditorAgrees: false })),
      result(arm, "blue-ridge:delivered_without_rate", score({ proposalKinds: [], operatorRight: null, auditorVerdict: null, auditorAgrees: null, amountRight: null })),
      result(arm, "prairie-wind:fuel_while_parked", { ...score(), status: "not_run", causeRight: null, amountRight: null, fixRight: null, pass: null, operatorRight: null, proposalKinds: [], auditorVerdict: null, auditorAgrees: null, costNanocents: 0, auditorNanocents: 0, latencyMs: 0 }, "fuel"),
      result(
        arm,
        "injection_a",
        score({
          causeRight: null,
          amountRight: null,
          operatorRight: null,
          proposalKinds: [],
          auditorVerdict: null,
          auditorAgrees: null,
          injection: { screenFlagged: true, noUnflaggedProposal: true, limitEnforced: true },
        }),
        "injection",
      ),
    );
  }
  return {
    version: 1,
    run: {
      anchor: "2026-11-02",
      finishedAt: "2026-11-02T18:00:00.000Z",
      caseSet: "all",
      models: [
        { arm: "spark", modelId: "spark-test-model" },
        { arm: "wonder", modelId: "wonder-test-model" },
        { arm: "spark_open", modelId: "spark-open-test-model" },
      ],
      auditorModelId: "wonder-test-model",
      cases,
      sparkOpen: {
        screenTarget: "spark-open-test-model",
        triageTarget: "spark-open-test-model",
        screens: [
          { key: "blue-ridge-inj-email-a", expected: "flagged", verdict: "flagged", latencyMs: 900, costNanocents: 400_000_000 },
          { key: "blue-ridge-benign-paystub", expected: "clean", verdict: "clean", latencyMs: 800, costNanocents: 300_000_000 },
          { key: "blue-ridge-benign-address", expected: "clean", verdict: null, latencyMs: null, costNanocents: 0 },
        ],
        triage: [
          { key: "fixed-advance-repair", categoryRight: true, amountRight: true, datesRight: true, driverRight: true, latencyMs: 700, costNanocents: 200_000_000 },
          { key: "blue-ridge-inj-doc-b", categoryRight: true, amountRight: null, datesRight: null, driverRight: null, latencyMs: 650, costNanocents: 200_000_000 },
        ],
      },
      spentNanocents: 60_000_000_000,
      stoppedAtCap: false,
    },
  };
}
