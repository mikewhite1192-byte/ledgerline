import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { loadsOf } from "../../data/records";
import { readAdvanceInput, readRowsWhereId, readSettlementInput } from "../../data/read";
import {
  advanceEligibility,
  cents,
  invoiceAmount,
  type AdvanceDecision,
} from "../../rules-engine";
import { loadCandidates } from "../../documents/candidates";
import { matchDocument, RATE_FILL_STATUSES } from "../../documents/match";
import { isWithin } from "../../time/local-date";
import { readDocumentForInput } from "./store/document-reads";
import type { GatewayContext, GatewayRef, LimitResult } from "./types";

// Amount limits for the propose tools. The rules engine sizes every number; the gateway only
// compares. A proposal above its limit never exists. Any read or engine error is
// limit_unavailable: unknown is not zero.

const OVER_LIMIT_REASONS = new Set(["over_driver_limit", "exceeds_earned_share"]);

function unavailable(requestedCents: number | null): LimitResult {
  console.warn("gateway: a limit could not be computed");
  return {
    ok: false,
    reason: "limit_unavailable",
    limitCents: null,
    requestedCents: requestedCents === null ? null : cents(requestedCents),
  };
}

function refused(
  reason: "amount_over_limit" | "engine_refused",
  limitCents: number | null,
  requestedCents: number,
): LimitResult {
  return {
    ok: false,
    reason,
    limitCents: limitCents === null ? null : cents(Math.max(0, limitCents)),
    requestedCents: cents(requestedCents),
  };
}

// ---- Advances ----

export type AdvanceLimitArgs = { driverId: string; amountCents: number; requestedOn: string };

// The largest amount this trace already asked for this driver and was refused as over the limit.
// A later, smaller ask in the same trace is then capped to what the engine allows.
const ASKED_SQL =
  "SELECT max(requested_cents) AS asked FROM gateway_decisions" +
  " WHERE tenant_id = current_tenant_id() AND trace_id = $1 AND tool = 'propose_advance'" +
  " AND decision = 'blocked' AND reason = 'amount_over_limit'" +
  " AND args_redacted ->> 'driverId' = $2";

export async function advanceLimit(
  q: Queryable,
  ctx: GatewayContext,
  args: AdvanceLimitArgs,
): Promise<LimitResult> {
  let decision: AdvanceDecision;
  let requestedOn: string;
  try {
    const input = await readAdvanceInput(q, args.driverId, ctx.now.toISOString(), args.amountCents);
    requestedOn = input.requestedOn;
    decision = advanceEligibility(input);
  } catch {
    return unavailable(args.amountCents);
  }
  // The ask can be dated today or earlier (an email from two days ago), never later; the engine
  // always sizes the advance as of now, when it would be paid.
  if (args.requestedOn > requestedOn) return refused("engine_refused", decision.maxCents, args.amountCents);
  if (!decision.eligible) {
    const overOnly =
      decision.reasons.length > 0 &&
      decision.reasons.every((r) => OVER_LIMIT_REASONS.has(r)) &&
      decision.maxCents > 0;
    return refused(overOnly ? "amount_over_limit" : "engine_refused", decision.maxCents, args.amountCents);
  }
  let asked: number | null;
  try {
    const rows = await q.query<{ asked: number | null }>(ASKED_SQL, [ctx.traceId, args.driverId]);
    asked = rows[0]?.asked ?? null;
  } catch {
    return unavailable(args.amountCents);
  }
  const capped = asked !== null && asked > args.amountCents;
  return {
    ok: true,
    limitCents: decision.maxCents,
    requestedCents: cents(args.amountCents),
    exceptions: capped ? ["capped_to_eligible"] : [],
    reasons: [...decision.reasons],
    sources: decision.sources,
  };
}

// ---- Pay corrections ----

export type PayCorrectionLimitArgs = {
  driverId: string;
  periodId: string;
  payItemId?: string;
  deltaCents: number;
};

export async function payCorrectionLimit(
  q: Queryable,
  _ctx: GatewayContext,
  args: PayCorrectionLimitArgs,
): Promise<LimitResult> {
  const max = flags.gatewayLimits.payCorrectionMaxCents;
  if (!Number.isSafeInteger(max) || max <= 0) return unavailable(args.deltaCents);
  if (Math.abs(args.deltaCents) > max) return refused("amount_over_limit", max, args.deltaCents);
  try {
    const [period] = await readRowsWhereId(q, "settlement_periods", "id", args.periodId);
    if (!period) return unavailable(args.deltaCents);
    if (period.status !== "open") return refused("engine_refused", max, args.deltaCents);
    const settlements = await readRowsWhereId(q, "settlements", "period_id", args.periodId);
    if (settlements.some((s) => s.driver_id === args.driverId && s.status !== "draft")) {
      return refused("engine_refused", max, args.deltaCents);
    }
    const sources: GatewayRef[] = [
      { table: "settlement_periods", id: period.id },
      { table: "drivers", id: args.driverId },
    ];
    if (args.payItemId) {
      const [item] = await readRowsWhereId(q, "pay_items", "id", args.payItemId);
      if (!item) return unavailable(args.deltaCents);
      const inPeriod = isWithin(item.item_date, { start: period.period_start, end: period.period_end });
      if (item.driver_id !== args.driverId || item.settlement_id !== null || !inPeriod) {
        return refused("engine_refused", max, args.deltaCents);
      }
      sources.push({ table: "pay_items", id: item.id });
    }
    // The engine must be able to settle this driver for this period from the rows as they are.
    await readSettlementInput(q, args.driverId, args.periodId);
    return {
      ok: true,
      limitCents: cents(max),
      requestedCents: cents(args.deltaCents),
      exceptions: [],
      reasons: [],
      sources,
    };
  } catch {
    return unavailable(args.deltaCents);
  }
}

