import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { ALWAYS_LOADED } from "../loading";
import { isToolEnabled, REDACT_ENUMS, STRICT_TOOL_SCHEMAS, TOOL_NAME, TOOL_REGISTRY, toolNamed, toolsFor } from "../registry";
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
  get_settlements: { tier: "read", roles: ["operator"] },
  run_checks: { tier: "read", roles: ["operator", "auditor"] },
  get_inbound_message: { tier: "read", roles: ["operator", "triage"] },
  get_invoice_queue: { tier: "read", roles: ["operator"] },
  get_invoice_review: { tier: "read", roles: ["operator", "auditor"] },
  get_invoice_review_queue: { tier: "read", roles: ["operator", "auditor"] },
  get_ar_aging: { tier: "read", roles: ["operator"] },
  get_payments_in: { tier: "read", roles: ["operator"] },
  get_document: { tier: "read", roles: ["operator", "auditor"] },
  get_voice_note: { tier: "read", roles: ["operator"] },
  propose_advance: { tier: "propose", roles: ["operator"] },
  propose_pay_correction: { tier: "propose", roles: ["operator"] },
  propose_invoice_fix: { tier: "propose", roles: ["operator"] },
  propose_payment_reapply: { tier: "propose", roles: ["operator"] },
  get_portal_evidence: { tier: "read", roles: ["operator"] },
  propose_load_rate: { tier: "propose", roles: ["operator"] },
  classify_message: { tier: "read", roles: ["triage"] },
  report_ar_aging: { tier: "read", roles: ["operator"] },
  report_driver_pay_summary: { tier: "read", roles: ["operator"] },
  report_advances_outstanding: { tier: "read", roles: ["operator"] },
  report_cash_needed: { tier: "read", roles: ["operator"] },
  report_margin_per_load: { tier: "read", roles: ["operator"] },
  report_ifta_quarter: { tier: "read", roles: ["operator"] },
  report_year_end_contractors: { tier: "read", roles: ["operator", "auditor"] },
  report_trust_meter: { tier: "read", roles: ["operator"] },
  get_proposal: { tier: "read", roles: ["auditor"] },
  find_unbilled_detention: { tier: "read", roles: ["operator", "auditor"] },
  propose_detention_charge: { tier: "propose", roles: ["operator"] },
  get_driver_identity: { tier: "read", roles: ["operator", "auditor"] },
  get_advance_headroom: { tier: "read", roles: ["operator", "auditor"] },
  get_money_codes: { tier: "read", roles: ["operator", "auditor"] },
  propose_money_code: { tier: "propose", roles: ["operator"] },
  get_card_breaks: { tier: "read", roles: ["operator", "auditor"] },
  propose_card_match: { tier: "propose", roles: ["operator"] },
  get_cash_friday: { tier: "read", roles: ["operator"] },
  preview_rule_change: { tier: "read", roles: ["operator"] },
  propose_rule_change: { tier: "propose", roles: ["operator"] },
  get_collections: { tier: "read", roles: ["operator"] },
  get_profit_brief: { tier: "read", roles: ["operator"] },
  set_checklist: { tier: "read", roles: ["operator"] },
  remember_note: { tier: "record", roles: ["operator"] },
  get_factoring_packet: { tier: "read", roles: ["operator", "auditor"] },
  get_factoring_requests: { tier: "read", roles: ["operator", "auditor"] },
  propose_factoring: { tier: "propose", roles: ["operator"] },
  get_pinned_rates: { tier: "read", roles: ["operator", "auditor"] },
  get_quarter_review: { tier: "read", roles: ["operator"] },
  list_escrow_releases_due: { tier: "read", roles: ["operator", "auditor"] },
  get_escrow_statement: { tier: "read", roles: ["operator", "auditor"] },
  propose_escrow_release: { tier: "propose", roles: ["operator"] },
};

