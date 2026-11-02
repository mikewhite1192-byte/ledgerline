import { flags, type AutopilotCeiling } from "../../config/flags";
import type { Session } from "../auth/claims";
import { readRole } from "../auth/role";
import { DbError, type Queryable } from "../db";
import { autoAllowed } from "../money/never-alone";
import { isUuid } from "../uuid";
import { isPaused } from "./facts";
import { DRIVER_KINDS } from "./policy";
import { readPause } from "./read";
import { isAutopilotSub } from "./session";
import { isServiceSub } from "../sweep/service-session";

// The owner's autopilot rules from the app (docs: AUTOPILOT-RULES, D-094): parse one rule save,
// save it, and read every rule with what the autopilot may do on each kind. Only an admin saves; a
// service login (the sweep's or the autopilot's) never does. Each save writes the rule and one
// autopilot_changes row (0089) in the caller's tenant transaction, so a change with no record
// cannot exist. A save never touches a stored decision: only proposals decided after it read the
// new rule. Agent code never imports this file (eslint.config.mjs). No model call, and nothing
// here approves or moves money.

// The kinds a rule may name: the kind check of autopilot_rules (0070) and of autopilot_changes
// (0089), proven equal by rules-admin.test.ts.
export const RULE_KINDS = [
  "advance_payout",
  "pay_correction",
  "invoice_fix",
  "load_rate_fill",
  "invoice_post",
  "payment_reapply",
  "settlement_approve",
  "detention_charge",
  "factoring_request",
  "bill_defer",
  "collections_chase",
  "pay_rule_change",
  "card_match",
  "money_code",
  "pay_policy_setup",
  "load_create",
  "escrow_release",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

const RULE_KIND_SET: ReadonlySet<string> = new Set(RULE_KINDS);

export function isRuleKind(value: unknown): value is RuleKind {
  return typeof value === "string" && RULE_KIND_SET.has(value);
}

export const RULE_MODES = ["off", "ask", "auto"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

const isRuleMode = (value: unknown): value is RuleMode => value === "off" || value === "ask" || value === "auto";

// The largest limit a rule may hold: the columns' bound (below 1e9 cents).
export const MAX_RULE_CENTS = 999_999_999;
export const MAX_RULE_COUNT = 10_000;

export type RuleSave = {
  kind: RuleKind;
  mode: RuleMode;
  maxCents: number;
  dayMaxCents: number;
  dayMaxCount: number;
  driverDayMaxCents: number | null;
  // The version the person saw, or null when the kind had no rule yet.
  expectedVersion: number | null;
};

export type RuleField = keyof RuleSave | "body";

export type ParseResult =
  | { ok: true; value: RuleSave }
  | { ok: false; category: "bad_request"; field: RuleField }
  | { ok: false; category: "never_alone" }
  | { ok: false; category: "over_ceiling"; ceiling: AutopilotCeiling };

const KEYS: ReadonlySet<string> = new Set([
  "kind",
  "mode",
  "maxCents",
  "dayMaxCents",
  "dayMaxCount",
  "driverDayMaxCents",
  "expectedVersion",
]);

const isCents = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_RULE_CENTS;

const bad = (field: RuleField): ParseResult => ({ ok: false, category: "bad_request", field });

// The kind's ceiling in flags.autopilot.kinds, or null when the kind is not listed there.
export function ceilingOf(kind: string): AutopilotCeiling | null {
  const kinds = flags.autopilot.kinds;
  if (!Object.prototype.hasOwnProperty.call(kinds, kind)) return null;
  return kinds[kind as keyof typeof kinds] ?? null;
}

// One rule save from a request body, whole or refused. Every number is whole cents (or a whole
// count); the order of the checks is the order of the fields, so the first bad one is named.
export function parseRuleSave(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body");
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!KEYS.has(key)) return bad("body");
  if (!isRuleKind(b.kind)) return bad("kind");
  if (!isRuleMode(b.mode)) return bad("mode");
  if (!isCents(b.maxCents)) return bad("maxCents");
  if (!isCents(b.dayMaxCents) || b.maxCents > b.dayMaxCents) return bad("dayMaxCents");
  const count = b.dayMaxCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_RULE_COUNT) {
    return bad("dayMaxCount");
  }
  let driverDayMaxCents: number | null = null;
  if (DRIVER_KINDS.has(b.kind)) {
    const d = b.driverDayMaxCents;
    if (!isCents(d) || d < b.maxCents || d > b.dayMaxCents) return bad("driverDayMaxCents");
    driverDayMaxCents = d;
  } else if (b.driverDayMaxCents !== undefined && b.driverDayMaxCents !== null) {
    return bad("driverDayMaxCents");
  }
  const ev = b.expectedVersion;
  if (ev !== null && (typeof ev !== "number" || !Number.isSafeInteger(ev) || ev < 1)) return bad("expectedVersion");
  // Auto only on a kind the autopilot may ever approve alone (the 0077 check holds it too).
  if (b.mode === "auto" && !autoAllowed(b.kind)) return { ok: false, category: "never_alone" };
  // A listed kind's limits stay inside its ceiling; raising a ceiling is its own change.
  const ceiling = ceilingOf(b.kind);
  if (ceiling !== null) {
    const over =
      b.maxCents > ceiling.maxCents ||
      b.dayMaxCents > ceiling.dayMaxCents ||
      count > ceiling.dayMaxCount ||
      (ceiling.driverDayMaxCents !== undefined && driverDayMaxCents !== null && driverDayMaxCents > ceiling.driverDayMaxCents);
    if (over) return { ok: false, category: "over_ceiling", ceiling: { ...ceiling } };
  }
  return {
    ok: true,
    value: {
      kind: b.kind,
      mode: b.mode,
      maxCents: b.maxCents,
      dayMaxCents: b.dayMaxCents,
      dayMaxCount: count,
      driverDayMaxCents,
      expectedVersion: ev,
    },
  };
}