// ---- Invoice fixes ----

export type InvoiceFixLimitArgs = { invoiceId: string; newAmountCents: number };

export async function invoiceFixLimit(
  q: Queryable,
  _ctx: GatewayContext,
  args: InvoiceFixLimitArgs,
): Promise<LimitResult> {
  const max = flags.gatewayLimits.invoiceFixMaxCents;
  if (!Number.isSafeInteger(max) || max <= 0) return unavailable(null);
  try {
    const [invoice] = await readRowsWhereId(q, "invoices", "id", args.invoiceId);
    if (!invoice) return unavailable(null);
    const delta = args.newAmountCents - invoice.amount_cents;
    if (Math.abs(delta) > max) return refused("amount_over_limit", max, delta);
    if (delta === 0) return refused("engine_refused", max, delta);
    const fixable = invoice.status === "open" || invoice.status === "partially_paid";
    if (invoice.source !== "load" || invoice.load_id === null || !fixable) {
      return refused("engine_refused", max, delta);
    }
    const loadId = invoice.load_id;
    const loads = await readRowsWhereId(q, "loads", "id", loadId);
    if (loads.length !== 1) return unavailable(delta);
    const miles = await readRowsWhereId(q, "load_state_miles", "load_id", loadId);
    const accessorials = await readRowsWhereId(q, "load_accessorials", "load_id", loadId);
    const [load] = loadsOf(loads, miles, accessorials);
    const engine = invoiceAmount(load);
    // The proposal is a correction to what the engine says, never a free number.
    if (!engine.ok || engine.amountCents !== args.newAmountCents) {
      return refused("engine_refused", max, delta);
    }
    // A new total below what customers already paid on it is not a fix the ledger can carry.
    const applied = (await readRowsWhereId(q, "payment_applications", "invoice_id", invoice.id))
      .reduce((n, a) => n + a.amount_cents, 0);
    if (applied > args.newAmountCents) return refused("engine_refused", max, delta);
    return {
      ok: true,
      limitCents: cents(max),
      requestedCents: cents(delta),
      exceptions: [],
      reasons: [],
      sources: [{ table: "invoices", id: invoice.id }, ...engine.sources],
    };
  } catch {
    return unavailable(null);
  }
}

// ---- Load rate fill ----

export type LoadRateLimitArgs = {
  loadId: string;
  linehaulCents: number;
  fuelSurchargeCents: number;
  ratePerMileCents: number;
  requestRef: string;
};

// A fill moves no money (limit 0, requested 0); what it guards is that the numbers are the
// document's and the document is this load's. The load must still have no rate and be in a status
// that can take one, miles times the rate per mile must be the linehaul, and the rate
// confirmation named by requestRef must be read, compared again now with this load, support the
// fill, and carry exactly these cents.
export async function loadRateLimit(
  q: Queryable,
  _ctx: GatewayContext,
  args: LoadRateLimitArgs,
): Promise<LimitResult> {
  try {
    const [load] = await readRowsWhereId(q, "loads", "id", args.loadId);
    if (!load) return unavailable(0);
    if (load.linehaul_cents !== null || !RATE_FILL_STATUSES.includes(load.status)) {
      return refused("engine_refused", 0, 0);
    }
    const linehaul = args.ratePerMileCents * load.loaded_miles;
    if (!Number.isSafeInteger(linehaul) || linehaul !== args.linehaulCents) return refused("engine_refused", 0, 0);
    const doc = await readDocumentForInput(q, args.requestRef);
    const read = doc?.read ?? null;
    if (!doc || doc.readStatus !== "read" || !read || read.kind !== "rate_confirmation") {
      return refused("engine_refused", 0, 0);
    }
    const match = matchDocument(read, await loadCandidates(q, read));
    if (!match.found || match.supports !== "load_rate_fill" || match.loadId !== load.id) {
      return refused("engine_refused", 0, 0);
    }
    const f = read.fields;
    if (
      f.linehaulCents !== args.linehaulCents ||
      f.fuelSurchargeCents !== args.fuelSurchargeCents ||
      f.ratePerMileCents !== args.ratePerMileCents
    ) {
      return refused("engine_refused", 0, 0);
    }
    return {
      ok: true,
      limitCents: cents(0),
      requestedCents: cents(0),
      exceptions: [],
      reasons: ["missing_rate"],
      sources: [{ table: "loads", id: load.id }],
    };
  } catch {
    return unavailable(null);
  }
}
