import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, type AiErrorCategory, type AiFormat, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { readReportInput, readTenant } from "../data/read";
import { periodOf } from "../data/records";
import { getDb, type Queryable, type TenantDb } from "../db";
import { tenantLock } from "../invoices/number";
import type { BriefFigure } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { isLocalDate, localDateOf } from "../time/local-date";
import { closedWeeks, figuresText, profitWeek, readProfitInput } from "./figures";
import { MAX_BRIEF_CHARS, verifyBrief, type BriefVerification } from "./verify";
import { BRIEF_LEASE_MS } from "./view";

// Writes one profit brief when a person presses the button. The only file in src/lib/briefs that
// reaches a model, and only through complete() in src/lib/ai, which checks aiEnabled, reserves the
// worst case in the spend ledger and enforces the caps. Nothing here runs on a schedule.
//
// The brief is reserved first: its row (drafting, with the engine's figures) is written before the
// model call, under the lock and briefs_one_live, so a second click, a second tab or a retry never
// writes the same week twice. The model only words the figures; verify.ts reads every number back
// against them before the row moves to drafted. One that fails becomes refused with its category
// and no text. A row left drafting by a crash is marked refused (interrupted) once its lease runs
// out. A call complete() turned down before any request went out (models off, over a cap) becomes
// over_cap. A refused or over_cap brief can be written again: the new row supersedes it. A drafted
// brief is final.

export const BRIEF_PURPOSE = "profit_brief";
export const BRIEF_TIMEOUT_MS = 20_000;

export const BRIEF_FORMAT: AiFormat = {
  name: "profit_brief",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  },
};

export const BRIEF_RULES = [
  "You write a short brief for the owner of a trucking company about one closed pay week, from the",
  "numbered figures below. The figures were computed from the company's own records.",
  "Rules:",
  "- Five to eight plain sentences. Say how the week went: revenue, driver pay and margin, which",
  "  routes and customers earned the most and the least, and which customers take longest to pay.",
  "- Use only the figures in the list. Never add, subtract, average, round or estimate. If a number",
  "  is not in the list, do not write it.",
  "- Copy every number exactly as the list writes it, and put its tag right after it, like this:",
  '  "Revenue was $48,210.00 [f1]." Every number in the brief needs its own tag.',
  "- Write every number in digits. No numbers as words, no dates, no years.",
  "- Name routes and customers exactly as the list does.",
  "- A margin below zero is a loss: say so.",
  "- No advice, no promises, no links, no questions.",
  'Reply with JSON only: {"text": the brief}.',
].join("\n");

export type CompleteFn = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type WriteDeps = {
  db?: TenantDb;
  complete?: CompleteFn;
  clock?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
};

export type WriteRefusal =
  | "disabled"
  | "ai_disabled"
  | "not_found"
  | "open_period"
  | "exists"
  | "in_progress"
  | "no_loads";

export type WriteBriefResult =
  | { ok: false; category: WriteRefusal; briefId?: string }
  | { ok: true; briefId: string; status: "drafted" | "refused" | "over_cap"; category: string | null };

// complete() throws these before any provider request. Every other category follows a request
// that was sent.
const BEFORE_ANY_REQUEST: ReadonlySet<AiErrorCategory> = new Set<AiErrorCategory>([
  "disabled",
  "not_configured",
  "too_expensive",
  "cap",
  "job_cap",
]);

export function briefRequest(figures: readonly BriefFigure[], traceId: string): AiRequest {
  return {
    purpose: BRIEF_PURPOSE,
    reasoningEffort: "low",
    maxOutputTokens: flags.profitBriefLimits.maxOutputTokens,
    maxCostCents: flags.profitBriefLimits.maxBriefCents,
    timeoutMs: BRIEF_TIMEOUT_MS,
    traceId,
    format: BRIEF_FORMAT,
    messages: [
      { role: "system", content: BRIEF_RULES },
      {
        role: "user",
        content: [`The brief must be at most ${MAX_BRIEF_CHARS} characters.`, "", figuresText(figures)].join("\n"),
      },
    ],
  };
}

type Reserved = { briefId: string; traceId: string; figures: BriefFigure[] };

