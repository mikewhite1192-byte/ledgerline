import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { optionArgs, sameArgs } from "../../../../cash/args";
import type { Queryable } from "../../../../db";
import { chargeArgsSchema, chargeMatches, detentionChargeOf, readDetentionChargeRows } from "../../../../data/detention-charge";
import { changeArgsSchema, changeMatches, readRuleChangeRows, ruleChangeOf } from "../../../../pay-rules/change";
import { loadsOf } from "../../../../data/records";
import {
  readAdvanceInput,
  readCashFridayInput,
  readCheckInput,
  readMoneyCodeInput,
  readReceivablesInput,
  readRowsWhereId,
} from "../../../../data/read";
import { TENANT_TABLES, type TenantTable } from "../../../../data/tables";
import { matchWrongInvoiceFinding } from "../../../../invoices/match";
import { paymentPostedOutside } from "../../../../invoices/posted-outside";
import { lineSummary, sameLines, type LineSummary } from "../../../../invoices/queue";
import { settlementEvidence } from "../../../../settlements/evidence";
import {
  advanceEligibility,
  checkMoneyCode,
  computeCashFriday,
  findPaymentOnWrongInvoice,
  invoiceAmount,
  MONEY_CODE_PURPOSES,
  MONEY_CODE_SOURCES,
  runAllChecks,
  type MoneyCodePurpose,
  type MoneyCodeSource,
} from "../../../../rules-engine";
import { localDateOf } from "../../../../time/local-date";
import { isUuid } from "../../../../uuid";
import { defineTool, type AgentRole, type GatewayContext } from "../../types";
import { loadRateLimit } from "../../limits";
import { idField } from "../../validate";

// The auditor's evidence for one proposal (design 4.2 step 3): the proposal as stored, the
// records it cites with their current figures, and the rules engine's own number for it. Built
// from records and the engine only. Nothing is read from untrusted_inputs: whether the proposal
// was flagged, and why, comes from the proposal and its screening. For a rate fill the check is
// the gateway's own rate limit run again now (the stored reading compared with the load in code);
// only its outcome, as codes, reaches the pack, never the document's text. A person's override
// reason is never selected. Every string that reaches the pack is a code, an enum, an id or a date.

const AUDITOR: readonly AgentRole[] = ["auditor"];

const MAX_SOURCES = 12;
const MAX_FINDINGS = 8;
const MAX_ENGINE_SOURCES = 8;
// Below the gateway's 8,000-character cap, so the pack is never cut to a note.
const MAX_PACK_CHARS = 7_600;

// The figures a source row shows, per table. Names, emails, addresses, descriptions and memos are
// never in this list.
const SOURCE_FIELDS: Partial<Record<TenantTable, readonly string[]>> = {
  customers: ["code", "terms_days"],
  drivers: [
    "code",
    "worker_type",
    "pay_basis",
    "per_mile_cents",
    "percent_bps",
    "flat_per_load_cents",
    "advance_limit_cents",
    "escrow_balance_cents",
    "active_from",
    "active_to",
  ],
  loads: [
    "load_number",
    "customer_id",
    "driver_id",
    "status",
    "pickup_on",
    "delivered_on",
    "loaded_miles",
    "empty_miles",
    "linehaul_cents",
    "fuel_surcharge_cents",
  ],
  load_state_miles: ["load_id", "state", "miles"],
  load_accessorials: ["load_id", "kind", "amount_cents", "paid_by_driver"],
  driver_days: ["driver_id", "day", "source", "load_id"],
  fuel_purchases: ["driver_id", "load_id", "purchased_on", "state", "gallons_milli", "amount_cents", "paid_with"],
  // Every knob of a version (numbers and enums); the note is free text and stays out.
  pay_configs: [
    "effective_from",
    "source",
    "week_start_dow",
    "percent_base",
    "empty_miles_paid_bps",
    "accessorial_driver_share_bps",
    "insurance_applies_to",
    "insurance_per_day_cents",
    "escrow_target_cents",
    "escrow_per_settlement_cents",
    "net_pay_floor_cents",
    "advance_recovery_cap_cents",
    "advance_fee_cents",
    "advance_limit_default_cents",
    "advance_max_bps_of_earned",
    "advance_min_cents",
  ],
  deduction_schedules: ["driver_id", "kind", "amount_cents", "target_cents", "active_from", "active_to"],
  settlement_periods: ["period_start", "period_end", "status"],
  settlements: ["period_id", "driver_id", "status", "gross_cents", "deductions_cents", "net_cents", "carry_forward_cents"],
  settlement_lines: ["settlement_id", "kind", "amount_cents"],
  pay_items: ["driver_id", "kind", "subkind", "amount_cents", "item_date", "settlement_id"],
  advances: ["driver_id", "requested_on", "amount_cents", "fee_cents", "status", "recovered_cents", "source"],
  invoices: ["source", "load_id", "customer_id", "invoice_number", "amount_cents", "issued_on", "due_on", "status", "paid_on"],
  customer_payments: ["customer_id", "received_on", "amount_cents", "method", "source"],
  payment_applications: ["payment_id", "invoice_id", "amount_cents"],
  vendor_bills: ["bill_ref", "category", "amount_cents", "due_on", "urgency", "status", "deferred_to", "paid_on"],
};

