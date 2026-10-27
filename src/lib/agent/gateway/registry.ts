import { flags } from "../../../config/flags";
import type { AiTool } from "../../ai";
import { reportOfTool } from "../../reports/types";
import { enumValuesOf } from "./redact";
import { classifyMessage } from "./tools/triage/classify-message";
import { explainPaystub } from "./tools/read/explain-paystub";
import { findUnbilledDetentionTool } from "./tools/read/find-unbilled-detention";
import { getAdvanceHeadroom } from "./tools/read/get-advance-headroom";
import { getAdvances } from "./tools/read/get-advances";
import { getArAging } from "./tools/read/get-ar-aging";
import { getCustomerPayments } from "./tools/read/get-customer-payments";
import { getDocument } from "./tools/read/get-document";
import { getDriver } from "./tools/read/get-driver";
import { getDriverIdentity } from "./tools/read/get-driver-identity";
import { getInboundMessage } from "./tools/read/get-inbound-message";
import { getInvoiceQueue } from "./tools/read/get-invoice-queue";
import { getInvoiceReview } from "./tools/read/get-invoice-review";
import { getInvoiceReviewQueue } from "./tools/read/get-invoice-review-queue";
import { getInvoices } from "./tools/read/get-invoices";
import { getLedger } from "./tools/read/get-ledger";
import { getLoads } from "./tools/read/get-loads";
import { getMoneyCodes } from "./tools/read/get-money-codes";
import { getProposal } from "./tools/read/get-proposal";
import { ALWAYS_LOADED } from "./loading";
import { getSettlements } from "./tools/read/get-settlements";
import { getPayItems } from "./tools/read/get-pay-items";
import { getPaymentsIn } from "./tools/read/get-payments-in";
import { getPortalEvidence } from "./tools/read/get-portal-evidence";
import { getVoiceNote } from "./tools/read/get-voice-note";
import { reportAdvancesOutstanding } from "./tools/read/report-advances-outstanding";
import { reportArAging } from "./tools/read/report-ar-aging";
import { reportCashNeeded } from "./tools/read/report-cash-needed";
import { reportDriverPaySummary } from "./tools/read/report-driver-pay-summary";
import { reportMarginPerLoad } from "./tools/read/report-margin-per-load";
import { runChecks } from "./tools/read/run-checks";
import { proposeAdvance } from "./tools/propose/propose-advance";
import { proposeDetentionCharge } from "./tools/propose/propose-detention-charge";
import { proposeInvoiceFix } from "./tools/propose/propose-invoice-fix";
import { proposeLoadRate } from "./tools/propose/propose-load-rate";
import { proposeMoneyCode } from "./tools/propose/propose-money-code";
import { proposePayCorrection } from "./tools/propose/propose-pay-correction";
import { proposePaymentReapply } from "./tools/propose/propose-payment-reapply";
import { AGENT_ROLES, RESERVED_TOOL_NAMES, type AgentRole, type AnyToolDef } from "./types";
import { aiToolOf } from "./validate";

// Every tool a model can call, frozen. A name that is not a key here does not exist: there is no
// tool that moves money, and no tier that could hold one.

export const TOOL_NAME = /^[a-z_]{3,40}$/;

// Whether Meta's strict tool schemas are sent. Off: a probe on 10/26 sent propose_advance with
// strict on and Meta refused it (HTTP 400): strict needs every property listed in required, and
// an optional field is not. The same schema without strict came back as one tool call whose args
// passed the gateway's own parse. The gateway parses every call strictly either way.
export const STRICT_TOOL_SCHEMAS = false;

