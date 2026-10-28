import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, type AiErrorCategory, type AiFormat, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { readTenant } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { tenantLock } from "../invoices/number";
import type { BriefFigure } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { localDateOf, quarterContaining } from "../time/local-date";
import { figuresText } from "./figures";
import { packFigures, readQuarter } from "./quarter-figures";
import { hasActivity, QUARTER_SECTIONS, SECTION_ITEMS, verifyQuarter, type QuarterBody } from "./quarter-review";
import type { BriefVerification } from "./verify";
import { BRIEF_LEASE_MS } from "./view";

// Writes one quarter review when a person presses the button. Beside write.ts, the only file in
// src/lib/briefs that reaches a model, and only through complete() in src/lib/ai, which checks
// aiEnabled, reserves the worst case in the spend ledger and enforces the per-call, per-run and
// daily caps, the Wonder cap among them. Nothing here runs on a schedule.
//
// The same steps as the profit brief: the review is reserved first (drafting, with the engine's
// figures) under the carrier's brief lock and briefs_one_live, so a second click, a second tab or
// a retry never writes the same quarter twice. The long-context model only words the figures;
// quarter-review.ts reads every number in every item back against them before the row moves to
// drafted, and one item that fails refuses the whole review, which keeps no words. A call turned
// down before any request went out becomes over_cap; a timeout, a server error or a reply cut off
// becomes refused with its category, never a stored review. A refused or over_cap review can be
// written again (the new row supersedes it). A drafted review is final for its quarter.

export const QUARTER_PURPOSE = "quarter_review";
export const QUARTER_TIMEOUT_MS = 25_000;
// Each item is short, so the four lists fit the output budget with room for the model's reasoning.
export const QUARTER_ITEM_CHARS = 240;

export const QUARTER_RULES = [
  "You write a review for the owner of a trucking company, from the numbered figures below. The",
  "figures cover the current period to date and were computed from the company's own records: pay",
  "runs, invoices, customer payments, the fixes the agent suggested and the detention it found.",
  "Write four lists:",
  "- went_well: things that went well, at least one and at most five.",
  "- problems: problems that keep coming back, at least one and at most five.",
  "- recovered: money recovered (detention billed, pay corrections, advances paid back), at least one",
  "  and at most four. If the figures show none recovered, say so with the figure.",
  "- change: exactly three things the office should change, each tied to a figure.",
  "Rules:",
  `- Each item is one or two plain sentences, at most ${QUARTER_ITEM_CHARS} characters, and uses at least one`,
  "  figure with its tag.",
  "- Use only the figures in the list. Never add, subtract, average, round or estimate. If a number",
  "  is not in the list, do not write it.",
  "- Copy every number exactly as the list writes it, and put its tag right after it, like this:",
  '  "Net pay was $48,210.00 [f9]." Every number needs its own tag.',
  "- Write every number in digits. No numbers as words, no dates, no years. Say \"so far\" rather than",
  "  naming the period. Never use these words: quarter, half, first, second, third, once, twice,",
  "  single, double, pair, couple, dozen, percent. A percent is written with the % sign, as the list does.",
  "- Name customers and drivers exactly as the list does.",
  "- A margin below zero is a loss: say so.",
  "- No promises, no links, no questions.",
  'Reply with JSON only: {"went_well": [...], "problems": [...], "recovered": [...], "change": [...]}.',
].join("\n");

// The four lists, each of strings, with the item counts the check holds the reply to.
export const QUARTER_FORMAT: AiFormat = {
  name: "quarter_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [...QUARTER_SECTIONS],
    properties: Object.fromEntries(
      QUARTER_SECTIONS.map((s) => [
        s,
        { type: "array", minItems: SECTION_ITEMS[s].min, maxItems: SECTION_ITEMS[s].max, items: { type: "string" } },
      ]),
    ),
  },
};

// complete() throws these before any provider request. Every other category follows a request
// that was sent.
const BEFORE_ANY_REQUEST: ReadonlySet<AiErrorCategory> = new Set<AiErrorCategory>([
  "disabled",
  "not_configured",
  "too_expensive",
  "cap",
  "job_cap",
]);

export type QuarterCompleteFn = (target: "wonder", request: AiRequest, session: Session) => Promise<AiResult>;

export type WriteQuarterDeps = {
  db?: TenantDb;
  complete?: QuarterCompleteFn;
  clock?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
};

export type QuarterRefusal = "disabled" | "ai_disabled" | "not_found" | "exists" | "in_progress" | "no_activity";

export type WriteQuarterResult =
  | { ok: false; category: QuarterRefusal; briefId?: string }
  | { ok: true; briefId: string; status: "drafted" | "refused" | "over_cap"; category: string | null };

export function quarterRequest(figures: readonly BriefFigure[], traceId: string): AiRequest {
  return {
    purpose: QUARTER_PURPOSE,
    reasoningEffort: "medium",
    maxOutputTokens: flags.quarterReviewLimits.maxOutputTokens,
    maxCostCents: flags.quarterReviewLimits.maxReviewCents,
    timeoutMs: QUARTER_TIMEOUT_MS,
    traceId,
    format: QUARTER_FORMAT,
    messages: [
      { role: "system", content: QUARTER_RULES },
      {
        role: "user",
        content: [
          `Each item must be at most ${QUARTER_ITEM_CHARS} characters.`,
          "",
          figuresText(figures),
        ].join("\n"),
      },
    ],
  };
}

type Reserved = { briefId: string; traceId: string; figures: BriefFigure[] };