export type SavedRule = {
  id: string;
  kind: RuleKind;
  mode: RuleMode;
  maxCents: number;
  dayMaxCents: number;
  dayMaxCount: number;
  driverDayMaxCents: number | null;
  version: number;
  updatedAt: string;
};

export type SaveResult =
  | { ok: true; rule: SavedRule; unchanged?: true }
  | { ok: false; category: "changed"; rule: SavedRule | null }
  | { ok: false; category: "role" | "forbidden" };

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const COLUMNS = `CAST(id AS text) AS id, kind, mode, CAST(max_cents AS text) AS max_cents,
       CAST(day_max_cents AS text) AS day_max_cents, day_max_count,
       CAST(driver_day_max_cents AS text) AS driver_day_max_cents, version, ${ts("updated_at")} AS updated_at`;

const ONE_SQL = `SELECT ${COLUMNS} FROM autopilot_rules WHERE tenant_id = current_tenant_id() AND kind = $1`;

const ALL_SQL = `SELECT ${COLUMNS} FROM autopilot_rules WHERE tenant_id = current_tenant_id() ORDER BY kind`;

const INSERT_SQL = `INSERT INTO autopilot_rules
  (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, driver_day_max_cents, version, updated_by,
   created_at, updated_at)
VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, 1, $7, CAST($8 AS timestamptz), CAST($8 AS timestamptz))
ON CONFLICT (tenant_id, kind) DO NOTHING
RETURNING ${COLUMNS}`;

const UPDATE_SQL = `UPDATE autopilot_rules
   SET mode = $2, max_cents = $3, day_max_cents = $4, day_max_count = $5, driver_day_max_cents = $6,
       version = version + 1, updated_by = $7, updated_at = CAST($8 AS timestamptz)
 WHERE tenant_id = current_tenant_id() AND kind = $1 AND version = $9
RETURNING ${COLUMNS}`;

const RECORD_SQL = `INSERT INTO autopilot_changes
  (tenant_id, subject, kind, rule_id, from_version, to_version, before, after, changed_by, created_at)
VALUES (current_tenant_id(), 'rule', $1, CAST($2 AS uuid), $3, $4, CAST($5 AS jsonb), CAST($6 AS jsonb), $7,
        CAST($8 AS timestamptz))`;

type Row = {
  id: unknown;
  kind: unknown;
  mode: unknown;
  max_cents: unknown;
  day_max_cents: unknown;
  day_max_count: unknown;
  driver_day_max_cents: unknown;
  version: unknown;
  updated_at: unknown;
};

const centsOf = (v: unknown): number => {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) throw new DbError("unknown");
  return Number(v);
};

// A stored rule, whole, or a throw: a row that does not read is unknown, never a default.
function ruleOf(r: Row): SavedRule {
  if (!isUuid(r.id) || !isRuleKind(r.kind) || !isRuleMode(r.mode)) throw new DbError("unknown");
  if (typeof r.day_max_count !== "number" || typeof r.version !== "number" || typeof r.updated_at !== "string") {
    throw new DbError("unknown");
  }
  return {
    id: r.id.toLowerCase(),
    kind: r.kind,
    mode: r.mode,
    maxCents: centsOf(r.max_cents),
    dayMaxCents: centsOf(r.day_max_cents),
    dayMaxCount: r.day_max_count,
    driverDayMaxCents: r.driver_day_max_cents === null ? null : centsOf(r.driver_day_max_cents),
    version: r.version,
    updatedAt: r.updated_at,
  };
}