// A code, an enum, an id, a date or an instant. Anything with a space or other characters is
// dropped: free text never reaches the auditor.
const SAFE_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/;
const CATEGORY = /^[a-z_]{2,40}$/;
const ARG_KEY = /^[A-Za-z]{1,40}$/;

type Scalar = string | number | boolean | null;

function safeScalar(v: unknown): Scalar | undefined {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return SAFE_TEXT.test(v) ? v : undefined;
  return undefined;
}

type Ref = { table: string; id: string };

function refOf(v: unknown): Ref | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { table, id } = v as Record<string, unknown>;
  return typeof table === "string" && CATEGORY.test(table) && isUuid(id) ? { table, id } : null;
}

// The proposal's args as the gateway validated them, with anything that is not a safe scalar, a
// list of them, or a record reference left out.
function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!ARG_KEY.test(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 16).flatMap((v): (Ref | Scalar)[] => {
        const ref = refOf(v);
        if (ref) return [ref];
        const s = safeScalar(v);
        return s === undefined ? [] : [s];
      });
      continue;
    }
    const ref = refOf(value);
    if (ref) {
      out[key] = ref;
      continue;
    }
    const s = safeScalar(value);
    if (s !== undefined) out[key] = s;
  }
  return out;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function categoriesOf(text: string | null): string[] {
  const v = parseJson(text);
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>).category : x))
    .filter((c): c is string => typeof c === "string" && CATEGORY.test(c))
    .slice(0, 12);
}

function refsOf(text: string | null): Ref[] {
  const v = parseJson(text);
  return Array.isArray(v) ? v.flatMap((r) => (refOf(r) ? [refOf(r)!] : [])) : [];
}

function picked(table: TenantTable, row: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const key of SOURCE_FIELDS[table] ?? []) {
    const s = safeScalar(row[key]);
    if (s !== undefined) out[key] = s;
  }
  return out;
}

const isTenantTable = (t: string): t is TenantTable => (TENANT_TABLES as readonly string[]).includes(t);

// One cited record with its current figures. A table with no figure list (the outside text, its
// screening) shows as its reference only.
async function sourceRow(q: Queryable, ref: Ref): Promise<Record<string, unknown>> {
  if (!isTenantTable(ref.table) || !SOURCE_FIELDS[ref.table]) return { table: ref.table, id: ref.id };
  const [row] = await readRowsWhereId(q, ref.table, "id", ref.id);
  if (!row) return { table: ref.table, id: ref.id, missing: true };
  return { table: ref.table, id: ref.id, ...picked(ref.table, row as Record<string, unknown>) };
}

type ProposalRow = {
  id: string;
  kind: string;
  title: string;
  subject_table: string;
  subject_id: string;
  subject_label: string | null;
  amount_cents: number | string;
  direction: string;
  operator_verdict: string;
  status: string;
  reasons: string;
  sources: string;
  args: string;
  exceptions: string;
  flagged: boolean;
  flag_categories: string | null;
};