// One transaction under the carrier's brief lock: clear a stale reservation, read the quarter so
// far, supersede a failed review, reserve the new one with the figures the model is given.
async function reserve(
  q: Queryable,
  session: Session,
  now: Date,
  newId: () => string,
): Promise<Reserved | QuarterRefusal> {
  await tenantLock(q, "brief_write");
  const iso = now.toISOString();
  // A review left drafting past its lease was cut off mid-call: it is never shown as checked.
  await q.execute(
    `UPDATE briefs SET status = 'refused', refusal_category = 'interrupted', updated_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND status = 'drafting' AND updated_at < CAST($2 AS timestamptz)`,
    [iso, new Date(now.getTime() - BRIEF_LEASE_MS).toISOString()],
  );

  const tenant = await readTenant(q);
  if (!tenant) return "not_found";
  const today = localDateOf(iso, tenant.timezone);
  const period = quarterContaining(today);

  const live = await q.query<{ id: string; status: string }>(
    `SELECT CAST(id AS text) AS id, status FROM briefs
      WHERE tenant_id = current_tenant_id() AND kind = 'quarter' AND period_start = CAST($1 AS date)
        AND status IN ('drafting', 'drafted')`,
    [period.start],
  );
  if (live.some((r) => r.status === "drafted")) return "exists";
  if (live.length > 0) return "in_progress";

  const quarter = await readQuarter(q, period, today, tenant.timezone);
  // Nothing happened yet, or nothing fits the prompt: no model call.
  const figures = packFigures(quarter.figures, flags.quarterReviewLimits.maxInputChars);
  if (!hasActivity(quarter) || figures.length === 0) return "no_activity";

  await q.execute(
    `UPDATE briefs SET status = 'superseded', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND kind = 'quarter' AND period_start = CAST($1 AS date)
        AND status IN ('refused', 'over_cap')`,
    [period.start, iso],
  );
  const briefId = newId();
  const traceId = newId();
  const n = await q.execute(
    `INSERT INTO briefs (id, tenant_id, kind, period_start, period_end, as_of, status, figures, model, trace_id,
       created_by, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'quarter', CAST($2 AS date), CAST($3 AS date),
       CAST($4 AS date), 'drafting', CAST($5 AS jsonb), 'wonder', CAST($6 AS uuid), $7,
       CAST($8 AS timestamptz), CAST($8 AS timestamptz))
     ON CONFLICT (tenant_id, kind, period_start) WHERE status IN ('drafting', 'drafted') DO NOTHING`,
    [briefId, period.start, period.end, today, JSON.stringify(figures), traceId, session.sub, iso],
  );
  if (n !== 1) return "in_progress";
  return { briefId, traceId, figures };
}

type Finish =
  | { status: "drafted"; body: QuarterBody; verification: BriefVerification; modelCallId: string }
  | {
      status: "refused" | "over_cap";
      category: string;
      verification: BriefVerification | null;
      modelCallId: string | null;
    };

// Moves a reserved review out of drafting, once. False when it had already left drafting.
async function finish(db: TenantDb, session: Session, briefId: string, f: Finish, now: string): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE briefs
          SET status = $2, body = CAST($3 AS jsonb), verification = CAST($4 AS jsonb), refusal_category = $5,
              model_call_id = CAST($6 AS uuid), updated_at = CAST($7 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'quarter'
          AND status = 'drafting'`,
      [
        briefId,
        f.status,
        f.status === "drafted" ? JSON.stringify(f.body) : null,
        f.verification === null ? null : JSON.stringify(f.verification),
        f.status === "drafted" ? null : f.category,
        f.modelCallId,
        now,
      ],
    );
    return n === 1;
  });
}

export async function writeQuarterReview(session: Session, deps: WriteQuarterDeps = {}): Promise<WriteQuarterResult> {
  // Each switch is re-checked here, whoever calls; complete() checks aiEnabled again.
  if (!flags.quarterReviewEnabled) return { ok: false, category: "disabled" };
  if (!flags.aiEnabled) return { ok: false, category: "ai_disabled" };
  const db = deps.db ?? getDb();
  const call = deps.complete ?? ((target, r, s) => complete(target, r, s));
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((line: string) => console.info(line));

  const reserved = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return reserve(q, session, clock(), newId);
  });
  if (typeof reserved === "string") return { ok: false, category: reserved };

  const done = async (f: Finish): Promise<WriteQuarterResult> => {
    // A row that already left drafting was marked interrupted by a later press once its lease ran
    // out: these words were never stored, so the answer is never drafted. The page reads the row.
    const moved = await finish(db, session, reserved.briefId, f, clock().toISOString());
    const out: Finish = moved
      ? f
      : { status: "refused", category: "interrupted", verification: null, modelCallId: null };
    const category = out.status === "drafted" ? null : out.category;
    log(`briefs: quarter ${out.status}${category ? ` (${category})` : ""} ${reserved.briefId}`);
    return { ok: true, briefId: reserved.briefId, status: out.status, category };
  };

  // The switch can go off while the figures are read: checked again right before the call.
  if (!flags.quarterReviewEnabled) {
    return done({ status: "over_cap", category: "disabled", verification: null, modelCallId: null });
  }

  let result: AiResult;
  try {
    result = await call("wonder", quarterRequest(reserved.figures, reserved.traceId), session);
  } catch (err) {
    if (err instanceof AiError) {
      // The category only; the row keeps no text. A timeout or a server error is never read as
      // written.
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
  const checked = verifyQuarter(result.text, reserved.figures);
  return done(
    checked.ok
      ? { status: "drafted", body: checked.body, verification: checked.verification, modelCallId: result.callId }
      : { status: "refused", category: checked.category, verification: checked.verification, modelCallId: result.callId },
  );
}
