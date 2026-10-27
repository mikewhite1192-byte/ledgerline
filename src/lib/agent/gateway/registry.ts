import type { AiTool } from "../../ai";
import { enumValuesOf } from "./redact";
import { classifyMessage } from "./tools/triage/classify-message";
import { explainPaystub } from "./tools/read/explain-paystub";
import { findUnbilledDetentionTool } from "./tools/read/find-unbilled-detention";
import { getAdvances } from "./tools/read/get-advances";
import { getCustomerPayments } from "./tools/read/get-customer-payments";
import { getDriver } from "./tools/read/get-driver";
import { getInboundMessage } from "./tools/read/get-inbound-message";
import { getInvoices } from "./tools/read/get-invoices";
import { getLedger } from "./tools/read/get-ledger";
import { getLoads } from "./tools/read/get-loads";
import { getProposal } from "./tools/read/get-proposal";
import { getPayItems } from "./tools/read/get-pay-items";
import { runChecks } from "./tools/read/run-checks";
import { proposeAdvance } from "./tools/propose/propose-advance";
import { proposeDetentionCharge } from "./tools/propose/propose-detention-charge";
import { proposeInvoiceFix } from "./tools/propose/propose-invoice-fix";
import { proposePayCorrection } from "./tools/propose/propose-pay-correction";
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
  runChecks,
  getInboundMessage,
  getProposal,
  findUnbilledDetentionTool,
  proposeAdvance,
  proposePayCorrection,
  proposeInvoiceFix,
  proposeDetentionCharge,
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

export function toolNamed(name: string): AnyToolDef | null {
  return Object.hasOwn(TOOL_REGISTRY, name) ? TOOL_REGISTRY[name] : null;
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

export function toolsFor(role: AgentRole): AiTool[] {
  if (!Object.hasOwn(OFFERS, role)) return [];
  return OFFERS[role].filter((o) => isToolEnabled(o.tool)).map((o) => o.schema);
}

// Every enum value any tool schema declares: the only free strings the decision log keeps.
export const REDACT_ENUMS: ReadonlySet<string> = enumValuesOf(
  Object.values(OFFERS).flatMap((list) => list.map((o) => o.schema.parameters)),
);