// Every column named; never auditor_override_*, never the outside text.
const PROPOSAL_SQL = `
  SELECT p.id, p.kind, p.title, p.subject_table, p.subject_id,
         CASE p.subject_table
           WHEN 'drivers' THEN (SELECT d.code FROM drivers d
                                 WHERE d.tenant_id = current_tenant_id() AND d.id = p.subject_id)
           WHEN 'invoices' THEN (SELECT i.invoice_number FROM invoices i
                                  WHERE i.tenant_id = current_tenant_id() AND i.id = p.subject_id)
           WHEN 'loads' THEN (SELECT l.load_number FROM loads l
                               WHERE l.tenant_id = current_tenant_id() AND l.id = p.subject_id)
           WHEN 'payment_applications' THEN (
             SELECT cp.payment_ref FROM payment_applications a
               JOIN customer_payments cp ON cp.tenant_id = a.tenant_id AND cp.id = a.payment_id
              WHERE a.tenant_id = current_tenant_id() AND a.id = p.subject_id)
           WHEN 'vendor_bills' THEN (SELECT b.bill_ref FROM vendor_bills b
                                      WHERE b.tenant_id = current_tenant_id() AND b.id = p.subject_id)
           WHEN 'customers' THEN (SELECT c.code FROM customers c
                                   WHERE c.tenant_id = current_tenant_id() AND c.id = p.subject_id)
           WHEN 'settlement_periods' THEN (SELECT CAST(sp.period_start AS text) FROM settlement_periods sp
                                            WHERE sp.tenant_id = current_tenant_id() AND sp.id = p.subject_id)
         END AS subject_label,
         p.amount_cents, p.direction, p.operator_verdict, p.status,
         CAST(p.reasons AS text) AS reasons, CAST(p.sources AS text) AS sources,
         CAST(p.args AS text) AS args, CAST(p.exceptions AS text) AS exceptions,
         (p.flagged_input_id IS NOT NULL) AS flagged,
         (SELECT CAST(s.categories AS text) FROM screenings s
           WHERE s.tenant_id = current_tenant_id() AND s.input_id = p.flagged_input_id
           ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS flag_categories
    FROM proposals p
   WHERE p.tenant_id = current_tenant_id() AND p.id = CAST($1 AS uuid)`;

type Engine = Record<string, unknown>;
const UNAVAILABLE: Engine = { ok: false, reason: "unavailable" };

const refList = (list: readonly Ref[], n: number) => list.slice(0, n).map((r) => ({ table: r.table, id: r.id }));

async function advanceEngine(
  q: Queryable,
  ctx: GatewayContext,
  p: ProposalRow,
  amount: number,
  args: Record<string, unknown>,
): Promise<Engine> {
  if (p.subject_table !== "drivers") return UNAVAILABLE;
  // The load the proposal names, so its per-load cap is asked as the executor will ask it.
  const loadId = args.loadId === undefined || args.loadId === null ? null : args.loadId;
  if (loadId !== null && !isUuid(loadId)) return UNAVAILABLE;
  const input = await readAdvanceInput(q, p.subject_id, ctx.now.toISOString(), amount, loadId);
  if (loadId !== null && !input.load) return UNAVAILABLE;
  const d = advanceEligibility(input);
  return {
    ok: true,
    check: "advance_eligibility",
    proposedCents: amount,
    eligible: d.eligible,
    approvedCents: d.approvedCents,
    maxCents: d.maxCents,
    feeCents: d.feeCents,
    limitCents: d.limitCents,
    earnedUnpaidCents: d.earnedUnpaidCents,
    openCents: d.openCents,
    loadCapCents: d.loadCapCents,
    loadHeadroomCents: d.loadHeadroomCents,
    refusals: [...d.reasons],
    sources: refList(d.sources, MAX_ENGINE_SOURCES),
  };
}

