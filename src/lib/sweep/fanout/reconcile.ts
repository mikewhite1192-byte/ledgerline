import type { ValidCheck } from "./check";
import { SEE_THE_RECORDS } from "./plan";
import {
  DISAGREEMENT_MAX,
  MAX_DISAGREEMENTS,
  ReconcileAnswer,
  SUMMARY_MAX,
  parseJson,
  scrubFigures,
  type CheckCategory,
} from "./schemas";

// The comparison (design 3.4). The server counts first, by whole-value match: an engine finding
// agrees with a check's issue when the driver and the category are the same and the finding's
// record (its first source) is one of the records the issue cites. Muse Wonder then writes the
// prose; its answer never changes a count. An issue no engine finding matches becomes a
// needs_person sweep item (never a fix).

export type EngineFinding = { driverId: string; category: string; table: string; id: string };

export type CheckRow = { driverId: string; status: string; answer: ValidCheck | null };

export type FanoutCounts = {
  // The engine's findings on the drivers that were checked.
  engine: number;
  agreed: number;
  engine_only: number;
  spark_only: number;
  drivers_checked: number;
  drivers_unchecked: number;
};

export type SparkOnly = { driverId: string; category: CheckCategory; sources: { table: string; id: string }[]; note: string };

const key = (driverId: string, category: string, table: string, id: string) =>
  `${driverId.toLowerCase()}|${category}|${table}|${id.toLowerCase()}`;

export function computeCounts(engine: EngineFinding[], checks: CheckRow[]): { counts: FanoutCounts; sparkOnly: SparkOnly[] } {
  const done = checks.filter((c) => c.status === "done" && c.answer !== null);
  const checked = new Set(done.map((c) => c.driverId.toLowerCase()));
  const findings = new Map<string, EngineFinding>();
  for (const f of engine) {
    if (checked.has(f.driverId.toLowerCase())) findings.set(key(f.driverId, f.category, f.table, f.id), f);
  }
  const agreed = new Set<string>();
  const sparkOnly = new Map<string, SparkOnly>();
  for (const c of done) {
    for (const issue of c.answer!.issues) {
      const hits = issue.sources.map((s) => key(c.driverId, issue.category, s.table, s.id)).filter((k) => findings.has(k));
      if (hits.length > 0) {
        for (const h of hits) agreed.add(h);
        continue;
      }
      const first = issue.sources[0];
      const k = key(c.driverId, issue.category, first.table, first.id);
      if (!sparkOnly.has(k)) {
        sparkOnly.set(k, { driverId: c.driverId.toLowerCase(), category: issue.category, sources: issue.sources, note: issue.note });
      }
    }
  }
  return {
    counts: {
      engine: findings.size,
      agreed: agreed.size,
      engine_only: findings.size - agreed.size,
      spark_only: sparkOnly.size,
      drivers_checked: done.length,
      drivers_unchecked: checks.length - done.length,
    },
    sparkOnly: [...sparkOnly.values()],
  };
}

// The needs_person item's dedupe key for an issue only a check raised: one per category and
// record per week, whichever run raised it.
export function fanoutFindingKey(s: SparkOnly): string {
  const first = s.sources[0];
  return `fanout:${s.category}:${first.table}:${first.id.toLowerCase()}:1`;
}

export const RECONCILE_PROMPT =
  "You compare two checks of one trucking carrier's weekly driver pay: the rules engine's findings " +
  "and a second, per-driver check. You get the server's counts, the engine's findings and the " +
  "second check's issues, as driver ids, categories and record ids. Write a short summary of " +
  "where they agree and differ, and list the disagreements worth a person's look, one sentence " +
  "each. Never state an amount or any figure. Answer as JSON.";

export function reconcileInput(counts: FanoutCounts, engine: EngineFinding[], checks: CheckRow[]): string {
  return JSON.stringify({
    counts,
    engineFindings: engine.map((f) => ({ driverId: f.driverId, category: f.category, record: { table: f.table, id: f.id } })),
    secondCheck: checks.map((c) => ({
      driverId: c.driverId,
      status: c.status,
      issues: (c.answer?.issues ?? []).map((i) => ({ category: i.category, records: i.sources })),
    })),
  });
}

export type ValidReconcile = {
  summary: string | null;
  disagreements: { driverId: string; category: CheckCategory; text: string }[];
};

// Ids must be drivers the run checked; text with a figure in it becomes "see the records".
export function validateReconcile(raw: string, drivers: ReadonlySet<string>): ValidReconcile | null {
  const parsed = ReconcileAnswer.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  const summary = scrubFigures(parsed.data.summary, SEE_THE_RECORDS, SUMMARY_MAX);
  const disagreements: ValidReconcile["disagreements"] = [];
  for (const d of parsed.data.disagreements) {
    const id = d.driverId.toLowerCase();
    if (!drivers.has(id)) continue;
    const text = scrubFigures(d.text, SEE_THE_RECORDS, DISAGREEMENT_MAX);
    if (text === "") continue;
    disagreements.push({ driverId: id, category: d.category, text });
    if (disagreements.length >= MAX_DISAGREEMENTS) break;
  }
  return { summary: summary === "" ? null : summary, disagreements };
}