// The tools behind the factoring switch: in the registry always, offered only while it is on.
const FACTORING_TOOLS = ["get_factoring_packet", "get_factoring_requests", "propose_factoring"];
// The escrow release tools, behind their own switch: the reads for both, the card for the operator.
const ESCROW_TOOLS = ["list_escrow_releases_due", "get_escrow_statement", "propose_escrow_release"];

// The tools behind the detention switch: in the registry always, offered only while it is on.
const DETENTION_TOOLS = ["find_unbilled_detention", "propose_detention_charge"];
// The tools behind the money codes switch, likewise.
const MONEY_CODE_TOOLS = ["get_money_codes", "propose_money_code"];
// The IFTA quarter, year-end 1099 and trust meter reports also need their own switches, so they
// are kept apart from the other reports.
const IFTA_TOOL = "report_ifta_quarter";
const YEAR_END_TOOL = "report_year_end_contractors";
const TRUST_TOOL = "report_trust_meter";
const REPORT_TOOLS = Object.keys(EXPECTED).filter(
  (n) => n.startsWith("report_") && n !== IFTA_TOOL && n !== YEAR_END_TOOL && n !== TRUST_TOOL,
);
// The card check's tools, behind its switch.
const CARD_TOOLS = ["get_card_breaks", "propose_card_match"];
// The tools behind the invoicing and customer payments switches, likewise.
const INVOICE_TOOLS = ["get_invoice_queue"];
const PAYMENT_TOOLS = ["get_ar_aging", "get_payments_in", "propose_payment_reapply"];
// The pay rule change tools, behind their own switch: operator only.
const RULE_TOOLS = ["preview_rule_change", "propose_rule_change"];
// The invoice review tools need both the invoicing and the invoice review switches.
const REVIEW_TOOLS = ["get_invoice_review", "get_invoice_review_queue"];
// The collections read, behind its own switch.
const COLLECTIONS_TOOLS = ["get_collections"];

