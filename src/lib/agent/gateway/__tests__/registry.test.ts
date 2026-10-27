import { describe, expect, it } from "vitest";
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
  propose_advance: { tier: "propose", roles: ["operator"] },
  propose_pay_correction: { tier: "propose", roles: ["operator"] },
  propose_invoice_fix: { tier: "propose", roles: ["operator"] },
  classify_message: { tier: "read", roles: ["triage"] },
  get_proposal: { tier: "read", roles: ["auditor"] },
};

describe("tool registry", () => {
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
    expect(propose).toHaveLength(3);
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
    expect(counts).toEqual({ operator: 13, auditor: 9, triage: 2 });
    const first = toolsFor("operator");
    first.pop();
    expect(toolsFor("operator")).toHaveLength(13);
    expect(toolsFor("nobody" as AgentRole)).toEqual([]);
  });

  it("serializes every schema as a closed JSON object schema with no tenant field", () => {
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
