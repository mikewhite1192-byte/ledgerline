import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, type AiFormat, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { briefPlainText } from "../briefs/render";
import { verifyBrief } from "../briefs/verify";
import { getDb, type TenantDb } from "../db";
import { formatCents } from "../format/money";
import { tenantLock } from "../invoices/number";
import { readTenantZone } from "../money/read";
import { assertMembership } from "../tenant/context";
import { isLocalDate, type LocalDate } from "../time/local-date";
import { NANOCENTS_PER_CENT } from "../trace/format";
import { needsCount, readDigestFacts, type DigestFact } from "./facts";
import { DIGEST_TEXT_MAX, digestWords } from "./words";

// The morning digest: one line per carrier per local day, written at the desk's 06:00 period
// (src/lib/desk/handlers.ts, source digest). The facts come from SQL (facts.ts); Muse Spark words
// them in one call through complete() in src/lib/ai, which checks aiEnabled, reserves the worst case
// in the spend ledger and enforces the caps; the brief check (src/lib/briefs/verify.ts) refuses any
// number that is not a fact's own value. Any failure lands the line code writes from the same facts
// (words.ts), so the model never decides a number or what needs a person. The line is an
// agent_asks row of kind digest (0082) that shows in the ask card until a person presses Got it.
// Sends nothing and moves no money.

export const DIGEST_PURPOSE = "morning_digest";
export const DIGEST_TIMEOUT_MS = 20_000;
// What the rules ask of the model, under the table's 400 so the tags' removal never matters.
export const DIGEST_ASK_CHARS = 380;

export const DIGEST_FORMAT: AiFormat = {
  name: "morning_digest",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  },
};

export const DIGEST_RULES = [
  "You write the morning digest the owner of a trucking company reads at 6 in the morning, from the",
  "numbered facts below. The facts were read from the company's own records.",
  "Rules:",
  `- Three to five plain sentences, at most ${DIGEST_ASK_CHARS} characters in all.`,
  "- Say first what needs a person, then what happened yesterday, then the billing lines.",
  "- Use only the facts in the list. Never add, subtract, round or estimate. If a number is not in",
  "  the list, do not write it.",
  "- Copy every number exactly as the list writes it, and put its tag right after the number, before",
  '  any word, like this: "2 [f2] card breaks wait for you" or "$450.00 [f11] in advances". Every number',
  "  needs its own tag.",
  '- A fact that reads "not read" is said as "not read", never as a number.',
  "- Write every number in digits. No numbers as words, no dates, no years.",
  "- No advice, no promises, no links, no questions.",
  'Reply with JSON only: {"text": the digest}.',
].join("\n");

export type CompleteFn = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

// The numbered list the model words: one fact a line, "[f3] Trips cancelled yesterday: 1".
export function factsText(facts: readonly DigestFact[]): string {
  const valueText = (f: DigestFact) => {
    if (typeof f.value === "string") return f.value;
    return f.kind === "cents" ? formatCents(f.value) : String(f.value);
  };
  return facts.map((f) => `[${f.key}] ${f.label}: ${valueText(f)}`).join("\n");
}

export function digestRequest(facts: readonly DigestFact[], traceId: string): AiRequest {
  return {
    purpose: DIGEST_PURPOSE,
    reasoningEffort: "low",
    maxOutputTokens: flags.morningDigest.maxOutputTokens,
    maxCostCents: flags.morningDigest.maxCostCents,
    timeoutMs: DIGEST_TIMEOUT_MS,
    traceId,
    format: DIGEST_FORMAT,
    messages: [
      { role: "system", content: DIGEST_RULES },
      { role: "user", content: factsText(facts) },
    ],
  };
}

// The line to store and how it came to be: drafted (the model's words, checked, tags removed),
// model_<category> (the call failed or ran out of room), check_<category> (a number or the shape
// was refused). cents: the call's cost in whole cents, when the call answered.
export type Draft = { text: string; category: string; cents?: number };

