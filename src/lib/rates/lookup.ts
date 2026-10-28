import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, type AiDeps, type AiErrorCategory, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { tenantLock } from "../invoices/number";
import { groundAnswer, RATE_KINDS, type RateKind } from "./candidates";
import { LOOKUP_PURPOSE, lookupsInDay, memberOf } from "./read";
import { isRateState, stateName } from "./states";

// A rate lookup (GROUNDED-RATES design 4.2): a person presses "Look up"; one Muse Spark call with
// web search; our code keeps a figure only when it matches a page the search returned
// (candidates.ts). The result is a 'suggested' or 'unconfirmed' row for a person to read; nothing
// reads it as a rate until an admin pins it. The only file in the rates code that names the model
// wrapper. The agent never calls this. Errors reach the person as a category; raw text never
// leaves this file and the log gets the category, the call id and the search count only.

// Room for two searches, their results and a one-line answer under the route's 40 seconds.
export const LOOKUP_TIMEOUT_MS = 30_000;
// Measured Oct 27, 2026: a state lookup with 600 output tokens ran out of room (reasoning counts
// against it) before answering; 1,500 leaves room and keeps the reserve under the 5-cent cap.
export const LOOKUP_MAX_OUTPUT_TOKENS = 1_500;

export function lookupPrompt(kind: RateKind, state: string | null): string {
  if (kind === "diesel_index") {
    return (
      "Find the most recent weekly U.S. average on-highway diesel price per gallon published by the " +
      "federal energy statistics agency. Use only the pages your search returns. Reply in one line: the " +
      "price in dollars with three decimals, the week date, and the full address of the page you took it from."
    );
  }
  return (
    `Find the current quarter's IFTA fuel tax rate for diesel in ${stateName(state ?? "")}, in dollars per ` +
    "gallon, from the IFTA rate table or the state's own page. Use only the pages your search returns. " +
    "Reply in one line: the rate in dollars with four decimals, the quarter, and the full address of the " +
    "page you took it from."
  );
}

export type LookupRefusal = "off" | "forbidden" | "bad_request" | "limit";
// budget: the spend cap, a switch or the call's own cap turned it down. no_source: the search ran
// but no page it returned carried a usable figure or source. failed: anything else, including a
// timeout or an answer cut short; its outcome is not a rate.
export type LookupFailure = "budget" | "no_source" | "failed";

export type LookupOutcome =
  | { ok: true; status: "suggested" | "unconfirmed"; id: string }
  | { ok: false; refused: LookupRefusal }
  | { ok: false; failed: LookupFailure };

export type LookupComplete = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;
export type LookupDeps = { db?: TenantDb; clock?: () => Date; complete?: LookupComplete; ai?: AiDeps };

// Every wrapper category is placed, so a new one does not compile until it is.
const ON_ERROR: Readonly<Record<AiErrorCategory, "budget" | "failed">> = {
  cap: "budget",
  job_cap: "budget",
  too_expensive: "budget",
  billing: "budget",
  disabled: "budget",
  not_configured: "budget",
  auth: "failed",
  timeout: "failed",
  unavailable: "failed",
  network: "failed",
  unknown: "failed",
  rate_limited: "failed",
  bad_request: "failed",
  too_long: "failed",
};

export type LookupInput = { kind: unknown; state?: unknown };

function parseInput(input: LookupInput): { kind: RateKind; state: string | null } | null {
  if (typeof input.kind !== "string" || !(RATE_KINDS as readonly string[]).includes(input.kind)) return null;
  const kind = input.kind as RateKind;
  if (kind === "diesel_index") return input.state === undefined || input.state === null ? { kind, state: null } : null;
  return isRateState(input.state) ? { kind, state: input.state } : null;
}