const TOOLS: readonly AnyToolDef[] = [
  getDriver,
  getLoads,
  getPayItems,
  getAdvances,
  getInvoices,
  getCustomerPayments,
  getLedger,
  explainPaystub,
  getSettlements,
  runChecks,
  reportArAging,
  reportDriverPaySummary,
  reportAdvancesOutstanding,
  reportCashNeeded,
  reportMarginPerLoad,
  getInboundMessage,
  getInvoiceQueue,
  getInvoiceReview,
  getInvoiceReviewQueue,
  getArAging,
  getPaymentsIn,
  getVoiceNote,
  getProposal,
  getDocument,
  findUnbilledDetentionTool,
  getDriverIdentity,
  getAdvanceHeadroom,
  proposeAdvance,
  proposePayCorrection,
  proposeInvoiceFix,
  proposePaymentReapply,
  proposeLoadRate,
  proposeDetentionCharge,
  // Offered only while flags.moneyCodes.enabled is on (each tool's enabled switch).
  getMoneyCodes,
  proposeMoneyCode,
  getPortalEvidence,
  classifyMessage,
];

function build(): Readonly<Record<string, AnyToolDef>> {
  const out: Record<string, AnyToolDef> = Object.create(null);
  for (const tool of TOOLS) {
    if (!TOOL_NAME.test(tool.name)) throw new Error("a tool name is not valid");
    if (out[tool.name]) throw new Error("two tools share a name");
    if ((RESERVED_TOOL_NAMES as readonly string[]).includes(tool.name)) {
      throw new Error("a tool takes a reserved name");
    }
    if (tool.tier === "propose" && !tool.limit) throw new Error("a propose tool needs a limit");
    out[tool.name] = Object.freeze({ ...tool, roles: Object.freeze([...tool.roles]) });
  }
  return Object.freeze(out);
}

export const TOOL_REGISTRY: Readonly<Record<string, AnyToolDef>> = build();

// The report tools exist only while their switch is on (flags.reportsEnabled, read on every call):
// off, they are not offered and a call to one is refused as an unknown tool.
function switchedOn(name: string): boolean {
  return reportOfTool(name) === null || flags.reportsEnabled;
}

export function toolNamed(name: string): AnyToolDef | null {
  return Object.hasOwn(TOOL_REGISTRY, name) && switchedOn(name) ? TOOL_REGISTRY[name] : null;
}

// What each role may be offered: JSON schemas made once from the same zod schemas the gateway
// parses, each kept beside its tool so a release switch is read on every offer.
type Offer = { tool: AnyToolDef; schema: AiTool };
const OFFERS: Readonly<Record<AgentRole, readonly Offer[]>> = Object.freeze(
  Object.fromEntries(
    AGENT_ROLES.map((role) => [
      role,
      Object.freeze(
        Object.values(TOOL_REGISTRY)
          .filter((t) => t.roles.includes(role))
          .map((t) => Object.freeze({ tool: t, schema: Object.freeze(aiToolOf(t)) })),
      ),
    ]),
  ) as Record<AgentRole, readonly Offer[]>,
);

// Whether a tool's release switch is on. A tool without one is always on; a switch that throws
// counts as off.
export function isToolEnabled(tool: AnyToolDef): boolean {
  if (!tool.enabled) return true;
  try {
    return tool.enabled() === true;
  } catch {
    return false;
  }
}

// Every always-loaded name must be a real tool the operator is offered, or deferral would hide a
// tool nobody can load. Checked once, when the registry loads.
for (const name of ALWAYS_LOADED) {
  if (!OFFERS.operator.some((o) => o.tool.name === name)) {
    throw new Error("an always-loaded tool is not offered to the operator");
  }
}

// What a role is offered, as a fresh list, leaving out a tool its switch keeps off. With defer,
// each tool ALWAYS_LOADED does not name is marked deferLoading (sent as a name and a description
// until the model searches for it); the names, schemas and order are the same either way.
export function toolsFor(role: AgentRole, options: { defer?: boolean } = {}): AiTool[] {
  if (!Object.hasOwn(OFFERS, role)) return [];
  const offered = OFFERS[role]
    .filter((o) => switchedOn(o.tool.name) && isToolEnabled(o.tool))
    .map((o) => o.schema);
  if (!options.defer) return offered;
  return offered.map((t) => (ALWAYS_LOADED.includes(t.name) ? t : { ...t, deferLoading: true }));
}

// Every enum value any tool schema declares: the only free strings the decision log keeps.
export const REDACT_ENUMS: ReadonlySet<string> = enumValuesOf(
  Object.values(OFFERS).flatMap((list) => list.map((o) => o.schema.parameters)),
);
