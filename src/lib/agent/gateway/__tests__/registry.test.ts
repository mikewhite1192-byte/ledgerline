import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { ALWAYS_LOADED } from "../loading";
import { REDACT_ENUMS, STRICT_TOOL_SCHEMAS, TOOL_NAME, TOOL_REGISTRY, toolNamed, toolsFor } from "../registry";
import { AGENT_ROLES, RESERVED_TOOL_NAMES, TIERS, type AgentRole } from "../types";

const EXPECTED: Record<string, { tier: string; roles: AgentRole[] }> = {
  get_driver: { tier: "read", roles: ["operator", "auditor"] },
  get_loads: { tier: "read", roles: ["operator", "auditor"] },
  get_pay_items: { tier: "read", roles: ["operator", "auditor"] },
  get_advances: { tier: "read", roles: ["operator", "auditor"] },
  get_invoices: { tier: "read", roles: ["operator", "auditor"] },
  get_customer_payments: { tier: "read", roles: ["operator", "auditor"] },
  get_ledger: { tier: "read", roles: ["operator", "auditor"] },
  explain_paystub: { tier: "read", roles: ["operator"] },
  run_checks: { tier: "read", roles: ["operator", "auditor"] },
  get_inbound_message: { tier: "read", roles: ["operator", "triage"] },
  get_voice_note: { tier: "read", roles: ["operator"] },
  propose_advance: { tier: "propose", roles: ["operator"] },
  propose_pay_correction: { tier: "propose", roles: ["operator"] },
  propose_invoice_fix: { tier: "propose", roles: ["operator"] },
  classify_message: { tier: "read", roles: ["triage"] },
  report_ar_aging: { tier: "read", roles: ["operator"] },
  report_driver_pay_summary: { tier: "read", roles: ["operator"] },
  report_advances_outstanding: { tier: "read", roles: ["operator"] },
  report_cash_needed: { tier: "read", roles: ["operator"] },
  report_margin_per_load: { tier: "read", roles: ["operator"] },
  get_proposal: { tier: "read", roles: ["auditor"] },
  find_unbilled_detention: { tier: "read", roles: ["operator", "auditor"] },
  propose_detention_charge: { tier: "propose", roles: ["operator"] },
};

// The tools behind the detention switch: in the registry always, offered only while it is on.
const DETENTION_TOOLS = ["find_unbilled_detention", "propose_detention_charge"];
const REPORT_TOOLS = Object.keys(EXPECTED).filter((n) => n.startsWith("report_"));

afterEach(() => {
  flags.reportsEnabled = false;
  flags.detentionEnabled = false;
});

describe("tool registry", () => {
  afterEach(() => {
    flags.detentionEnabled = false;
  });

  it("holds exactly the designed tools, each with its tier and roles", () => {
    const actual = Object.fromEntries(
      Object.values(TOOL_REGISTRY).map((t) => [t.name, { tier: t.tier, roles: [...t.roles] }]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("names every tool by the name rule, from tiers that cannot move money", () => {
    for (const tool of Object.values(TOOL_REGISTRY)) {
      expect(tool.name).toMatch(TOOL_NAME);
      expect(TIERS).toContain(tool.tier);
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
    }
    expect(TIERS).toEqual(["read", "propose", "record"]);
  });

  it("gives every propose tool an engine limit", () => {
    const propose = Object.values(TOOL_REGISTRY).filter((t) => t.tier === "propose");
    expect(propose).toHaveLength(4);
    for (const tool of propose) expect(typeof tool.limit).toBe("function");
  });

  it("keeps reserved names out and finds nothing through prototype keys", () => {
    for (const name of RESERVED_TOOL_NAMES) expect(toolNamed(name)).toBeNull();
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
      expect(toolNamed(name)).toBeNull();
    }
    expect(Object.isFrozen(TOOL_REGISTRY)).toBe(true);
    expect(Object.isFrozen(TOOL_REGISTRY.get_driver)).toBe(true);
  });

  it("offers each role only its own tools, as copies", () => {
    const counts = Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]));
    expect(counts).toEqual({ operator: 14, auditor: 9, triage: 2 });
    const first = toolsFor("operator");
    first.pop();
    expect(toolsFor("operator")).toHaveLength(14);
    expect(toolsFor("nobody" as AgentRole)).toEqual([]);
  });

  it("offers the detention tools only while their switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    for (const role of AGENT_ROLES) for (const n of DETENTION_TOOLS) expect(names(role)).not.toContain(n);
    flags.detentionEnabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 16,
      auditor: 10,
      triage: 2,
    });
    expect(names("operator")).toEqual(expect.arrayContaining(DETENTION_TOOLS));
    expect(names("auditor")).toContain("find_unbilled_detention");
    expect(names("auditor")).not.toContain("propose_detention_charge");
    flags.detentionEnabled = false;
    expect(toolsFor("operator")).toHaveLength(14);
  });

  it("offers and finds the report tools only while their switch is on, read on every call", () => {
    expect(flags.reportsEnabled).toBe(false);
    for (const name of REPORT_TOOLS) expect(toolNamed(name), name).toBeNull();
    expect(toolsFor("operator").map((t) => t.name).filter((n) => n.startsWith("report_"))).toEqual([]);

    flags.reportsEnabled = true;
    expect(toolsFor("operator")).toHaveLength(19);
    expect(toolsFor("auditor")).toHaveLength(9);
    expect(toolsFor("triage")).toHaveLength(2);
    for (const name of REPORT_TOOLS) expect(toolNamed(name)?.tier, name).toBe("read");
    expect(toolsFor("operator").map((t) => t.name)).toEqual(expect.arrayContaining(REPORT_TOOLS));

    flags.reportsEnabled = false;
    for (const name of REPORT_TOOLS) expect(toolNamed(name), name).toBeNull();
    expect(toolsFor("operator")).toHaveLength(14);
  });

  it("serializes every schema as a closed JSON object schema with no tenant field", () => {
    flags.detentionEnabled = true;
    flags.reportsEnabled = true;
    // Both switches on: every registered tool is offered to each of its roles.
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 21,
      auditor: 10,
      triage: 2,
    });
    for (const role of AGENT_ROLES) {
      for (const tool of toolsFor(role)) {
        const params = tool.parameters as Record<string, unknown>;
        expect(JSON.parse(JSON.stringify(params))).toEqual(params);
        expect(params.type).toBe("object");
        expect(params.additionalProperties).toBe(false);
        expect(params).not.toHaveProperty("$schema");
        expect(JSON.stringify(params)).not.toMatch(/tenant/i);
      }
    }
  });

  it("sends schemas without strict, which Meta refuses for optional fields", () => {
    expect(STRICT_TOOL_SCHEMAS).toBe(false);
  });

  it("collects the schemas' enum values for the decision log, and only those", () => {
    expect(REDACT_ENUMS.has("driver_asked")).toBe(true);
    expect(REDACT_ENUMS.has("owed_to_driver")).toBe(true);
    expect(REDACT_ENUMS.has("drivers")).toBe(true);
    expect(REDACT_ENUMS.has("Please pay me")).toBe(false);
  });
});

