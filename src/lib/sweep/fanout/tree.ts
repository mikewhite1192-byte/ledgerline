import type { Queryable } from "../../db";
import { SEE_THE_RECORD } from "./check";
import { SEE_THE_RECORDS } from "./plan";
import type { FanoutCounts } from "./reconcile";
import { BRIEF_MAX, DISAGREEMENT_MAX, NOTE_MAX, SUMMARY_MAX, isRecordTable, parseJson, scrubFigures } from "./schemas";

// The run page's "How the week was checked" (design 3.8): the ordering, one node per driver's
// check and the comparison, from the run's own rows. Each node names its turn, whose steps the
// page reads only when someone opens it (the run's trace route). Every model string passes the
// figures check again here, so no amount a model wrote reaches the page even from an older row;
// every number shown is the server's.

export type FanoutStatus =
  | "planning"
  | "checking"
  | "reconciling"
  | "done"
  | "plan_skipped"
  | "plan_budget"
  | "skipped_daily_cap";

export type FanoutCheckStatus = "queued" | "running" | "done" | "unparsed" | "timed_out" | "budget" | "error";

export type FanoutIssueView = { category: string; sources: { table: string; id: string }[]; note: string };

export type FanoutCheckView = {
  driverId: string;
  driverCode: string | null;
  // The driver's name, read by the server for this page only; never sent to a model.
  driverLabel: string | null;
  priority: number;
  focus: string[];
  brief: string | null;
  status: FanoutCheckStatus;
  confidence: "high" | "medium" | "low" | null;
  issues: FanoutIssueView[];
  turnId: string | null;
  costCents: number;
};

export type FanoutTree = {
  status: FanoutStatus;
  plan: { summary: string | null; turnId: string | null };
  skipped: { driverId: string; driverCode: string | null; driverLabel: string | null; reason: "over_limit" | "no_activity" }[];
  checks: FanoutCheckView[];
  reconcile: {
    counts: FanoutCounts | null;
    summary: string | null;
    disagreements: { driverId: string; driverCode: string | null; driverLabel: string | null; category: string; text: string }[];
    turnId: string | null;
  };
  finished: boolean;
};

export type FanoutRow = {
  status: string;
  plan_turn_id: string | null;
  plan_json: string | null;
  reconcile_turn_id: string | null;
  reconcile_json: string | null;
  counts: string | null;
  finished_at: string | null;
};

export type FanoutCheckRow = {
  driver_id: string;
  priority: number | string;
  focus: string;
  brief: string | null;
  status: string;
  result: string | null;
  turn_id: string | null;
  cost_cents: number | string;
};

export type DriverNames = ReadonlyMap<string, { code: string | null; label: string | null }>;