async function payCorrectionEngine(q: Queryable, args: Record<string, unknown>): Promise<Engine> {
  const { driverId, periodId, payItemId, deltaCents } = args;
  if (!isUuid(driverId) || !isUuid(periodId) || !Number.isSafeInteger(deltaCents)) return UNAVAILABLE;
  const findings = runAllChecks(await readCheckInput(q))
    .filter((f) => f.driverId === driverId)
    .slice(0, MAX_FINDINGS)
    .map((f) => ({
      check: f.check,
      category: f.category,
      amountCents: f.amountCents ?? null,
      sources: refList(f.sources, 4),
    }));
  const [period] = await readRowsWhereId(q, "settlement_periods", "id", periodId);
  const item = isUuid(payItemId) ? (await readRowsWhereId(q, "pay_items", "id", payItemId))[0] : undefined;
  return {
    ok: true,
    check: "pay_checks",
    proposedDeltaCents: deltaCents,
    period: period ? { id: period.id, ...picked("settlement_periods", period as Record<string, unknown>) } : null,
    payItem: item ? { id: item.id, ...picked("pay_items", item as Record<string, unknown>) } : null,
    findings,
  };
}

async function invoiceEngine(q: Queryable, p: ProposalRow, args: Record<string, unknown>): Promise<Engine> {
  if (p.subject_table !== "invoices" || !Number.isSafeInteger(args.newAmountCents)) return UNAVAILABLE;
  const [invoice] = await readRowsWhereId(q, "invoices", "id", p.subject_id);
  if (!invoice) return UNAVAILABLE;
  const appliedCents = (await readRowsWhereId(q, "payment_applications", "invoice_id", invoice.id)).reduce(
    (n, a) => n + a.amount_cents,
    0,
  );
  const base = {
    ok: true,
    check: "invoice_amount",
    currentCents: invoice.amount_cents,
    proposedCents: args.newAmountCents,
    appliedCents,
  };
  if (invoice.load_id === null) return { ...base, engine: { ok: false, reason: "no_load" } };
  const loads = await readRowsWhereId(q, "loads", "id", invoice.load_id);
  if (loads.length !== 1) return { ...base, engine: { ok: false, reason: "no_load" } };
  const miles = await readRowsWhereId(q, "load_state_miles", "load_id", invoice.load_id);
  const accessorials = await readRowsWhereId(q, "load_accessorials", "load_id", invoice.load_id);
  const result = invoiceAmount(loadsOf(loads, miles, accessorials)[0]);
  const engine = result.ok
    ? {
        ok: true,
        amountCents: result.amountCents,
        lines: result.lines.map((l) => ({ kind: l.kind, amountCents: l.amountCents })),
        sources: refList(result.sources, MAX_ENGINE_SOURCES),
      }
    : { ok: false, reason: result.reason, sources: refList(result.sources, MAX_ENGINE_SOURCES) };
  return { ...base, engine };
}

// The card's invoice lines as stored, or null when any entry is not a kind and integer cents.
function cardLinesOf(v: unknown): LineSummary[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 40) return null;
  const out: LineSummary[] = [];
  for (const line of v) {
    if (!line || typeof line !== "object") return null;
    const { kind, amountCents } = line as Record<string, unknown>;
    if (typeof kind !== "string" || !CATEGORY.test(kind) || !Number.isSafeInteger(amountCents)) return null;
    out.push({ kind: kind as LineSummary["kind"], amountCents: amountCents as number });
  }
  return out;
}