describe("deferred loading for tool search", () => {
  it("defers every operator tool except the six always loaded, with the same names and schemas", () => {
    const plain = toolsFor("operator");
    const deferred = toolsFor("operator", { defer: true });
    expect(deferred.map((t) => t.name)).toEqual(plain.map((t) => t.name));
    deferred.forEach((t, i) => {
      expect(t.description).toBe(plain[i].description);
      expect(JSON.stringify(t.parameters)).toBe(JSON.stringify(plain[i].parameters));
    });
    expect(deferred.filter((t) => t.deferLoading !== true).map((t) => t.name).sort()).toEqual([...ALWAYS_LOADED].sort());
    expect(deferred.filter((t) => t.deferLoading === true).map((t) => t.name).sort()).toEqual(
      plain.map((t) => t.name).filter((n) => !ALWAYS_LOADED.includes(n)).sort(),
    );
    // A tool its switch keeps off is left out deferred too, not sent as a name to search for.
    for (const n of DETENTION_TOOLS) expect(deferred.map((t) => t.name), n).not.toContain(n);
    // Without defer, no tool carries the key at all, so today's request is unchanged.
    for (const t of plain) expect(t).not.toHaveProperty("deferLoading");
    for (const t of toolsFor("operator", { defer: false })) expect(t).not.toHaveProperty("deferLoading");
  });

  it("defers a tool added later, the report and detention tools included, unless the list names it", () => {
    flags.reportsEnabled = true;
    flags.detentionEnabled = true;
    const plain = toolsFor("operator");
    const deferred = toolsFor("operator", { defer: true });
    expect(deferred.map((t) => t.name)).toEqual(plain.map((t) => t.name));
    for (const name of [...REPORT_TOOLS, ...DETENTION_TOOLS]) {
      expect(ALWAYS_LOADED, name).not.toContain(name);
      expect(deferred.find((t) => t.name === name)?.deferLoading, name).toBe(true);
      // Off, each such tool is sent in full, with no deferLoading key.
      expect(plain.find((t) => t.name === name), name).not.toHaveProperty("deferLoading");
    }
    // The voice note read is needed only when a note is handed to the agent, so it is deferred
    // like get_inbound_message.
    expect(ALWAYS_LOADED).not.toContain("get_voice_note");
    expect(deferred.find((t) => t.name === "get_voice_note")?.deferLoading).toBe(true);
    expect(deferred.filter((t) => t.deferLoading !== true).map((t) => t.name).sort()).toEqual([...ALWAYS_LOADED].sort());
  });

  it("names only registered tools offered to the operator as always loaded, and nothing else", () => {
    expect(ALWAYS_LOADED).toEqual(["get_driver", "get_loads", "get_pay_items", "get_advances", "explain_paystub", "run_checks"]);
    expect(Object.isFrozen(ALWAYS_LOADED)).toBe(true);
    for (const name of ALWAYS_LOADED) {
      expect(toolNamed(name)?.roles, name).toContain("operator");
    }
  });

  it("reserves the hosted search's name, so no tool can take it", () => {
    expect(RESERVED_TOOL_NAMES).toContain("tool_search");
    expect(toolNamed("tool_search")).toBeNull();
    for (const role of AGENT_ROLES) {
      expect(toolsFor(role, { defer: true }).some((t) => t.name === "tool_search")).toBe(false);
    }
  });
});
