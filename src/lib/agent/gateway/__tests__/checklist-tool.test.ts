import { describe, expect, it } from "vitest";
import { callTool } from "../index";
import { ALWAYS_LOADED } from "../loading";
import { toolNamed, toolsFor } from "../registry";
import { context, fixedClock, FakeDb } from "./fake-db";

// set_checklist through the real gateway: it reads nothing and writes nothing (the loop keeps
// the list), it is logged like any tool with its free text redacted, and only the operator may
// call it.

const call = (args: unknown) => ({ id: "c", name: "set_checklist", argumentsJson: JSON.stringify(args) });

describe("set_checklist", () => {
  it("is always on, offered to the operator only, and never deferred behind search", () => {
    const tool = toolNamed("set_checklist");
    expect(tool).toMatchObject({ tier: "read", label: "Made a checklist", roles: ["operator"] });
    expect(tool?.enabled).toBeUndefined();
    expect(tool?.limit).toBeUndefined();
    expect(ALWAYS_LOADED).toContain("set_checklist");
    expect(toolsFor("operator", { defer: true }).find((t) => t.name === "set_checklist")).not.toHaveProperty("deferLoading");
    expect(toolsFor("auditor").map((t) => t.name)).not.toContain("set_checklist");
    expect(toolsFor("triage").map((t) => t.name)).not.toContain("set_checklist");
  });

  it("returns the list for the loop to keep, reads no table and logs the call with its text redacted", async () => {
    const db = new FakeDb({});
    const out = await callTool(
      context({ role: "operator" }),
      call({ items: [{ text: "Read Rosa's week", state: "doing" }, { text: "Check her pay" }] }),
      { db, clock: fixedClock },
    );
    expect(out).toMatchObject({
      decision: "allowed",
      tool: "set_checklist",
      result: { set: true, itemCount: 2 },
      checklist: { items: [{ text: "Read Rosa's week", state: "doing" }, { text: "Check her pay", state: "todo" }] },
    });
    expect(db.decisions).toHaveLength(1);
    expect(JSON.stringify(db.decisions[0].argsRedacted)).not.toContain("Rosa");
    expect(db.decisions[0].argsRedacted).toMatchObject({ items: [{ state: "doing" }, {}] });
  });

  it("refuses a list that breaks the shape, and the auditor's call to it", async () => {
    const db = new FakeDb({});
    const tooMany = { items: Array.from({ length: 13 }, (_, i) => ({ text: `Item number ${i}` })) };
    expect(await callTool(context({ role: "operator" }), call(tooMany), { db, clock: fixedClock })).toMatchObject({
      decision: "invalid_args",
    });
    expect(await callTool(context({ role: "operator" }), call({ items: [{ text: "x".repeat(81) }] }), { db, clock: fixedClock })).toMatchObject({
      decision: "invalid_args",
    });
    expect(await callTool(context({ role: "auditor" }), call({ items: [{ text: "Read it" }] }), { db, clock: fixedClock })).toMatchObject({
      decision: "denied",
    });
  });
});