// One transaction under the carrier's brief lock: clear a stale reservation, check the week,
// supersede a failed brief, reserve the new one with its figures.
async function reserve(
  q: Queryable,
  session: Session,
  periodStart: string,
  now: Date,
  newId: () => string,
): Promise<Reserved | WriteRefusal> {
  await tenantLock(q, "brief_write");
  const iso = now.toISOString();
  // A brief left drafting past its lease was cut off mid-call: it is never shown as checked.
  await q.execute(
    `UPDATE briefs SET status = 'refused', refusal_category = 'interrupted', updated_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND status = 'drafting' AND updated_at < CAST($2 AS timestamptz)`,
    [iso, new Date(now.getTime() - BRIEF_LEASE_MS).toISOString()],
  );

  const tenant = await readTenant(q);
  if (!tenant) return "not_found";
  const today = localDateOf(iso, tenant.timezone);
  const week = (await closedWeeks(q, today)).find((w) => w.start === periodStart);
  if (!week) {
    const { settlement_periods } = await readReportInput(q, ["settlement_periods"]);
    const period = settlement_periods.map(periodOf).find((p) => p.periodStart === periodStart);
    return period && (period.status === "open" || period.periodEnd >= today) ? "open_period" : "not_found";
  }

  const live = await q.query<{ id: string; status: string }>(
    `SELECT CAST(id AS text) AS id, status FROM briefs
      WHERE tenant_id = current_tenant_id() AND kind = 'profit_week' AND period_start = CAST($1 AS date)
        AND status IN ('drafting', 'drafted')`,
    [periodStart],
  );
  if (live.some((r) => r.status === "drafted")) return "exists";
  if (live.length > 0) return "in_progress";

  const period = { start: week.start, end: week.end };
  const profit = profitWeek(await readProfitInput(q, period), period, flags.profitBriefLimits);
  // Nothing priced, nothing to word: no model call for an empty week.
  if (profit.totals.loads === 0) return "no_loads";
  const figures = profit.figures;

  await q.execute(
    `UPDATE briefs SET status = 'superseded', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND kind = 'profit_week' AND period_start = CAST($1 AS date)
        AND status IN ('refused', 'over_cap')`,
    [periodStart, iso],
  );
  const briefId = newId();
  const traceId = newId();
  const n = await q.execute(
    `INSERT INTO briefs (id, tenant_id, kind, period_start, period_end, as_of, status, figures, model, trace_id,
       created_by, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'profit_week', CAST($2 AS date), CAST($3 AS date),
       CAST($4 AS date), 'drafting', CAST($5 AS jsonb), 'spark', CAST($6 AS uuid), $7,
       CAST($8 AS timestamptz), CAST($8 AS timestamptz))
     ON CONFLICT (tenant_id, kind, period_start) WHERE status IN ('drafting', 'drafted') DO NOTHING`,
    [briefId, week.start, week.end, today, JSON.stringify(figures), traceId, session.sub, iso],
  );
  if (n !== 1) return "in_progress";
  return { briefId, traceId, figures };
}

type Finish =
  | { status: "drafted"; text: string; verification: BriefVerification; modelCallId: string }
  | {
      status: "refused" | "over_cap";
      category: string;
      verification: BriefVerification | null;
      modelCallId: string | null;
    };

// Moves a reserved brief out of drafting, once. False when it had already left drafting.
async function finish(db: TenantDb, session: Session, briefId: string, f: Finish, now: string): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE briefs
          SET status = $2, body = CAST($3 AS jsonb), verification = CAST($4 AS jsonb), refusal_category = $5,
              model_call_id = CAST($6 AS uuid), updated_at = CAST($7 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafting'`,
      [
        briefId,
        f.status,
        f.status === "drafted" ? JSON.stringify({ text: f.text }) : null,
        f.verification === null ? null : JSON.stringify(f.verification),
        f.status === "drafted" ? null : f.category,
        f.modelCallId,
        now,
      ],
    );
    return n === 1;
  });
}

export async function writeBrief(
  session: Session,
  request: { kind: "profit_week"; periodStart: string },
  deps: WriteDeps = {},
): Promise<WriteBriefResult> {
  // Each switch is re-checked here, whoever calls; complete() checks aiEnabled again.
  if (!flags.profitBriefEnabled) return { ok: false, category: "disabled" };
  if (!flags.aiEnabled) return { ok: false, category: "ai_disabled" };
  if (request.kind !== "profit_week" || !isLocalDate(request.periodStart)) return { ok: false, category: "not_found" };
  const db = deps.db ?? getDb();
  const call = deps.complete ?? ((target, r, s) => complete(target, r, s));
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((line: string) => console.info(line));

  const reserved = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return reserve(q, session, request.periodStart, clock(), newId);
  });
  if (typeof reserved === "string") return { ok: false, category: reserved };

  const done = async (f: Finish): Promise<WriteBriefResult> => {
    await finish(db, session, reserved.briefId, f, clock().toISOString());
    const category = f.status === "drafted" ? null : f.category;
    log(`briefs: profit_week ${f.status}${category ? ` (${category})` : ""} ${reserved.briefId}`);
    return { ok: true, briefId: reserved.briefId, status: f.status, category };
  };

  // The switch can go off while the figures are read: checked again right before the call.
  if (!flags.profitBriefEnabled) {
    return done({ status: "over_cap", category: "disabled", verification: null, modelCallId: null });
  }

  let result: AiResult;
  try {
    result = await call("spark", briefRequest(reserved.figures, reserved.traceId), session);
  } catch (err) {
    if (err instanceof AiError) {
      // The category only; the row keeps no text. A timeout is never read as written.
      return done({
        status: BEFORE_ANY_REQUEST.has(err.category) ? "over_cap" : "refused",
        category: err.category,
        verification: null,
        modelCallId: null,
      });
    }
    await done({ status: "refused", category: "error", verification: null, modelCallId: null });
    throw err;
  }
  if (result.status !== "ok") {
    // Cut off by the output budget: nothing was checked.
    return done({ status: "refused", category: "incomplete", verification: null, modelCallId: result.callId });
  }
  const checked = verifyBrief(result.text, reserved.figures);
  return done(
    checked.ok
      ? { status: "drafted", text: checked.text, verification: checked.verification, modelCallId: result.callId }
      : { status: "refused", category: checked.category, verification: checked.verification, modelCallId: result.callId },
  );
}
