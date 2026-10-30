import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { detentionChargeOf, readDetentionChargeRows } from "../../data/detention-charge";
import { loadsOf } from "../../data/records";
import { readActiveCardById } from "../../advances/cards";
import {
  readAdvanceInput,
  readMoneyCodeInput,
  readReceivablesInput,
  readRowsWhereId,
  readSettlementInput,
} from "../../data/read";
import { matchWrongInvoiceFinding, type ReapplyIds } from "../../invoices/match";
import { readRuleChangeRows, ruleChangeOf } from "../../pay-rules/change";
import { paymentPostedOutside } from "../../invoices/posted-outside";
import {
  advanceEligibility,
  cents,
  checkMoneyCode,
  findPaymentOnWrongInvoice,
  invoiceAmount,
  type AdvanceDecision,
  type MoneyCodePurpose,
  type MoneyCodeSource,
} from "../../rules-engine";
import { loadCandidates } from "../../documents/candidates";
import { matchDocument, RATE_FILL_STATUSES } from "../../documents/match";
import { isWithin, localDateOf } from "../../time/local-date";
import { readDocumentForInput } from "./store/document-reads";
import { optionReasons } from "../../cash/args";
import { liveReleaseOf, readDriverEscrow, readDriverReleases, releaseFactRefusal } from "../../escrow/read";
import { escrowReleaseGate } from "../../escrow/switches";
import { factoringProposalOf } from "../../factoring/propose";
import type { GatewayContext, GatewayRef, LimitResult, ReasonCategory } from "./types";

// Amount limits for the propose tools. The rules engine sizes every number; the gateway only
// compares. A proposal above its limit never exists. Any read or engine error is
// limit_unavailable: unknown is not zero.

const OVER_LIMIT_REASONS = new Set(["over_driver_limit", "exceeds_earned_share", "over_load_cap"]);

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

