import type { AiTool } from "../../ai";
import { enumValuesOf } from "./redact";
import { classifyMessage } from "./tools/triage/classify-message";
import { explainPaystub } from "./tools/read/explain-paystub";
import { getAdvances } from "./tools/read/get-advances";
import { getCustomerPayments } from "./tools/read/get-customer-payments";
import { getDriver } from "./tools/read/get-driver";
import { getInboundMessage } from "./tools/read/get-inbound-message";
import { getInvoices } from "./tools/read/get-invoices";
import { getLedger } from "./tools/read/get-ledger";
import { getLoads } from "./tools/read/get-loads";
import { getProposal } from "./tools/read/get-proposal";
import { ALWAYS_LOADED } from "./loading";
import { getPayItems } from "./tools/read/get-pay-items";
import { runChecks } from "./tools/read/run-checks";
import { proposeAdvance } from "./tools/propose/propose-advance";
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
  proposeAdvance,
  proposePayCorrection,
  proposeInvoiceFix,
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

// What each role is offered: JSON schemas made once from the same zod schemas the gateway parses.
const OFFERED: Readonly<Record<AgentRole, readonly AiTool[]>> = Object.freeze(
  Object.fromEntries(
    AGENT_ROLES.map((role) => [
      role,
      Object.freeze(
        Object.values(TOOL_REGISTRY)
          .filter((t) => t.roles.includes(role))
          .map((t) => Object.freeze(aiToolOf(t))),
      ),
    ]),
  ) as Record<AgentRole, readonly AiTool[]>,
);

// Every always-loaded name must be a real tool the operator is offered, or deferral would hide a
// tool nobody can load. Checked once, when the registry loads.
for (const name of ALWAYS_LOADED) {
  if (!OFFERED.operator.some((t) => t.name === name)) {
    throw new Error("an always-loaded tool is not offered to the operator");
  }
}

// What a role is offered, as a fresh list. With defer, each tool ALWAYS_LOADED does not name is
// marked deferLoading (sent as a name and a description until the model searches for it); the
// names, schemas and order are the same either way.
export function toolsFor(role: AgentRole, options: { defer?: boolean } = {}): AiTool[] {
  if (!Object.hasOwn(OFFERED, role)) return [];
  if (!options.defer) return [...OFFERED[role]];
  return OFFERED[role].map((t) => (ALWAYS_LOADED.includes(t.name) ? t : { ...t, deferLoading: true }));
}

// Every enum value any tool schema declares: the only free strings the decision log keeps.
export const REDACT_ENUMS: ReadonlySet<string> = enumValuesOf(
  Object.values(OFFERED).flatMap((list) => list.map((t) => t.parameters)),
);
