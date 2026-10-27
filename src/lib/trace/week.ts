import { CORE_TARGETS, LATER_TARGETS, OTHER_MODEL, modelName, targetJob, targetName } from "./format";
import type { WeekRaw } from "./types";

// The Meta models page's numbers: the week's grouped rows summed per model. Pure; the gateway's
// store reads the rows (store/trace.ts). Counts and nanocents stay whole numbers; a figure that
// is not one makes the whole week unknown rather than a smaller, wrong total.

export type ModelTotals = {
  target: string;
  name: string;
  job: string;
  versions: string[];
  calls: number;
  ok: number;
  incomplete: number;
  failed: number;
  pending: number;
  costNanocents: number;
  heldNanocents: number;
  unsettled: number;
  p50Ms: number | null;
};

export type ModelWeek = {
  week: WeekRaw["week"];
  models: ModelTotals[];
  calls: number;
  costNanocents: number;
  heldNanocents: number;
  unsettled: number;
  decisions: { allowed: number; blocked: number; refused: number; failed: number; total: number };
  screenings: { clean: number; flagged: number; byModel: number; byCache: number; byPattern: number; errored: number; total: number };
  escalations: number;
};

const KNOWN = new Set<string>([...CORE_TARGETS, ...LATER_TARGETS]);

function whole(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} is not a whole number`);
  return n;
}

function empty(target: string): ModelTotals {
  return {
    target,
    name: target === "other" ? OTHER_MODEL : targetName(target),
    job: targetJob(target),
    versions: [],
    calls: 0,
    ok: 0,
    incomplete: 0,
    failed: 0,
    pending: 0,
    costNanocents: 0,
    heldNanocents: 0,
    unsettled: 0,
    p50Ms: null,
  };
}

export function summarizeModelWeek(raw: WeekRaw): ModelWeek {
  const byTarget = new Map<string, ModelTotals>();
  for (const t of CORE_TARGETS) byTarget.set(t, empty(t));
  const otherTargets = new Set<string>();
  for (const g of raw.groups) {
    const key = KNOWN.has(g.target) ? g.target : "other";
    if (key === "other") otherTargets.add(g.target);
    const m = byTarget.get(key) ?? empty(key);
    byTarget.set(key, m);
    const calls = whole(g.calls, "a call count");
    m.calls += calls;
    if (g.status === "ok") m.ok += calls;
    else if (g.status === "incomplete") m.incomplete += calls;
    else if (g.status === "failed") m.failed += calls;
    else m.pending += calls;
    m.costNanocents += whole(g.costNanocents, "a cost");
    m.heldNanocents += whole(g.heldNanocents, "a held amount");
    m.unsettled += whole(g.unsettled, "an unsettled count");
    const version = key === "other" ? OTHER_MODEL : modelName(g.target, g.model);
    if (calls > 0 && !m.versions.includes(version)) m.versions.push(version);
  }
  for (const l of raw.latencies) {
    const key = KNOWN.has(l.target) ? l.target : "other";
    const m = byTarget.get(key);
    if (!m || l.p50Ms === null) continue;
    // Medians of different models cannot be merged, so a mixed "other" shows none.
    if (key === "other" && otherTargets.size !== 1) continue;
    m.p50Ms = whole(l.p50Ms, "a latency");
  }
  const order = [...CORE_TARGETS, ...LATER_TARGETS, "other"];
  const models = order.flatMap((t) => {
    const m = byTarget.get(t);
    if (!m) return [];
    return (CORE_TARGETS as readonly string[]).includes(t) || m.calls > 0 ? [m] : [];
  });
  for (const m of models) m.versions.sort();

  const decisions = { allowed: 0, blocked: 0, refused: 0, failed: 0, total: 0 };
  for (const d of raw.decisions) {
    const n = whole(d.count, "a decision count");
    decisions.total += n;
    if (d.decision === "allowed") decisions.allowed += n;
    else if (d.decision === "blocked") decisions.blocked += n;
    else if (d.decision === "failed") decisions.failed += n;
    else decisions.refused += n;
  }
  const screenings = { clean: 0, flagged: 0, byModel: 0, byCache: 0, byPattern: 0, errored: 0, total: 0 };
  for (const s of raw.screenings) {
    const n = whole(s.count, "a screening count");
    screenings.total += n;
    if (s.verdict === "clean") screenings.clean += n;
    else screenings.flagged += n;
    if (s.via === "model") screenings.byModel += n;
    else if (s.via === "cache") screenings.byCache += n;
    else if (s.via === "pattern") screenings.byPattern += n;
    else screenings.errored += n;
  }
  return {
    week: raw.week,
    models,
    calls: models.reduce((a, m) => a + m.calls, 0),
    costNanocents: models.reduce((a, m) => a + m.costNanocents, 0),
    heldNanocents: models.reduce((a, m) => a + m.heldNanocents, 0),
    unsettled: models.reduce((a, m) => a + m.unsettled, 0),
    decisions,
    screenings,
    escalations: whole(raw.escalations, "an escalation count"),
  };
}