// loadId: the load the advance is for (its per-load cap applies); cardId: a card other than the
// driver's default, which must be one of the driver's active cards.
export type AdvanceLimitArgs = {
  driverId: string;
  amountCents: number;
  requestedOn: string;
  loadId?: string;
  cardId?: string;
};

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
  let loadFound: boolean;
  let cardFound: boolean;
  try {
    const input = await readAdvanceInput(q, args.driverId, ctx.now.toISOString(), args.amountCents, args.loadId);
    requestedOn = input.requestedOn;
    loadFound = input.load !== null && input.load !== undefined;
    decision = advanceEligibility(input);
    cardFound = args.cardId === undefined || (await readActiveCardById(q, args.driverId, args.cardId)) !== null;
  } catch {
    return unavailable(args.amountCents);
  }
  // A load that is not this driver's: nothing to size the advance against, never a guess.
  if (args.loadId !== undefined && !loadFound) return refused("engine_refused", 0, args.amountCents);
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
  // A named card that is not one of the driver's active cards stays on the card as an exception,
  // so it is never clean; the executor refuses to pay it.
  const exceptions: ReasonCategory[] = [
    ...(capped ? (["capped_to_eligible"] as const) : []),
    ...(cardFound ? [] : (["card_not_drivers"] as const)),
  ];
  return {
    ok: true,
    limitCents: decision.maxCents,
    requestedCents: cents(args.amountCents),
    exceptions,
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

// ---- Payment moves ----

// A payment move exists only for a payment_on_wrong_invoice finding the rules engine makes now,
// matched on all four ids whole and in order. The amount is the application's, never the
// model's. A payment already posted to the accounting system is refused here too, and so is one
// whose post is reserved, sent or not yet known (any ledger row for it that is not failed):
// moving it in this app alone would leave the two books disagreeing. The switch is read here too.
export async function paymentReapplyLimit(
  q: Queryable,
  ctx: GatewayContext,
  args: ReapplyIds,
): Promise<LimitResult> {
  if (!flags.customerPaymentsEnabled) return unavailable(null);
  try {
    const [application] = await readRowsWhereId(q, "payment_applications", "id", args.applicationId);
    const [payment] = await readRowsWhereId(q, "customer_payments", "id", args.paymentId);
    if (!application || !payment) return unavailable(null);
    const amount = application.amount_cents;
    if (await paymentPostedOutside(q, { id: payment.id, qbo_id: payment.qbo_id })) {
      return refused("engine_refused", amount, amount);
    }
    const asOf = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const finding = matchWrongInvoiceFinding(
      findPaymentOnWrongInvoice(await readReceivablesInput(q, asOf)),
      args,
    );
    if (!finding || finding.amountCents !== amount) return refused("engine_refused", amount, amount);
    return {
      ok: true,
      limitCents: cents(amount),
      requestedCents: cents(amount),
      exceptions: [],
      reasons: ["payment_on_wrong_invoice"],
      sources: finding.sources,
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

// ---- Detention charges ----

export type DetentionChargeLimitArgs = { loadId: string; amountCents: number };

// The detention the engine computes for the load, from its stop times and its customer's terms,
// is the only number a detention proposal may carry, and only onto the load's open invoice that
// was never posted and still equals the engine's total. Anything else is engine_refused; above
// detentionChargeMaxCents it is amount_over_limit. The switch is read here too.
export async function detentionChargeLimit(
  q: Queryable,
  _ctx: GatewayContext,
  args: DetentionChargeLimitArgs,
): Promise<LimitResult> {
  const max = flags.gatewayLimits.detentionChargeMaxCents;
  if (!flags.detentionEnabled || !Number.isSafeInteger(max) || max <= 0) {
    return unavailable(args.amountCents);
  }
  try {
    const rows = await readDetentionChargeRows(q, args.loadId);
    if (!rows) return unavailable(args.amountCents);
    const check = detentionChargeOf(rows);
    // No charge the engine would add (no detention, already billed, no open unposted invoice,
    // or an invoice that already differs from the engine): nothing to allow.
    if (!check.ok) return refused("engine_refused", null, args.amountCents);
    const engine = check.charge.amountCents;
    if (args.amountCents !== engine) return refused("engine_refused", Math.min(engine, max), args.amountCents);
    if (engine > max) return refused("amount_over_limit", max, args.amountCents);
    return {
      ok: true,
      limitCents: cents(Math.min(engine, max)),
      requestedCents: cents(args.amountCents),
      exceptions: [],
      reasons: [],
      sources: check.charge.sources,
    };
  } catch {
    return unavailable(args.amountCents);
  }
}

// ---- Money codes ----

export type MoneyCodeLimitArgs = {
  driverId: string;
  loadId: string;
  amountCents: number;
  purpose: MoneyCodePurpose;
  source: MoneyCodeSource;
  documentId: string | null;
  voiceNoteId: string | null;
  // The outside input the evidence came through, cited as the proposal's source.
  inputId: string | null;
};

// A money code only for the amount the rules engine allows on that load as of now: the receipt's
// total (or an amount the driver said), at or under moneyCodes.capCents. Every refusal carries the
// engine's first refusal word, so the agent can ask for what is missing; one that is only over the
// cap is amount_over_limit. The switch is read here too.
export async function moneyCodeLimit(
  q: Queryable,
  ctx: GatewayContext,
  args: MoneyCodeLimitArgs,
): Promise<LimitResult> {
  const { enabled, capCents, perDriverPerDay } = flags.moneyCodes;
  if (enabled !== true || !Number.isSafeInteger(capCents) || capCents <= 0) {
    return unavailable(args.amountCents);
  }
  let decision: ReturnType<typeof checkMoneyCode>;
  try {
    const input = await readMoneyCodeInput(
      q,
      {
        driverId: args.driverId,
        loadId: args.loadId,
        purpose: args.purpose,
        amountCents: args.amountCents,
        source: args.source,
        documentId: args.documentId,
        voiceNoteId: args.voiceNoteId,
        capCents,
        perDriverPerDay,
      },
      ctx.now.toISOString(),
    );
    decision = checkMoneyCode(input);
  } catch {
    return unavailable(args.amountCents);
  }
  if (!decision.ok) {
    const overOnly = decision.refusals.every((r) => r === "over_code_cap");
    const r = refused(overOnly ? "amount_over_limit" : "engine_refused", capCents, args.amountCents);
    return r.ok ? r : { ...r, category: decision.category };
  }
  const sources: GatewayRef[] = [
    { table: "drivers", id: args.driverId },
    { table: "loads", id: args.loadId },
    ...(args.inputId ? [{ table: "untrusted_inputs" as const, id: args.inputId }] : []),
  ];
  return {
    ok: true,
    limitCents: cents(capCents),
    requestedCents: cents(args.amountCents),
    exceptions: [],
    reasons: [...decision.reasons],
    sources,
  };
}

export type RuleChangeLimitArgs = {
  ruleKey: string;
  newValue: number | string | null;
  askedFrom: string;
  effectiveFrom: string;
  oldValue: number | string | null;
  impactCents: number;
};

// A pay rule change: the shared check runs again from the rows, with the person's sentence from
// this turn, and the start date, the old value and the weekly impact must each equal the engine's
// (whole values). Any refusal of the change, or any difference, is engine_refused; an impact whose
// size is over ruleChangeImpactMaxCents is amount_over_limit. The switch is read here too. The
// amount compared is the size of the change to last settled week's total net pay.
export async function ruleChangeLimit(
  q: Queryable,
  ctx: GatewayContext,
  args: RuleChangeLimitArgs,
): Promise<LimitResult> {
  const max = flags.gatewayLimits.ruleChangeImpactMaxCents;
  const requested = Math.abs(args.impactCents);
  if (!flags.rulesByTalkingEnabled || !Number.isSafeInteger(max) || max <= 0) {
    return unavailable(requested);
  }
  try {
    const rows = await readRuleChangeRows(q);
    const check = ruleChangeOf(rows, args, { text: ctx.userText ?? null }, ctx.now);
    if (!check.ok) return refused("engine_refused", null, requested);
    const c = check.change;
    const engine = c.impact.netDeltaCents;
    if (c.effectiveFrom !== args.effectiveFrom || c.oldValue !== args.oldValue || engine !== args.impactCents) {
      return refused("engine_refused", Math.min(Math.abs(engine), max), requested);
    }
    if (Math.abs(engine) > max) return refused("amount_over_limit", max, requested);
    return {
      ok: true,
      limitCents: cents(max),
      requestedCents: cents(Math.abs(engine)),
      exceptions: [],
      reasons: ["rule_change_sized_by_engine"],
      sources: c.sources,
    };
  } catch {
    return unavailable(requested);
  }
}

// ---- Factoring ----

export type FactoringLimitArgs = { invoiceIds: readonly string[] };

// The agent names invoices, never a number: the engine sizes the request on exactly those
// invoices, and the most one request may bring in (factoring.maxNetCents) is the limit. A request
// the engine refuses (an invoice too old, already factored, not open, or no short to name) is
// engine_refused with no number; get_factoring_packet says which invoice and why.
export async function factoringLimit(
  q: Queryable,
  ctx: GatewayContext,
  args: FactoringLimitArgs,
): Promise<LimitResult> {
  const max = flags.factoring?.maxNetCents;
  if (flags.factoring?.enabled !== true || typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
    return unavailable(null);
  }
  try {
    const p = await factoringProposalOf(q, ctx.timeZone, ctx.now, args.invoiceIds);
    if (!p.ok) return { ok: false, reason: "engine_refused", limitCents: null, requestedCents: null };
    const net = p.option.amountCents;
    if (net > max) return refused("amount_over_limit", max, net);
    return {
      ok: true,
      limitCents: cents(Math.min(net, max)),
      requestedCents: cents(net),
      exceptions: [],
      reasons: optionReasons(p.option),
      sources: p.option.sources,
    };
  } catch {
    return unavailable(null);
  }
}

// ---- Escrow releases ----

export type EscrowReleaseLimitArgs = { driverId: string; amountCents: number; balanceAsOf: string };

// A terminated driver's escrow release: the whole release gate on the carrier's local date of
// this call (the cap is the limit, and an amount over it is amount_over_limit), the balance read
// as of today (balanceAsOf must be today, so the card says which day's balance it sends), then the
// driver's facts as of now: terminated, no live release, a balance above zero and exactly this
// amount. Every other refusal is engine_refused with its fixed category word.
export async function escrowReleaseLimit(
  q: Queryable,
  ctx: GatewayContext,
  args: EscrowReleaseLimitArgs,
): Promise<LimitResult> {
  const e = flags.escrowRelease;
  if (e?.enabled !== true || !Number.isSafeInteger(e.capCents) || e.capCents <= 0) {
    return unavailable(args.amountCents);
  }
  const named = (category: string): LimitResult => {
    const r = refused("engine_refused", e.capCents, args.amountCents);
    return r.ok ? r : { ...r, category };
  };
  let today: string;
  try {
    today = localDateOf(ctx.now.toISOString(), ctx.timeZone);
  } catch {
    return unavailable(args.amountCents);
  }
  const gate = escrowReleaseGate(args.amountCents, today);
  if (gate === "over_escrow_cap") return refused("amount_over_limit", e.capCents, args.amountCents);
  if (gate) return named(gate);
  if (args.balanceAsOf !== today) return named("balance_date_mismatch");
  let fact: ReturnType<typeof releaseFactRefusal>;
  try {
    const driver = await readDriverEscrow(q, args.driverId);
    const live = driver ? liveReleaseOf(await readDriverReleases(q, args.driverId)) : null;
    fact = releaseFactRefusal(driver, live, args.amountCents, today);
  } catch {
    return unavailable(args.amountCents);
  }
  if (fact) return named(fact);
  return {
    ok: true,
    limitCents: cents(Math.min(args.amountCents, e.capCents)),
    requestedCents: cents(args.amountCents),
    exceptions: [],
    reasons: [],
    sources: [{ table: "drivers", id: args.driverId }],
  };
}