// An engine invoice card (invoice_post), checked the way its executor checks it: the load must
// still be delivered with no invoice, and the engine's total and lines for it now must equal the
// card's. Every check's outcome is reported, so a mismatch is evidence, never a silent pass.
async function invoicePostEngine(q: Queryable, p: ProposalRow, args: Record<string, unknown>): Promise<Engine> {
  const loadId = p.subject_id;
  if (p.subject_table !== "loads" || args.loadId !== loadId || !Number.isSafeInteger(args.amountCents)) {
    return UNAVAILABLE;
  }
  const loads = await readRowsWhereId(q, "loads", "id", loadId);
  if (loads.length !== 1) return { ok: true, check: "invoice_post", loadFound: false };
  const invoiced = (await readRowsWhereId(q, "invoices", "load_id", loadId)).length > 0;
  const miles = await readRowsWhereId(q, "load_state_miles", "load_id", loadId);
  const accessorials = await readRowsWhereId(q, "load_accessorials", "load_id", loadId);
  const [load] = loadsOf(loads, miles, accessorials);
  const base = {
    ok: true,
    check: "invoice_post",
    loadFound: true,
    loadStatus: safeScalar(loads[0].status) ?? null,
    alreadyInvoiced: invoiced,
    proposedCents: args.amountCents,
  };
  const result = invoiceAmount(load);
  if (!result.ok) {
    return { ...base, engine: { ok: false, reason: result.reason, sources: refList(result.sources, MAX_ENGINE_SOURCES) } };
  }
  const lines = lineSummary(result.lines);
  const cardLines = cardLinesOf(args.lines);
  return {
    ...base,
    proposedLines: cardLines ?? [],
    engine: {
      ok: true,
      amountCents: result.amountCents,
      lines: lines.map((l) => ({ kind: l.kind, amountCents: l.amountCents })),
      sources: refList(result.sources, MAX_ENGINE_SOURCES),
    },
    matches: {
      amount: result.amountCents === args.amountCents && result.amountCents === Number(p.amount_cents),
      lines: cardLines !== null && sameLines(lines, cardLines),
    },
  };
}

// A rate fill moves no money; its check is whether the gateway's rate limit still takes these
// exact numbers for this load (the load still has no rate and can take one, miles times the rate
// per mile is the linehaul, and the named document's reading supports the fill with these cents).
// A refusal carries the limit's reason; a read error is unavailable.
async function rateFillEngine(
  q: Queryable,
  ctx: GatewayContext,
  p: ProposalRow,
  args: Record<string, unknown>,
): Promise<Engine> {
  const { loadId, linehaulCents, fuelSurchargeCents, ratePerMileCents, requestRef } = args;
  if (
    p.subject_table !== "loads" ||
    !isUuid(loadId) ||
    loadId !== p.subject_id ||
    !isUuid(requestRef) ||
    typeof linehaulCents !== "number" ||
    typeof fuelSurchargeCents !== "number" ||
    typeof ratePerMileCents !== "number" ||
    !Number.isSafeInteger(linehaulCents) ||
    !Number.isSafeInteger(fuelSurchargeCents) ||
    !Number.isSafeInteger(ratePerMileCents)
  ) {
    return UNAVAILABLE;
  }
  const limit = await loadRateLimit(q, ctx, { loadId, linehaulCents, fuelSurchargeCents, ratePerMileCents, requestRef });
  if (!limit.ok && limit.reason === "limit_unavailable") return UNAVAILABLE;
  const base = {
    ok: true,
    check: "load_rate_fill",
    proposedLinehaulCents: linehaulCents,
    proposedFuelSurchargeCents: fuelSurchargeCents,
    ratePerMileCents,
  };
  if (!limit.ok) return { ...base, supported: false, refusal: limit.reason };
  return { ...base, supported: true, reasons: limit.reasons.filter((r) => CATEGORY.test(r)) };
}

// The detention the engine finds on the load today, the invoice it would go on, and whether the
// stored figures (stops, instants, terms, invoice and its amount before) still match it exactly.
// The stored args are parsed whole with their own schema here: the pack's safe args drop the stops.
async function detentionEngine(q: Queryable, p: ProposalRow): Promise<Engine> {
  if (p.subject_table !== "loads" || !isUuid(p.subject_id)) return UNAVAILABLE;
  const rows = await readDetentionChargeRows(q, p.subject_id);
  if (!rows) return UNAVAILABLE;
  const check = detentionChargeOf(rows);
  const base = { ok: true, check: "detention_charge", proposedCents: Number(p.amount_cents) };
  if (!check.ok) return { ...base, engine: { ok: false, reason: check.reason } };
  const c = check.charge;
  const stored = chargeArgsSchema.safeParse(parseJson(p.args));
  return {
    ...base,
    engine: {
      ok: true,
      amountCents: c.amountCents,
      freeMinutes: c.freeMinutes,
      hourlyCents: c.hourlyCents,
      invoiceId: c.invoiceId,
      invoiceAmountBeforeCents: c.invoiceAmountBeforeCents,
      invoiceAmountAfterCents: c.invoiceAmountAfterCents,
      stops: c.stops.map((s) => ({
        stop: s.stop,
        arrivedAt: s.arrivedAt,
        departedAt: s.departedAt,
        dwellMinutes: s.dwellMinutes,
        overMinutes: s.overMinutes,
        quarters: s.quarters,
        cents: s.cents,
      })),
      matchesProposal: stored.success && chargeMatches(stored.data, c),
      sources: refList(c.sources, MAX_ENGINE_SOURCES),
    },
  };
}

