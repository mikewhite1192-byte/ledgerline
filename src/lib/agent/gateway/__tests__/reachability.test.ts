import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../../config/flags";
import { callTool } from "../index";
import { isToolEnabled, TOOL_REGISTRY, toolsFor } from "../registry";
import { AGENT_ROLES, RESERVED_TOOL_NAMES } from "../types";
import { aiToolOf, parseArgs } from "../validate";
import { context, fixedClock, FakeDb, TENANT } from "./fake-db";
import { blueRidgePlan } from "./plan-db";
import { sampleArgs } from "./sample-args";

// No path around the gateway, from the model's side: what a role is offered is exactly the
// registry's own schemas, and every name, role or argument outside them is refused and logged
// before anything is read.

const plan = blueRidgePlan();
const ARGS = sampleArgs(plan);
const TOOLS = Object.values(TOOL_REGISTRY);
const call = (name: string, args: unknown) => ({ id: "c", name, argumentsJson: JSON.stringify(args) });

// Every tool's switch on (detention, reports, invoicing, invoice review, customer payments and collections), so each test
// below reaches every registered tool. The detention switch's own cases are in detention-tools.test.ts; the last test here checks
// the report switch-off path.
beforeEach(() => {
  flags.detentionEnabled = true;
  flags.reportsEnabled = true;
  flags.invoicesEnabled = true;
  flags.invoiceReviewEnabled = true;
  flags.customerPaymentsEnabled = true;
  flags.collectionsEnabled = true;
});

afterEach(() => {
  flags.detentionEnabled = false;
  flags.reportsEnabled = false;
  flags.invoicesEnabled = false;
  flags.invoiceReviewEnabled = false;
  flags.customerPaymentsEnabled = false;
  flags.collectionsEnabled = false;
  vi.restoreAllMocks();
});

describe("reachability", () => {
  it.each([true, false])("(a) offers each role only registry tools, with the registry's own schemas (switch %s)", (on) => {
    flags.detentionEnabled = on;
    for (const role of AGENT_ROLES) {
      const offered = toolsFor(role);
      expect(offered.length, role).toBeGreaterThan(0);
      for (const tool of offered) {
        expect(Object.hasOwn(TOOL_REGISTRY, tool.name), tool.name).toBe(true);
        const def = TOOL_REGISTRY[tool.name];
        expect(def.roles, tool.name).toContain(role);
        expect(tool).toEqual(aiToolOf(def));
      }
      const names = offered.map((t) => t.name);
      expect(names).toEqual(
        TOOLS.filter((t) => t.roles.includes(role) && isToolEnabled(t)).map((t) => t.name),
      );
      for (const reserved of RESERVED_TOOL_NAMES) expect(names).not.toContain(reserved);
    }
    expect(toolsFor("admin" as never)).toEqual([]);
  });

  it("(a) hands out copies, so a caller cannot add a tool to what the next caller is offered", () => {
    const first = toolsFor("triage");
    first.push({ name: "pay_now", description: "", parameters: {} });
    expect(toolsFor("triage").map((t) => t.name)).not.toContain("pay_now");
  });

  it("(b) refuses and logs a name outside the registry, reserved names included", async () => {
    for (const name of ["pay_driver", "execute_payment", "constructor", "__proto__", ...RESERVED_TOOL_NAMES]) {
      const db = new FakeDb({});
      const out = await callTool(context(), call(name, {}), { db, clock: fixedClock });
      expect(out.decision, name).toBe("unknown_tool");
      expect(db.decisions, name).toHaveLength(1);
      expect(db.decisions[0], name).toMatchObject({ decision: "unknown_tool", tier: null });
    }
  });

  it("(c) refuses every tool to every role it is not given, and logs the refusal", async () => {
    let pairs = 0;
    for (const role of AGENT_ROLES) {
      for (const tool of TOOLS.filter((t) => !t.roles.includes(role))) {
        const db = new FakeDb({});
        const out = await callTool(context({ role }), call(tool.name, ARGS[tool.name]), { db, clock: fixedClock });
        expect(out, `${role} ${tool.name}`).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
        expect(db.decisions[0]).toMatchObject({ tool: tool.name, role, decision: "denied" });
        pairs += 1;
      }
    }
    expect(pairs).toBe(AGENT_ROLES.length * TOOLS.length - TOOLS.reduce((n, t) => n + t.roles.length, 0));
  });

  it("(d) refuses a tenantId in every tool's args, while the same args without it parse", async () => {
    for (const tool of TOOLS) {
      const args = ARGS[tool.name];
      expect(args, tool.name).toBeDefined();
      expect(parseArgs(tool.args, JSON.stringify(args)).ok, tool.name).toBe(true);
      const db = new FakeDb({});
      const role = tool.roles[0];
      const out = await callTool(context({ role }), call(tool.name, { ...args, tenantId: TENANT }), {
        db,
        clock: fixedClock,
      });
      expect(out, tool.name).toMatchObject({
        decision: "invalid_args",
        fieldErrors: [{ path: "(root)", code: "unrecognized_keys" }],
      });
      expect(db.decisions[0].argsRedacted, tool.name).toEqual({
        fieldErrors: [{ path: "(root)", code: "unrecognized_keys" }],
      });
    }
    expect(Object.keys(ARGS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("(e) with the report switch off, refuses and logs every report tool as unknown, for every role", async () => {
    flags.reportsEnabled = false;
    const reports = TOOLS.filter((t) => t.name.startsWith("report_"));
    expect(reports).toHaveLength(5);
    for (const role of AGENT_ROLES) {
      expect(toolsFor(role).map((t) => t.name).filter((n) => n.startsWith("report_")), role).toEqual([]);
      for (const tool of reports) {
        const db = new FakeDb({});
        const out = await callTool(context({ role }), call(tool.name, ARGS[tool.name]), { db, clock: fixedClock });
        expect(out, `${role} ${tool.name}`).toMatchObject({ decision: "unknown_tool", reason: "unknown_tool" });
        expect(db.decisions, tool.name).toHaveLength(1);
        // The membership check and the decision row only: no record is read.
        const read = db.statements.filter(
          (st) => !st.sql.includes("FROM memberships") && !st.sql.startsWith("INSERT INTO gateway_decisions"),
        );
        expect(read, tool.name).toEqual([]);
      }
    }
  });
});