const STATUSES: readonly FanoutStatus[] = [
  "planning",
  "checking",
  "reconciling",
  "done",
  "plan_skipped",
  "plan_budget",
  "skipped_daily_cap",
];
const CHECK_STATUSES: readonly FanoutCheckStatus[] = ["queued", "running", "done", "unparsed", "timed_out", "budget", "error"];
const COUNT_KEYS: readonly (keyof FanoutCounts)[] = [
  "engine",
  "agreed",
  "engine_only",
  "spark_only",
  "drivers_checked",
  "drivers_unchecked",
];
const CODE = /^[a-z_]{2,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const objectOf = (raw: string | null): Record<string, unknown> | null => {
  const v = raw === null ? null : parseJson(raw);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};
const arrayOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const textOr = (v: unknown, replacement: string, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = scrubFigures(v, replacement, max);
  return t === "" ? null : t;
};
const idOf = (v: unknown): string | null => (typeof v === "string" && UUID.test(v.toLowerCase()) ? v.toLowerCase() : null);
const whole = (v: unknown): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

function countsOf(raw: string | null): FanoutCounts | null {
  const o = objectOf(raw);
  if (!o) return null;
  const out = {} as FanoutCounts;
  for (const k of COUNT_KEYS) {
    const n = Number(o[k]);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    out[k] = n;
  }
  return out;
}

function issuesOf(result: Record<string, unknown> | null): FanoutIssueView[] {
  return arrayOf(result?.issues).flatMap((i): FanoutIssueView[] => {
    if (!i || typeof i !== "object") return [];
    const { category, sources, note } = i as Record<string, unknown>;
    if (typeof category !== "string" || !CODE.test(category)) return [];
    const refs = arrayOf(sources).flatMap((s) => {
      if (!s || typeof s !== "object") return [];
      const { table, id } = s as Record<string, unknown>;
      const rid = idOf(id);
      return typeof table === "string" && isRecordTable(table) && rid ? [{ table, id: rid }] : [];
    });
    if (refs.length === 0) return [];
    return [{ category, sources: refs, note: textOr(note, SEE_THE_RECORD, NOTE_MAX) ?? SEE_THE_RECORD }];
  });
}

// The tree from the rows (pure, so the page's figure guard is tested without a database).
export function treeOf(row: FanoutRow, checks: FanoutCheckRow[], names: DriverNames): FanoutTree {
  const name = (id: string) => names.get(id) ?? { code: null, label: null };
  const plan = objectOf(row.plan_json);
  const reconcile = objectOf(row.reconcile_json);
  const status = (STATUSES as readonly string[]).includes(row.status) ? (row.status as FanoutStatus) : "done";
  return {
    status,
    plan: { summary: textOr(plan?.summary, SEE_THE_RECORDS, SUMMARY_MAX), turnId: row.plan_turn_id },
    skipped: arrayOf(plan?.skipped).flatMap((s) => {
      if (!s || typeof s !== "object") return [];
      const { driverId, reason } = s as Record<string, unknown>;
      const id = idOf(driverId);
      if (!id || (reason !== "over_limit" && reason !== "no_activity")) return [];
      // Only the drivers left out for the limit are worth a line; a driver with no records this
      // week had nothing to check.
      if (reason !== "over_limit") return [];
      return [{ driverId: id, driverCode: name(id).code, driverLabel: name(id).label, reason }];
    }),
    checks: checks.map((c): FanoutCheckView => {
      const id = c.driver_id.toLowerCase();
      const result = c.status === "done" ? objectOf(c.result) : null;
      const confidence = result?.confidence;
      return {
        driverId: id,
        driverCode: name(id).code,
        driverLabel: name(id).label,
        priority: whole(c.priority),
        focus: arrayOf(parseJson(c.focus))
          .filter((f): f is string => typeof f === "string" && CODE.test(f))
          .slice(0, 4),
        brief: textOr(c.brief, SEE_THE_RECORDS, BRIEF_MAX),
        status: (CHECK_STATUSES as readonly string[]).includes(c.status) ? (c.status as FanoutCheckStatus) : "error",
        confidence: confidence === "high" || confidence === "medium" || confidence === "low" ? confidence : null,
        issues: issuesOf(result),
        turnId: c.turn_id,
        costCents: whole(c.cost_cents),
      };
    }),
    reconcile: {
      counts: countsOf(row.counts),
      summary: textOr(reconcile?.summary, SEE_THE_RECORDS, SUMMARY_MAX),
      disagreements: arrayOf(reconcile?.disagreements).flatMap((d) => {
        if (!d || typeof d !== "object") return [];
        const { driverId, category, text } = d as Record<string, unknown>;
        const id = idOf(driverId);
        const t = textOr(text, SEE_THE_RECORDS, DISAGREEMENT_MAX);
        if (!id || typeof category !== "string" || !CODE.test(category) || !t) return [];
        return [{ driverId: id, driverCode: name(id).code, driverLabel: name(id).label, category, text: t }];
      }),
      turnId: row.reconcile_turn_id,
    },
    finished: row.finished_at !== null,
  };
}

// The run's tree, or null when the run never reached the second opinion. Inside the caller's
// tenant transaction: row security scopes every read to the carrier, and each read names it too.
export async function readFanoutTree(q: Queryable, runId: string): Promise<FanoutTree | null> {
  const rows = await q.query<FanoutRow>(
    `SELECT status, plan_turn_id, CAST(plan_json AS text) AS plan_json, reconcile_turn_id,
            CAST(reconcile_json AS text) AS reconcile_json, CAST(counts AS text) AS counts,
            CAST(finished_at AS text) AS finished_at
       FROM sweep_fanout WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()`,
    [runId],
  );
  if (!rows[0]) return null;
  const checks = await q.query<FanoutCheckRow>(
    `SELECT driver_id, priority, CAST(focus AS text) AS focus, brief, status, CAST(result AS text) AS result,
            turn_id, cost_cents
       FROM sweep_fanout_checks WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()
      ORDER BY priority, driver_id`,
    [runId],
  );
  const drivers = await q.query<{ id: string; code: string | null; label: string | null }>(
    "SELECT id, code, first_name || ' ' || last_name AS label FROM drivers WHERE tenant_id = current_tenant_id()",
  );
  const names = new Map(drivers.map((d) => [d.id.toLowerCase(), { code: d.code, label: d.label }]));
  return treeOf(rows[0], checks, names);
}