// A pay rule change, checked the way its executor checks it: the engine sizes the same change
// again now (the sentence was checked when it was proposed, so grounding is skipped), and the
// stored figures must equal the engine's whole. A refusal (a week that began, a version paid
// under, a later version) is a mismatch, never a yes.
async function ruleChangeEngine(q: Queryable, ctx: GatewayContext, p: ProposalRow): Promise<Engine> {
  if (p.subject_table !== "pay_configs" || !isUuid(p.subject_id)) return UNAVAILABLE;
  const stored = changeArgsSchema.safeParse(parseJson(p.args));
  if (!stored.success || stored.data.baseVersionId !== p.subject_id) return UNAVAILABLE;
  const a = stored.data;
  const check = ruleChangeOf(
    await readRuleChangeRows(q),
    { ruleKey: a.ruleKey, newValue: a.newValue, askedFrom: a.askedFrom },
    "skip",
    ctx.now,
  );
  const base = { ok: true, check: "pay_rule_change", proposedCents: Number(p.amount_cents) };
  if (!check.ok) return { ...base, engine: { ok: false, reason: check.reason } };
  const c = check.change;
  return {
    ...base,
    engine: {
      ok: true,
      amountCents: Math.abs(c.impact.netDeltaCents),
      figures: {
        oldValue: c.oldValue,
        newValue: c.newValue,
        effectiveFrom: c.effectiveFrom,
        driversChanged: c.impact.driversChanged,
        netDeltaCents: c.impact.netDeltaCents,
      },
      matchesProposal: changeMatches(a, c) && Number(p.amount_cents) === Math.abs(c.impact.netDeltaCents),
      sources: refList(c.sources, MAX_ENGINE_SOURCES),
    },
  };
}

// A payment move (payment_reapply), checked the way its executor checks it: the payment is not in
// QuickBooks yet and has no post reserved, sent or not yet known (the executor's own rule), the
// application is where the card says, and the engine's payment_on_wrong_invoice finding still
// names exactly these four records for the application's amount.
async function paymentReapplyEngine(
  q: Queryable,
  ctx: GatewayContext,
  p: ProposalRow,
  args: Record<string, unknown>,
): Promise<Engine> {
  const { paymentId, applicationId, fromInvoiceId, toInvoiceId } = args;
  if (
    p.subject_table !== "payment_applications" ||
    applicationId !== p.subject_id ||
    !isUuid(paymentId) ||
    !isUuid(applicationId) ||
    !isUuid(fromInvoiceId) ||
    !isUuid(toInvoiceId)
  ) {
    return UNAVAILABLE;
  }
  const [application] = await readRowsWhereId(q, "payment_applications", "id", applicationId);
  const [payment] = await readRowsWhereId(q, "customer_payments", "id", paymentId);
  if (!application || !payment) return { ok: true, check: "payment_on_wrong_invoice", found: false };
  const amount = application.amount_cents;
  const postedOutside = await paymentPostedOutside(q, { id: payment.id, qbo_id: payment.qbo_id });
  const asOf = localDateOf(ctx.now.toISOString(), ctx.timeZone);
  const finding = matchWrongInvoiceFinding(findPaymentOnWrongInvoice(await readReceivablesInput(q, asOf)), {
    paymentId,
    applicationId,
    fromInvoiceId,
    toInvoiceId,
  });
  return {
    ok: true,
    check: "payment_on_wrong_invoice",
    found: true,
    proposedCents: Number(p.amount_cents),
    applicationCents: amount,
    applicationOnFromInvoice: application.payment_id === paymentId && application.invoice_id === fromInvoiceId,
    postedOutside,
    findingMatches: finding !== null && finding.amountCents === amount,
    findingCents: finding?.amountCents ?? null,
    sources: finding ? refList(finding.sources, MAX_ENGINE_SOURCES) : [],
  };
}