async function oneRule(q: Queryable, kind: RuleKind, lock: boolean): Promise<SavedRule | null> {
  const rows = await q.query<Row>(lock ? `${ONE_SQL} FOR UPDATE` : ONE_SQL, [kind]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new DbError("unknown");
  return ruleOf(rows[0]);
}

// The values a change records: everything the person sets, never the row's id or version.
const valuesOf = (r: Pick<RuleSave, "mode" | "maxCents" | "dayMaxCents" | "dayMaxCount" | "driverDayMaxCents">) => ({
  mode: r.mode,
  maxCents: r.maxCents,
  dayMaxCents: r.dayMaxCents,
  dayMaxCount: r.dayMaxCount,
  driverDayMaxCents: r.driverDayMaxCents,
});

const sameValues = (a: SavedRule, b: RuleSave): boolean =>
  a.mode === b.mode &&
  a.maxCents === b.maxCents &&
  a.dayMaxCents === b.dayMaxCents &&
  a.dayMaxCount === b.dayMaxCount &&
  a.driverDayMaxCents === b.driverDayMaxCents;

// Save one parsed rule inside the caller's tenant transaction. The dedupe key is (tenant, kind,
// expectedVersion): the row is locked, and a write lands only on the version the person saw, so
// two saves of one version give one write and one record; the other answers changed with the rule
// as it is now. A save on the current version that changes nothing writes nothing.
export async function saveRule(q: Queryable, session: Session, rule: RuleSave, now: Date): Promise<SaveResult> {
  if (isServiceSub(session.sub) || isAutopilotSub(session.sub)) return { ok: false, category: "forbidden" };
  if ((await readRole(q, session)) !== "admin") return { ok: false, category: "role" };
  const at = now.toISOString();
  const current = await oneRule(q, rule.kind, true);
  const params = [rule.kind, rule.mode, rule.maxCents, rule.dayMaxCents, rule.dayMaxCount, rule.driverDayMaxCents, session.sub, at];
  let saved: SavedRule;
  if (current === null) {
    if (rule.expectedVersion !== null) return { ok: false, category: "changed", rule: null };
    const rows = await q.query<Row>(INSERT_SQL, params);
    // Another save made the rule first: this one saw no rule, so it is out of date.
    if (rows.length === 0) return { ok: false, category: "changed", rule: await oneRule(q, rule.kind, false) };
    if (rows.length !== 1) throw new DbError("unknown");
    saved = ruleOf(rows[0]);
  } else {
    if (rule.expectedVersion !== current.version) return { ok: false, category: "changed", rule: current };
    if (sameValues(current, rule)) return { ok: true, rule: current, unchanged: true };
    const rows = await q.query<Row>(UPDATE_SQL, [...params, rule.expectedVersion]);
    if (rows.length === 0) return { ok: false, category: "changed", rule: await oneRule(q, rule.kind, false) };
    if (rows.length !== 1) throw new DbError("unknown");
    saved = ruleOf(rows[0]);
  }
  const recorded = await q.execute(RECORD_SQL, [
    saved.kind,
    saved.id,
    current === null ? null : current.version,
    saved.version,
    current === null ? null : JSON.stringify(valuesOf(current)),
    JSON.stringify(valuesOf(saved)),
    session.sub,
    at,
  ]);
  if (recorded !== 1) throw new DbError("unknown");
  return { ok: true, rule: saved };
}

export type KindPicture = {
  kind: RuleKind;
  // The rule's mode, or ask when the kind has no rule (a person decides).
  mode: RuleMode;
  // Whether the owner may ever set Auto here (never-alone kinds may not).
  allowedAuto: boolean;
  // Whether flags.autopilot.kinds lists the kind, and whether it is armed there.
  listed: boolean;
  armed: boolean;
  ceiling: AutopilotCeiling | null;
};

export type PausePicture = {
  paused: boolean;
  pausedAt: string | null;
  pausedUntil: string | null;
  // Who paused, as a category: the demo reset's timed pause or a person. Never the login itself.
  pausedBy: "demo_reset" | "person" | null;
};

export type RulesPicture = {
  rules: SavedRule[];
  kinds: KindPicture[];
  pause: PausePicture;
  startDate: string;
};

const isoOrNull = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

// Every rule the carrier has and, per kind, what the autopilot may do there, plus the pause, read
// inside the caller's tenant transaction. Reads only.
export async function readRules(q: Queryable, nowMs: number): Promise<RulesPicture> {
  const rules = (await q.query<Row>(ALL_SQL, [])).map(ruleOf);
  const byKind = new Map(rules.map((r) => [r.kind, r]));
  const kinds = RULE_KINDS.map((kind): KindPicture => {
    const ceiling = ceilingOf(kind);
    return {
      kind,
      mode: byKind.get(kind)?.mode ?? "ask",
      allowedAuto: autoAllowed(kind),
      listed: ceiling !== null,
      armed: ceiling?.armed === true,
      ceiling: ceiling === null ? null : { ...ceiling },
    };
  });
  const p = await readPause(q);
  const pause: PausePicture =
    p === null
      ? { paused: false, pausedAt: null, pausedUntil: null, pausedBy: null }
      : {
          paused: isPaused(p, nowMs),
          pausedAt: isoOrNull(p.pausedAtMs),
          pausedUntil: isoOrNull(p.pausedUntilMs),
          pausedBy: p.pausedBy === null ? null : p.pausedBy === "demo_reset" ? "demo_reset" : "person",
        };
  return { rules, kinds, pause, startDate: flags.autopilot.startDate };
}