afterEach(() => {
  flags.reportsEnabled = false;
  flags.iftaEnabled = false;
  flags.yearEndEnabled = false;
  flags.trustMeterEnabled = false;
  flags.detentionEnabled = false;
  flags.moneyCodes.enabled = false;
  flags.cardRecon.enabled = false;
  flags.invoicesEnabled = false;
  flags.invoiceReviewEnabled = false;
  flags.customerPaymentsEnabled = false;
  flags.cashFridayEnabled = false;
  flags.rulesByTalkingEnabled = false;
  flags.collectionsEnabled = false;
  flags.profitBriefEnabled = false;
  flags.carrierMemoryEnabled = false;
  flags.factoring.enabled = false;
  flags.groundedRatesEnabled = false;
  flags.quarterReviewEnabled = false;
  flags.escrowRelease.enabled = false;
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
    expect(propose).toHaveLength(11);
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
    expect(counts).toEqual({ operator: 21, auditor: 12, triage: 2 });
    const first = toolsFor("operator");
    first.pop();
    expect(toolsFor("operator")).toHaveLength(21);
    expect(toolsFor("nobody" as AgentRole)).toEqual([]);
  });

  it("offers the detention tools only while their switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    for (const role of AGENT_ROLES) for (const n of DETENTION_TOOLS) expect(names(role)).not.toContain(n);
    flags.detentionEnabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 23,
      auditor: 13,
      triage: 2,
    });
    expect(names("operator")).toEqual(expect.arrayContaining(DETENTION_TOOLS));
    expect(names("auditor")).toContain("find_unbilled_detention");
    expect(names("auditor")).not.toContain("propose_detention_charge");
    flags.detentionEnabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers the money code tools only while their switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    for (const role of AGENT_ROLES) for (const n of MONEY_CODE_TOOLS) expect(names(role)).not.toContain(n);
    flags.moneyCodes.enabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 23,
      auditor: 13,
      triage: 2,
    });
    expect(names("operator")).toEqual(expect.arrayContaining(MONEY_CODE_TOOLS));
    expect(names("auditor")).toContain("get_money_codes");
    expect(names("auditor")).not.toContain("propose_money_code");
    expect(toolNamed("propose_money_code")?.limit).toBeTypeOf("function");
    flags.moneyCodes.enabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers the card check tools only while its switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    for (const role of AGENT_ROLES) for (const n of CARD_TOOLS) expect(names(role), `${role} ${n}`).not.toContain(n);
    flags.cardRecon.enabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 23,
      auditor: 13,
      triage: 2,
    });
    expect(names("operator")).toEqual(expect.arrayContaining(CARD_TOOLS));
    expect(names("auditor")).toContain("get_card_breaks");
    expect(names("auditor")).not.toContain("propose_card_match");
    for (const n of CARD_TOOLS) expect(names("triage"), n).not.toContain(n);
    flags.cardRecon.enabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers the invoice and customer payment tools only while their switches are on, read on every offer", () => {
    const names = () => toolsFor("operator").map((t) => t.name);
    for (const n of [...INVOICE_TOOLS, ...PAYMENT_TOOLS]) expect(names(), n).not.toContain(n);
    flags.invoicesEnabled = true;
    expect(names()).toEqual(expect.arrayContaining(INVOICE_TOOLS));
    for (const n of PAYMENT_TOOLS) expect(names(), n).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(22);
    flags.invoicesEnabled = false;
    flags.customerPaymentsEnabled = true;
    expect(names()).toEqual(expect.arrayContaining(PAYMENT_TOOLS));
    for (const n of INVOICE_TOOLS) expect(names(), n).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(24);
    flags.customerPaymentsEnabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
    // Neither is ever offered to the auditor or triage.
    flags.invoicesEnabled = true;
    flags.customerPaymentsEnabled = true;
    expect(toolsFor("auditor")).toHaveLength(12);
    expect(toolsFor("triage")).toHaveLength(2);
  });

  it("offers get_cash_friday to the operator only while the Cash Friday switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    expect(flags.cashFridayEnabled).toBe(false);
    for (const role of AGENT_ROLES) expect(names(role)).not.toContain("get_cash_friday");
    expect(toolsFor("operator")).toHaveLength(21);
    flags.cashFridayEnabled = true;
    expect(names("operator")).toContain("get_cash_friday");
    expect(toolsFor("operator")).toHaveLength(22);
    expect(names("auditor")).not.toContain("get_cash_friday");
    expect(toolsFor("operator", { defer: true }).find((t) => t.name === "get_cash_friday")?.deferLoading).toBe(true);
    flags.cashFridayEnabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers the pay rule change tools only to the operator and only while their switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    expect(flags.rulesByTalkingEnabled).toBe(false);
    // Off: the operator's list is today's, name for name, so the recorded demo path still matches.
    for (const role of AGENT_ROLES) for (const n of RULE_TOOLS) expect(names(role), n).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(21);
    flags.rulesByTalkingEnabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 23,
      auditor: 12,
      triage: 2,
    });
    expect(names("operator")).toEqual(expect.arrayContaining(RULE_TOOLS));
    for (const n of RULE_TOOLS) {
      expect(names("auditor"), n).not.toContain(n);
      expect(names("triage"), n).not.toContain(n);
    }
    flags.rulesByTalkingEnabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers the factoring tools only while the factoring switch is on, read on every offer, all deferred", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    // Off: the lists hold none of its tools.
    flags.factoring.enabled = false;
    for (const role of AGENT_ROLES) for (const n of FACTORING_TOOLS) expect(names(role), `${role} ${n}`).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(21);
    expect(toolsFor("auditor")).toHaveLength(12);
    flags.factoring.enabled = true;
    for (const n of FACTORING_TOOLS) expect(names("operator"), n).toContain(n);
    expect(names("auditor")).toEqual(expect.arrayContaining(["get_factoring_packet", "get_factoring_requests"]));
    expect(names("auditor")).not.toContain("propose_factoring");
    for (const n of FACTORING_TOOLS) expect(names("triage"), n).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(24);
    expect(toolsFor("auditor")).toHaveLength(14);
    for (const n of FACTORING_TOOLS) {
      expect(ALWAYS_LOADED, n).not.toContain(n);
      expect(toolsFor("operator", { defer: true }).find((t) => t.name === n)?.deferLoading, n).toBe(true);
    }
    flags.factoring.enabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
    expect(toolsFor("auditor")).toHaveLength(12);
  });

  it("offers the escrow release tools only while the escrow release switch is on, the card to the operator alone", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    // Off: the lists hold none of its tools.
    flags.escrowRelease.enabled = false;
    for (const role of AGENT_ROLES) for (const n of ESCROW_TOOLS) expect(names(role), `${role} ${n}`).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(21);
    expect(toolsFor("auditor")).toHaveLength(12);
    flags.escrowRelease.enabled = true;
    for (const n of ESCROW_TOOLS) expect(names("operator"), n).toContain(n);
    expect(names("auditor")).toEqual(expect.arrayContaining(["list_escrow_releases_due", "get_escrow_statement"]));
    expect(names("auditor")).not.toContain("propose_escrow_release");
    for (const n of ESCROW_TOOLS) expect(names("triage"), n).not.toContain(n);
    expect(toolsFor("operator")).toHaveLength(24);
    expect(toolsFor("auditor")).toHaveLength(14);
    expect(toolNamed("propose_escrow_release")?.limit).toBeTypeOf("function");
    flags.escrowRelease.enabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
    expect(toolsFor("auditor")).toHaveLength(12);
  });

  it("offers the invoice review tools to the operator and the auditor only while both switches are on", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    const none = (role: AgentRole) => {
      for (const n of REVIEW_TOOLS) expect(names(role), `${role} ${n}`).not.toContain(n);
    };
    none("operator");
    none("auditor");
    flags.invoiceReviewEnabled = true;
    // Review without invoicing is still off.
    none("operator");
    none("auditor");
    flags.invoicesEnabled = true;
    expect(names("operator")).toEqual(expect.arrayContaining(REVIEW_TOOLS));
    expect(names("auditor")).toEqual(expect.arrayContaining(REVIEW_TOOLS));
    for (const n of REVIEW_TOOLS) expect(names("triage"), n).not.toContain(n);
    flags.invoicesEnabled = false;
    none("operator");
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = false;
    none("operator");
    none("auditor");
  });

  it("offers the collections read to the operator only while its switch is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    expect(flags.collectionsEnabled).toBe(false);
    for (const role of AGENT_ROLES) for (const n of COLLECTIONS_TOOLS) expect(names(role), `${role} ${n}`).not.toContain(n);
    flags.collectionsEnabled = true;
    expect(names("operator")).toEqual(expect.arrayContaining(COLLECTIONS_TOOLS));
    expect(toolsFor("operator")).toHaveLength(22);
    expect(toolsFor("auditor")).toHaveLength(12);
    expect(toolsFor("triage")).toHaveLength(2);
    // Deferred like the other receivables reads: few questions need it.
    expect(ALWAYS_LOADED).not.toContain("get_collections");
    expect(toolsFor("operator", { defer: true }).find((t) => t.name === "get_collections")?.deferLoading).toBe(true);
    flags.collectionsEnabled = false;
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers and finds the report tools only while their switch is on, read on every call", () => {
    expect(flags.reportsEnabled).toBe(false);
    for (const name of REPORT_TOOLS) expect(toolNamed(name), name).toBeNull();
    expect(toolsFor("operator").map((t) => t.name).filter((n) => n.startsWith("report_"))).toEqual([]);

    flags.reportsEnabled = true;
    expect(toolsFor("operator")).toHaveLength(26);
    expect(toolsFor("auditor")).toHaveLength(12);
    expect(toolsFor("triage")).toHaveLength(2);
    for (const name of REPORT_TOOLS) expect(toolNamed(name)?.tier, name).toBe("read");
    expect(toolsFor("operator").map((t) => t.name)).toEqual(expect.arrayContaining(REPORT_TOOLS));

    flags.reportsEnabled = false;
    for (const name of REPORT_TOOLS) expect(toolNamed(name), name).toBeNull();
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("offers and finds the IFTA quarter report only while the reports and its own switch are both on", () => {
    const names = () => toolsFor("operator").map((t) => t.name);
    flags.iftaEnabled = false;
    flags.reportsEnabled = true;
    // Reports on, IFTA off: the five reports as before, and the IFTA tool neither offered nor found.
    expect(toolsFor("operator")).toHaveLength(26);
    expect(names()).not.toContain(IFTA_TOOL);
    expect(toolNamed(IFTA_TOOL)).toBeNull();
    expect(isToolEnabled(TOOL_REGISTRY[IFTA_TOOL])).toBe(false);

    flags.iftaEnabled = true;
    expect(toolsFor("operator")).toHaveLength(27);
    expect(names()).toContain(IFTA_TOOL);
    expect(toolNamed(IFTA_TOOL)?.tier).toBe("read");
    expect(toolNamed(IFTA_TOOL)?.roles).toEqual(["operator"]);
    expect(isToolEnabled(TOOL_REGISTRY[IFTA_TOOL])).toBe(true);
    for (const role of ["auditor", "triage"] as const) {
      expect(toolsFor(role).map((t) => t.name), role).not.toContain(IFTA_TOOL);
    }

    // The IFTA switch alone does not open it.
    flags.reportsEnabled = false;
    expect(names()).not.toContain(IFTA_TOOL);
    expect(toolNamed(IFTA_TOOL)).toBeNull();
    flags.iftaEnabled = false;
  });

  it("offers and finds the year-end 1099 report only while the reports and its own switch are both on", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    flags.yearEndEnabled = false;
    flags.reportsEnabled = true;
    // Reports on, year-end off: the reports as before, and the year-end tool neither offered nor found.
    expect(toolsFor("operator")).toHaveLength(26);
    expect(toolsFor("auditor")).toHaveLength(12);
    for (const role of AGENT_ROLES) expect(names(role), role).not.toContain(YEAR_END_TOOL);
    expect(toolNamed(YEAR_END_TOOL)).toBeNull();
    expect(isToolEnabled(TOOL_REGISTRY[YEAR_END_TOOL])).toBe(false);

    flags.yearEndEnabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 27,
      auditor: 13,
      triage: 2,
    });
    expect(names("operator")).toContain(YEAR_END_TOOL);
    expect(names("auditor")).toContain(YEAR_END_TOOL);
    expect(names("triage")).not.toContain(YEAR_END_TOOL);
    expect(toolNamed(YEAR_END_TOOL)?.tier).toBe("read");
    expect(toolNamed(YEAR_END_TOOL)?.roles).toEqual(["operator", "auditor"]);
    expect(isToolEnabled(TOOL_REGISTRY[YEAR_END_TOOL])).toBe(true);
    // Its switch does not open the IFTA quarter.
    expect(names("operator")).not.toContain(IFTA_TOOL);

    // The year-end switch alone does not open it.
    flags.reportsEnabled = false;
    for (const role of AGENT_ROLES) expect(names(role), role).not.toContain(YEAR_END_TOOL);
    expect(toolNamed(YEAR_END_TOOL)).toBeNull();
    flags.yearEndEnabled = false;
  });

  it("offers and finds the trust meter report only while the reports and its own switch are both on", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    flags.trustMeterEnabled = false;
    flags.reportsEnabled = true;
    // Reports on, trust meter off: the reports as before, and the tool neither offered nor found.
    expect(toolsFor("operator")).toHaveLength(26);
    for (const role of AGENT_ROLES) expect(names(role), role).not.toContain(TRUST_TOOL);
    expect(toolNamed(TRUST_TOOL)).toBeNull();
    expect(isToolEnabled(TOOL_REGISTRY[TRUST_TOOL])).toBe(false);
    // Another report's own switch does not open it.
    flags.iftaEnabled = true;
    flags.yearEndEnabled = true;
    for (const role of AGENT_ROLES) expect(names(role), role).not.toContain(TRUST_TOOL);
    flags.iftaEnabled = false;
    flags.yearEndEnabled = false;

    flags.trustMeterEnabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 27,
      auditor: 12,
      triage: 2,
    });
    expect(names("operator")).toContain(TRUST_TOOL);
    expect(names("auditor")).not.toContain(TRUST_TOOL);
    expect(names("triage")).not.toContain(TRUST_TOOL);
    expect(toolNamed(TRUST_TOOL)?.tier).toBe("read");
    expect(toolNamed(TRUST_TOOL)?.roles).toEqual(["operator"]);
    expect(isToolEnabled(TOOL_REGISTRY[TRUST_TOOL])).toBe(true);
    // Its switch opens neither the IFTA quarter nor the year-end 1099.
    expect(names("operator")).not.toContain(IFTA_TOOL);
    expect(names("operator")).not.toContain(YEAR_END_TOOL);

    // The trust meter switch alone does not open it.
    flags.reportsEnabled = false;
    for (const role of AGENT_ROLES) expect(names(role), role).not.toContain(TRUST_TOOL);
    expect(toolNamed(TRUST_TOOL)).toBeNull();
    flags.trustMeterEnabled = false;
  });

  it("offers the note suggestion tool to the operator only while carrier memory is on, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    expect(flags.carrierMemoryEnabled).toBe(false);
    // Off: the default operator list, and so the demo turn's tool names, are unchanged.
    for (const role of AGENT_ROLES) expect(names(role)).not.toContain("remember_note");
    expect(toolsFor("operator")).toHaveLength(21);
    flags.carrierMemoryEnabled = true;
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 22,
      auditor: 12,
      triage: 2,
    });
    expect(names("operator")).toContain("remember_note");
    expect(names("auditor")).not.toContain("remember_note");
    expect(toolNamed("remember_note")?.tier).toBe("record");
    flags.carrierMemoryEnabled = false;
    expect(names("operator")).not.toContain("remember_note");
    expect(toolsFor("operator")).toHaveLength(21);
  });

  it("serializes every schema as a closed JSON object schema with no tenant field", () => {
    flags.detentionEnabled = true;
    flags.reportsEnabled = true;
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = true;
    flags.customerPaymentsEnabled = true;
    flags.moneyCodes.enabled = true;
    flags.cardRecon.enabled = true;
    flags.rulesByTalkingEnabled = true;
    flags.collectionsEnabled = true;
    flags.profitBriefEnabled = true;
    flags.carrierMemoryEnabled = true;
    flags.factoring.enabled = true;
    flags.groundedRatesEnabled = true;
    flags.quarterReviewEnabled = true;
    flags.iftaEnabled = true;
    flags.yearEndEnabled = true;
    flags.trustMeterEnabled = true;
    // Every switch on: every registered tool is offered to each of its roles.
    expect(Object.fromEntries(AGENT_ROLES.map((r) => [r, toolsFor(r).length]))).toEqual({
      operator: 51,
      auditor: 21,
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
    for (const n of [...DETENTION_TOOLS, ...MONEY_CODE_TOOLS, ...FACTORING_TOOLS]) expect(deferred.map((t) => t.name), n).not.toContain(n);
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

  it("defers the invoice queue, review, receivables and payment tools, which few questions need", () => {
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = true;
    flags.customerPaymentsEnabled = true;
    const deferred = toolsFor("operator", { defer: true });
    for (const name of [...INVOICE_TOOLS, ...PAYMENT_TOOLS, ...REVIEW_TOOLS]) {
      expect(ALWAYS_LOADED, name).not.toContain(name);
      expect(deferred.find((t) => t.name === name)?.deferLoading, name).toBe(true);
    }
  });

  it("defers the pay rule change tools, which only a rule change needs", () => {
    flags.rulesByTalkingEnabled = true;
    const deferred = toolsFor("operator", { defer: true });
    for (const name of RULE_TOOLS) {
      expect(ALWAYS_LOADED, name).not.toContain(name);
      expect(deferred.find((t) => t.name === name)?.deferLoading, name).toBe(true);
      expect(toolsFor("operator").find((t) => t.name === name), name).not.toHaveProperty("deferLoading");
    }
    flags.rulesByTalkingEnabled = false;
    for (const name of RULE_TOOLS) {
      expect(toolsFor("operator", { defer: true }).map((t) => t.name), name).not.toContain(name);
    }
  });

  it("offers the profit brief read to the operator only while its switch is on, deferred, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    expect(flags.profitBriefEnabled).toBe(false);
    expect(names("operator")).not.toContain("get_profit_brief");
    expect(toolsFor("operator")).toHaveLength(21);
    flags.profitBriefEnabled = true;
    expect(names("operator")).toContain("get_profit_brief");
    expect(toolsFor("operator")).toHaveLength(22);
    for (const role of ["auditor", "triage"] as const) expect(names(role)).not.toContain("get_profit_brief");
    expect(ALWAYS_LOADED).not.toContain("get_profit_brief");
    expect(toolsFor("operator", { defer: true }).find((t) => t.name === "get_profit_brief")?.deferLoading).toBe(true);
    flags.profitBriefEnabled = false;
    expect(names("operator")).not.toContain("get_profit_brief");
  });

  it("defers the note suggestion tool, and leaves it out deferred too while its switch is off", () => {
    expect(ALWAYS_LOADED).not.toContain("remember_note");
    expect(toolsFor("operator", { defer: true }).map((t) => t.name)).not.toContain("remember_note");
    flags.carrierMemoryEnabled = true;
    expect(toolsFor("operator", { defer: true }).find((t) => t.name === "remember_note")?.deferLoading).toBe(true);
    expect(toolsFor("operator").find((t) => t.name === "remember_note")).not.toHaveProperty("deferLoading");
  });

  it("offers the quarter review read to the operator only while its switch is on, deferred, read on every offer", () => {
    const names = (role: AgentRole) => toolsFor(role).map((t) => t.name);
    flags.quarterReviewEnabled = false;
    // Off: the operator's list is unchanged.
    expect(names("operator")).not.toContain("get_quarter_review");
    expect(toolsFor("operator")).toHaveLength(21);
    expect(toolNamed("get_quarter_review")).not.toBeNull();
    flags.quarterReviewEnabled = true;
    expect(names("operator")).toContain("get_quarter_review");
    expect(toolsFor("operator")).toHaveLength(22);
    for (const role of ["auditor", "triage"] as const) expect(names(role)).not.toContain("get_quarter_review");
    expect(ALWAYS_LOADED).not.toContain("get_quarter_review");
    expect(toolsFor("operator", { defer: true }).find((t) => t.name === "get_quarter_review")?.deferLoading).toBe(true);
    flags.quarterReviewEnabled = false;
    expect(names("operator")).not.toContain("get_quarter_review");
  });

  it("defers the portal evidence tool, which few questions need", () => {
    expect(ALWAYS_LOADED).not.toContain("get_portal_evidence");
    const deferred = toolsFor("operator", { defer: true });
    expect(deferred.find((t) => t.name === "get_portal_evidence")?.deferLoading).toBe(true);
    expect(toolsFor("operator").find((t) => t.name === "get_portal_evidence")).not.toHaveProperty("deferLoading");
  });

  it("defers the document read and the rate fill proposal, which only paperwork questions need", () => {
    const deferred = toolsFor("operator", { defer: true });
    for (const name of ["get_document", "propose_load_rate"]) {
      expect(ALWAYS_LOADED, name).not.toContain(name);
      expect(deferred.find((t) => t.name === name)?.deferLoading, name).toBe(true);
      expect(toolsFor("operator").find((t) => t.name === name), name).not.toHaveProperty("deferLoading");
    }
  });

  it("names only registered tools offered to the operator as always loaded, and nothing else", () => {
    expect(ALWAYS_LOADED).toEqual([
      "get_driver",
      "get_loads",
      "get_pay_items",
      "get_advances",
      "explain_paystub",
      "run_checks",
      "set_checklist",
    ]);
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