// A money code: the rules engine as of now on the stored evidence (the load, the driver's arming,
// the receipt's reading or the voice note's amounts, the codes already asked for), and whether it
// allows exactly the proposed amount. Only categories and cents reach the pack.
const optionalId = (v: unknown): string | null | undefined =>
  v === undefined || v === null ? null : isUuid(v) ? v : undefined;

async function moneyCodeEngine(
  q: Queryable,
  ctx: GatewayContext,
  p: ProposalRow,
  raw: Record<string, unknown>,
): Promise<Engine> {
  const { driverId, loadId, purpose, source } = raw;
  const documentId = optionalId(raw.documentId);
  const voiceNoteId = optionalId(raw.voiceNoteId);
  if (
    p.subject_table !== "loads" ||
    loadId !== p.subject_id ||
    !isUuid(driverId) ||
    !isUuid(loadId) ||
    !(MONEY_CODE_PURPOSES as readonly unknown[]).includes(purpose) ||
    !(MONEY_CODE_SOURCES as readonly unknown[]).includes(source) ||
    documentId === undefined ||
    voiceNoteId === undefined
  ) {
    return UNAVAILABLE;
  }
  const amount = Number(p.amount_cents);
  const { capCents, perDriverPerDay } = flags.moneyCodes;
  const input = await readMoneyCodeInput(
    q,
    {
      driverId,
      loadId,
      purpose: purpose as MoneyCodePurpose,
      amountCents: amount,
      source: source as MoneyCodeSource,
      documentId,
      voiceNoteId,
      capCents,
      perDriverPerDay,
    },
    ctx.now.toISOString(),
  );
  const decision = checkMoneyCode(input);
  const base = { ok: true, check: "money_code", proposedCents: amount };
  if (!decision.ok) return { ...base, engine: { ok: false, reason: decision.category, refusals: decision.refusals } };
  return {
    ...base,
    engine: {
      ok: true,
      amountCents: decision.amountCents,
      matchesProposal: decision.amountCents === amount,
      reasons: decision.reasons,
    },
  };
}

// A Cash Friday card (factoring_request, bill_defer, collections_chase), checked the way the Cash
// page builds it: the engine runs on today's records (the bank position and factoring terms, the
// open week's pay run, the bills, every open invoice and its customer's history) and the card's
// stored args must equal, as a whole value, the args of the engine's option for the same kind and
// subject now. The figures reported are the engine's. A refusal carries its category.
async function cashEngine(q: Queryable, ctx: GatewayContext, p: ProposalRow, raw: Record<string, unknown>): Promise<Engine> {
  const input = await readCashFridayInput(q, ctx.timeZone, flags.cashFridayLimits);
  const asOf = localDateOf(ctx.now.toISOString(), ctx.timeZone);
  const result = computeCashFriday(input, asOf);
  const base = { ok: true, check: "cash_friday", proposedCents: Number(p.amount_cents) };
  if (!result.ok) return { ...base, engine: { ok: false, reason: result.refusal } };
  const option = result.options.find(
    (o) => o.kind === p.kind && o.subjectTable === p.subject_table && o.subjectId === p.subject_id,
  );
  const engine = {
    ok: true,
    payDay: result.payDay,
    gapCents: result.figures.gapCents,
    optionFound: option !== undefined,
  };
  if (!option) return { ...base, engine: { ...engine, matchesProposal: false } };
  const args = optionArgs(option, result.payDay, -result.figures.gapCents);
  return {
    ...base,
    engine: {
      ...engine,
      amountCents: option.amountCents,
      coversShort: option.kind === "collections_chase" ? null : option.coversShort,
      matchesProposal: option.amountCents === Number(p.amount_cents) && sameArgs(raw, args),
      sources: refList(option.sources, MAX_ENGINE_SOURCES),
    },
  };
}