export async function lookupRate(session: Session, input: LookupInput, deps: LookupDeps = {}): Promise<LookupOutcome> {
  if (!flags.groundedRatesEnabled) return { ok: false, refused: "off" };
  const parsed = parseInput(input);
  if (!parsed) return { ok: false, refused: "bad_request" };
  const { kind, state } = parsed;
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();

  // Who is asking and how many lookups this carrier started in the last day, under the carrier's
  // rate lock. The lock ends with this transaction, before the call: two lookups started at the
  // same moment can both pass, so the day can run over by the number started together (each still
  // under its own cost cap and the spend cap).
  const gate = await db.withTenant(
    session.tenantId,
    async (q): Promise<{ ok: true; memberId: string } | { ok: false; refused: LookupRefusal }> => {
      const member = await memberOf(q, session.sub);
      if (!member) return { ok: false, refused: "forbidden" };
      await tenantLock(q, "rate_pin");
      if ((await lookupsInDay(q, now)) >= flags.ratesLimits.lookupsPerTenantPerDay) return { ok: false, refused: "limit" };
      return { ok: true, memberId: member.id };
    },
  );
  if (!gate.ok) return gate;
  // The switch again, right before the outside call.
  if (!flags.groundedRatesEnabled) return { ok: false, refused: "off" };

  const traceId = randomUUID();
  const request: AiRequest = {
    purpose: LOOKUP_PURPOSE,
    maxCostCents: flags.ratesLimits.lookupMaxCostCents,
    timeoutMs: LOOKUP_TIMEOUT_MS,
    traceId,
    reasoningEffort: "low",
    maxOutputTokens: LOOKUP_MAX_OUTPUT_TOKENS,
    webSearch: { maxCalls: flags.ratesLimits.maxSearchCalls, contextSize: "low" },
    messages: [{ role: "user", content: lookupPrompt(kind, state) }],
  };
  let result: AiResult;
  try {
    result = deps.complete
      ? await deps.complete("spark", request, session)
      : await complete("spark", request, session, deps.ai ?? { db });
  } catch (err) {
    const category = err instanceof AiError ? ON_ERROR[err.category] ?? "failed" : "failed";
    console.error(`rates: lookup ${kind} failed ${err instanceof AiError ? err.category : "error"}`);
    return { ok: false, failed: category };
  }
  const searches = result.web?.searchCalls ?? 0;
  // An answer cut short, or one with no web part, is not a lookup: fail closed.
  if (result.status !== "ok" || !result.web) {
    console.error(`rates: lookup ${kind} failed ${result.status} call ${result.callId} searches ${searches}`);
    return { ok: false, failed: "failed" };
  }
  const grounded = groundAnswer(kind, result.web);
  if (grounded.status === "failed") {
    console.error(`rates: lookup ${kind} ${grounded.category} call ${result.callId} searches ${searches}`);
    return { ok: false, failed: "no_source" };
  }

  const id = randomUUID();
  try {
    await db.withTenant(session.tenantId, (q) =>
      q.execute(
        `INSERT INTO pinned_rates (id, tenant_id, kind, state, status, value_mcents, source, source_url, source_title,
           quote, as_of, lookup_call_id, trace_id, created_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, 'lookup', $6, $7, $8, CAST($9 AS date),
           CAST($10 AS uuid), CAST($11 AS uuid), CAST($12 AS uuid))`,
        [
          id,
          kind,
          state,
          grounded.status,
          grounded.status === "suggested" ? grounded.valueMcents : null,
          grounded.sourceUrl,
          grounded.sourceTitle,
          grounded.status === "suggested" ? grounded.quote : null,
          grounded.status === "suggested" ? grounded.asOf : null,
          result.callId,
          traceId,
          gate.memberId,
        ],
      ),
    );
  } catch (err) {
    console.error(`rates: lookup ${kind} not kept call ${result.callId} ${err instanceof Error ? err.name : "error"}`);
    return { ok: false, failed: "failed" };
  }
  console.log(`rates: lookup ${kind} ${grounded.status} call ${result.callId} searches ${searches}`);
  return { ok: true, status: grounded.status, id };
}