export async function draftDigest(
  facts: readonly DigestFact[],
  call: CompleteFn,
  session: Session,
  traceId: string,
): Promise<Draft> {
  const fallback = (category: string, cents?: number): Draft => ({
    text: digestWords(facts),
    category,
    ...(cents === undefined ? {} : { cents }),
  });
  let result: AiResult;
  try {
    result = await call("spark", digestRequest(facts, traceId), session);
  } catch (err) {
    // The category only; an error's text is never kept.
    return fallback(err instanceof AiError ? `model_${err.category}` : "model_unknown");
  }
  const cents =
    Number.isSafeInteger(result.costNanocents) && result.costNanocents >= 0
      ? Math.ceil(result.costNanocents / NANOCENTS_PER_CENT)
      : undefined;
  if (result.status !== "ok") return fallback("model_incomplete", cents);
  const checked = verifyBrief(result.text, facts);
  if (!checked.ok) return fallback(`check_${checked.category}`, cents);
  const plain = briefPlainText(checked.text).trim();
  if (plain.length === 0 || plain.length > DIGEST_TEXT_MAX) return fallback("check_too_long", cents);
  return { text: plain, category: "drafted", ...(cents === undefined ? {} : { cents }) };
}

export type DigestDeps = {
  db?: TenantDb;
  complete?: CompleteFn;
  clock?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
};

export type DigestOutcome =
  | { kind: "skipped"; category: "switched_off" | "before_start" }
  | { kind: "failed"; category: "bad_request" }
  | { kind: "done"; found?: number; cents?: number; category: string };

const EXISTS_SQL = `SELECT CAST(count(*) AS integer) AS n FROM agent_asks
  WHERE tenant_id = current_tenant_id() AND kind = 'digest' AND period_date = CAST($1 AS date)`;

// One digest for the carrier's local date `periodDate`. A digest already stored for it (an earlier
// try that stored its line and never wrote its done line, or a racing try) is covered: no second
// model call. Facts are read first, then the model call outside any transaction, then one
// transaction under the carrier's digest lock closes the earlier open digests and stores this one.
export async function writeDigest(session: Session, periodDate: string, deps: DigestDeps = {}): Promise<DigestOutcome> {
  // The switch and the start date are asked here, whoever calls; complete() asks aiEnabled again.
  if (flags.morningDigest.enabled !== true) return { kind: "skipped", category: "switched_off" };
  if (!isLocalDate(periodDate)) return { kind: "failed", category: "bad_request" };
  if (!isLocalDate(flags.morningDigest.startDate) || periodDate < flags.morningDigest.startDate) {
    return { kind: "skipped", category: "before_start" };
  }
  const date: LocalDate = periodDate;
  const db = deps.db ?? getDb();
  const call = deps.complete ?? ((target, r, s) => complete(target, r, s));
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  const first = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const [row] = await q.query<{ n: number }>(EXISTS_SQL, [date]);
    if (!row || !Number.isSafeInteger(row.n)) throw new RangeError("digest not read");
    return { exists: row.n > 0, zone: await readTenantZone(q) };
  });
  if (first.exists) return { kind: "done", category: "covered" };

  const facts = await readDigestFacts(db, session, date, first.zone, { log: deps.log });
  const found = needsCount(facts);
  // The switch can go off while the facts are read: asked again right before the call.
  if (flags.morningDigest.enabled !== true) return { kind: "skipped", category: "switched_off" };
  const draft = await draftDigest(facts, call, session, newId());

  const stored = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    await tenantLock(q, "morning_digest");
    const now = clock().toISOString();
    // Yesterday's line, if no one closed it, is done once today's lands.
    await q.execute(
      `UPDATE agent_asks SET status = 'done', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND kind = 'digest' AND status = 'open'
          AND period_date < CAST($1 AS date)`,
      [date, now],
    );
    return q.execute(
      `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text, period_date,
         created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'digest', NULL, 'tenants', current_tenant_id(), $2,
         CAST($3 AS date), CAST($4 AS timestamptz), CAST($4 AS timestamptz))
       ON CONFLICT (tenant_id, period_date) WHERE kind = 'digest' DO NOTHING`,
      [newId(), draft.text, date, now],
    );
  });
  const cents = draft.cents;
  if (stored !== 1) return { kind: "done", found, ...(cents === undefined ? {} : { cents }), category: "covered" };
  return { kind: "done", found, ...(cents === undefined ? {} : { cents }), category: draft.category };
}