// The engine's own number for the proposal. A read or engine error is unavailable, never zero.
async function engineFor(
  q: Queryable,
  ctx: GatewayContext,
  p: ProposalRow,
  args: Record<string, unknown>,
  raw: Record<string, unknown>,
): Promise<Engine> {
  try {
    const amount = Number(p.amount_cents);
    if (p.kind === "advance_payout") return await advanceEngine(q, ctx, p, amount, args);
    if (p.kind === "pay_correction") return await payCorrectionEngine(q, args);
    if (p.kind === "invoice_fix") return await invoiceEngine(q, p, args);
    if (p.kind === "load_rate_fill") return await rateFillEngine(q, ctx, p, args);
    // The card's lines are objects, which safeArgs leaves out; this check reads them as stored.
    if (p.kind === "invoice_post") return await invoicePostEngine(q, p, raw);
    if (p.kind === "payment_reapply") return await paymentReapplyEngine(q, ctx, p, args);
    if (p.kind === "detention_charge") return await detentionEngine(q, p);
    // A paystub card: the card against the stored draft, and the draft against a fresh engine run.
    if (p.kind === "settlement_approve") return await settlementEvidence(q, p, raw);
    // The cards' invoice lists are objects, which safeArgs leaves out; compared as stored.
    if (p.kind === "factoring_request" || p.kind === "bill_defer" || p.kind === "collections_chase") {
      return await cashEngine(q, ctx, p, raw);
    }
    if (p.kind === "pay_rule_change") return await ruleChangeEngine(q, ctx, p);
    // The stored evidence ids are read as stored; the engine runs again as of now.
    if (p.kind === "money_code") return await moneyCodeEngine(q, ctx, p, raw);
    return UNAVAILABLE;
  } catch {
    console.warn("gateway: the auditor's engine check could not be computed");
    return UNAVAILABLE;
  }
}

// The pack cut to fit: first the source figures go (their references stay), then the findings.
function fit(pack: { proposal: Record<string, unknown>; engine: Engine }, refs: Ref[]) {
  if (JSON.stringify(pack).length <= MAX_PACK_CHARS) return pack;
  const lean = { ...pack, proposal: { ...pack.proposal, sources: refList(refs, MAX_SOURCES) } };
  if (JSON.stringify(lean).length <= MAX_PACK_CHARS) return lean;
  const findings = Array.isArray(lean.engine.findings) ? lean.engine.findings.slice(0, 3) : undefined;
  return { ...lean, engine: findings ? { ...lean.engine, findings } : { ok: false, reason: "too_large" } };
}

export const getProposal = defineTool({
  name: "get_proposal",
  description:
    "Read one proposal and the evidence behind it: the proposal as stored (kind, subject, amount " +
    "in integer cents, reasons, the records it cites with their current figures, whether it came " +
    "from a flagged message) and the rules engine's own number for it.",
  tier: "read",
  roles: AUDITOR,
  label: "Reading the proposal and its evidence",
  args: z.strictObject({ proposalId: idField() }),
  refs: (a) => [{ table: "proposals", id: a.proposalId }],
  run: async (q, ctx, a) => {
    const [p] = await q.query<ProposalRow>(PROPOSAL_SQL, [a.proposalId]);
    if (!p) throw new Error("the proposal is not readable");
    const parsed = parseJson(p.args);
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const args = safeArgs(raw);
    const refs = refsOf(p.sources).slice(0, MAX_SOURCES);
    const sources: Record<string, unknown>[] = [];
    for (const ref of refs) sources.push(await sourceRow(q, ref));
    const proposal = {
      id: p.id,
      kind: p.kind,
      title: p.title,
      status: p.status,
      subject: {
        table: p.subject_table,
        id: p.subject_id,
        label: safeScalar(p.subject_label) ?? null,
      },
      amountCents: Number(p.amount_cents),
      direction: p.direction,
      operatorVerdict: CATEGORY.test(p.operator_verdict) ? p.operator_verdict : "not_given",
      reasons: categoriesOf(p.reasons),
      sources,
      args,
      exceptions: categoriesOf(p.exceptions),
      flagged: p.flagged === true,
      flagCategories: categoriesOf(p.flag_categories),
    };
    const engine = await engineFor(q, ctx, p, args, raw);
    return { result: fit({ proposal, engine }, refs) };
  },
});
