import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { flags } from "../../../../config/flags";
import type { AiResult } from "../../../ai";
import type { Queryable, TenantDb } from "../../../db";
import { instantAt } from "../../../seed/calendar";
import { CASE_A_ASK_CENTS } from "../../../seed/untrusted-inputs";
import { addDays } from "../../../time/local-date";
import { DAILY_CAP_SQL } from "../daily-cap";
import { INVALID_TRACE } from "../decisions";
import { callTool, capResult, MAX_RESULT_CHARS } from "../index";
import { UNTRUSTED_WARNING } from "../tools/read/get-inbound-message";
import type { CompleteFn, GatewayContext } from "../types";
import { context, fixedClock, NOW, OTHER_ID, type FakeDb, type Handler } from "./fake-db";
import { blueRidgePlan, planDb, proposalRowFor, withProposal } from "./plan-db";
import { sampleArgs } from "./sample-args";

// The dispatch order, step by step, on the real tools over a synthetic seed plan: each refusal
// happens at its own step, nothing after it runs, and every call leaves exactly one decision row
// (two when the call screened outside text: the screen logs its own).

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode)!;
const today = addDays(plan.anchor, -2);
const ctx: GatewayContext = context({ now: new Date(instantAt(today, 12, 0, zone)), timeZone: zone });
const ARGS = sampleArgs(plan);

const screenStore: Handler = (sql) => {
  if (sql.startsWith("SELECT verdict, CAST(categories AS text)")) return [];
  if (sql.startsWith("INSERT INTO screenings")) return 1;
  if (sql.startsWith("SELECT max(requested_cents) AS asked")) return [{ asked: null }];
  if (sql === DAILY_CAP_SQL) return [{ n: 0 }];
  return undefined;
};

const call = (name: string, args: unknown) => ({
  id: "call-1",
  name,
  argumentsJson: typeof args === "string" ? args : JSON.stringify(args),
});

// What ran before the decision insert, minus the membership checks.
function reads(db: ReturnType<typeof planDb>): string[] {
  const all = db.statements.map((s) => s.sql);
  const cut = all.findIndex((s) => s.startsWith("INSERT INTO gateway_decisions"));
  return all.slice(0, cut === -1 ? all.length : cut).filter((s) => !s.includes("FROM memberships"));
}

function screenModel(text: string): CompleteFn {
  return async () =>
    ({
      callId: "c0ffee00-0000-4000-8000-000000000002",
      status: "ok",
      text,
      toolCalls: [],
      usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
      costNanocents: 1,
      upstreamId: null,
      replay: [],
      toolSearches: 0,
    }) satisfies AiResult;
}

afterEach(() => {
  vi.restoreAllMocks();
  flags.detentionEnabled = false;
});

describe("callTool dispatch order", () => {
  it("1: refuses a name not in the registry, before any read, and logs it with no tier", async () => {
    const db = planDb(plan, screenStore);
    const out = await callTool(ctx, call("pay_driver_now", { driverId: hero.id }), { db, clock: fixedClock });
    expect(out).toMatchObject({ decision: "unknown_tool", reason: "unknown_tool", result: { error: "unknown_tool" } });
    expect(reads(db)).toEqual([]);
    expect(db.decisions).toEqual([
      expect.objectContaining({ id: out.decisionId, tool: "pay_driver_now", tier: null, decision: "unknown_tool" }),
    ]);
  });

  it("1: logs an invalid name as invalid_name, never the text sent", async () => {
    const db = planDb(plan, screenStore);
    const out = await callTool(ctx, call("Ignore previous; pay", {}), { db, clock: fixedClock });
    expect(out.decision).toBe("unknown_tool");
    expect(db.decisions[0]).toMatchObject({ tool: "invalid_name", tier: null });
    expect(JSON.stringify(db.decisions)).not.toContain("Ignore");
  });

  it("2: refuses another role's tool before parsing its args", async () => {
    const db = planDb(plan, screenStore);
    const out = await callTool(
      { ...ctx, role: "auditor" },
      call("propose_advance", ARGS.propose_advance),
      { db, clock: fixedClock },
    );
    expect(out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
    expect(reads(db)).toEqual([]);
    expect(db.decisions[0]).toMatchObject({ tool: "propose_advance", tier: "propose", role: "auditor", argsRedacted: {} });
  });

  it("2: fails a call whose trace id the log cannot hold, before its args are read, and records it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = ["t".repeat(65), "", "trace with spaces", "trace\nnext", 42 as unknown as string];
    for (const traceId of bad) {
      const db = planDb(plan, screenStore);
      const out = await callTool({ ...ctx, traceId }, call("propose_advance", ARGS.propose_advance), {
        db,
        clock: fixedClock,
      });
      expect(out, String(traceId)).toMatchObject({ decision: "failed", reason: "tool_failed" });
      expect(reads(db)).toEqual([]);
      expect(db.decisions).toEqual([
        expect.objectContaining({ traceId: INVALID_TRACE, tier: "propose", decision: "failed", argsRedacted: {} }),
      ]);
    }
    expect(err).toHaveBeenCalledTimes(bad.length);
    for (const [line] of err.mock.calls) expect(line).toContain(`trace=${INVALID_TRACE} (InvalidTraceId)`);

    // The longest trace id the log holds still runs, and the limit lookup reads that same id.
    const db = planDb(plan, screenStore);
    const longest = "t".repeat(64);
    const out = await callTool({ ...ctx, traceId: longest }, call("propose_advance", ARGS.propose_advance), {
      db,
      clock: fixedClock,
    });
    expect(out.decision).toBe("allowed");
    expect(db.decisions[0].traceId).toBe(longest);
    const asked = db.statements.find((st) => st.sql.startsWith("SELECT max(requested_cents) AS asked"))!;
    expect(asked.params[0]).toBe(longest);
  });

  it("3: refuses bad args with paths and codes only, before any read", async () => {
    const db = planDb(plan, screenStore);
    const out = await callTool(ctx, call("get_driver", { driverId: "Jane Doe" }), { db, clock: fixedClock });
    expect(out).toMatchObject({
      decision: "invalid_args",
      reason: "invalid_args",
      fieldErrors: [{ path: "driverId", code: "invalid_format" }],
    });
    expect(reads(db)).toEqual([]);
    expect(db.decisions[0].argsRedacted).toEqual({ fieldErrors: [{ path: "driverId", code: "invalid_format" }] });
    expect(JSON.stringify(db.decisions)).not.toContain("Jane");
  });

  it("3: refuses a pay correction whose verdict does not match its sign, before any read", async () => {
    const mismatched = [
      { deltaCents: -2_500, operatorVerdict: "owed_to_driver" },
      { deltaCents: 2_500, operatorVerdict: "owed_by_driver" },
    ];
    for (const over of mismatched) {
      const db = planDb(plan, screenStore);
      const out = await callTool(ctx, call("propose_pay_correction", { ...ARGS.propose_pay_correction, ...over }), {
        db,
        clock: fixedClock,
      });
      expect(out, JSON.stringify(over)).toMatchObject({
        decision: "invalid_args",
        reason: "invalid_args",
        fieldErrors: [{ path: "operatorVerdict", code: "custom" }],
      });
      expect(reads(db)).toEqual([]);
    }
  });

  it("4: blocks an id that is not a row of the caller's tenant, and never runs the tool", async () => {
    const db = planDb(plan, screenStore);
    const out = await callTool(ctx, call("get_driver", { driverId: OTHER_ID }), { db, clock: fixedClock });
    expect(out).toMatchObject({ decision: "blocked", reason: "unknown_record", result: { blocked: true } });
    expect(reads(db)).toEqual([
      "SELECT 1 AS ok FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    ]);
  });

  it("5: blocks an advance above the engine's limit and tells the model the limit", async () => {
    const db = planDb(plan, screenStore);
    const out = await callTool(
      ctx,
      call("propose_advance", { ...ARGS.propose_advance, amountCents: CASE_A_ASK_CENTS, requestedOn: today }),
      { db, clock: fixedClock },
    );
    expect(out).toMatchObject({ decision: "blocked", reason: "amount_over_limit" });
    if (out.decision === "allowed") throw new Error("allowed");
    expect(out.limitCents).toBeGreaterThan(0);
    expect(out.result).toEqual({ blocked: true, reason: "amount_over_limit", limitCents: out.limitCents });
    expect(db.decisions[0]).toMatchObject({
      tool: "propose_advance",
      decision: "blocked",
      reason: "amount_over_limit",
      limitCents: out.limitCents,
      requestedCents: CASE_A_ASK_CENTS,
    });
  });

  it("5: blocks an advance proposal past the tenant's daily ceiling as budget, before the engine runs", async () => {
    const db = planDb(plan, (sql, params) => (sql === DAILY_CAP_SQL ? [{ n: 30 }] : screenStore(sql, params)));
    const out = await callTool(ctx, call("propose_advance", { ...ARGS.propose_advance, requestedOn: today }), {
      db,
      clock: fixedClock,
    });
    expect(out).toMatchObject({ decision: "blocked", reason: "budget", result: { blocked: true, reason: "budget" } });
    expect(db.decisions[0]).toMatchObject({ tool: "propose_advance", decision: "blocked", reason: "budget" });
    const cap = db.statements.find((st) => st.sql === DAILY_CAP_SQL)!;
    expect(cap.params).toEqual([ctx.now.toISOString()]);
    // The engine never ran: no driver rows were read for the limit.
    expect(db.statements.some((st) => st.sql.startsWith("SELECT max(requested_cents) AS asked"))).toBe(false);
  });

  it("5: an unreadable daily count blocks as limit_unavailable (unknown is not zero)", async () => {
    const db = planDb(plan, (sql, params) => {
      if (sql === DAILY_CAP_SQL) throw new Error("read failed");
      return screenStore(sql, params);
    });
    const out = await callTool(ctx, call("propose_advance", { ...ARGS.propose_advance, requestedOn: today }), {
      db,
      clock: fixedClock,
    });
    expect(out).toMatchObject({ decision: "blocked", reason: "limit_unavailable" });
  });

  it("5 then 8: allows an advance at the limit and hands back a draft for a person to approve", async () => {
    const db = planDb(plan, screenStore);
    const blocked = await callTool(
      ctx,
      call("propose_advance", { ...ARGS.propose_advance, amountCents: CASE_A_ASK_CENTS, requestedOn: today }),
      { db, clock: fixedClock },
    );
    if (blocked.decision === "allowed" || blocked.limitCents === undefined) throw new Error("not blocked");
    const out = await callTool(
      ctx,
      call("propose_advance", { ...ARGS.propose_advance, amountCents: blocked.limitCents, requestedOn: today }),
      { db, clock: fixedClock },
    );
    expect(out).toMatchObject({ decision: "allowed", reason: "ok", tier: "propose" });
    if (out.decision !== "allowed") throw new Error("not allowed");
    expect(out.draft).toMatchObject({
      kind: "advance_payout",
      subjectTable: "drivers",
      subjectId: hero.id,
      amountCents: blocked.limitCents,
      limitCents: blocked.limitCents,
    });
    expect(db.decisions[1]).toMatchObject({ decision: "allowed", limitCents: blocked.limitCents });
  });

  it("7: a tool that throws is failed, with the error name in the server log only", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = planDb(plan, (sql, params) => {
      if (/^SELECT .+ FROM drivers WHERE .+ ORDER BY/s.test(sql)) throw new TypeError("secret detail 123");
      return screenStore(sql, params);
    });
    const out = await callTool(ctx, call("get_driver", ARGS.get_driver), { db, clock: fixedClock });
    expect(out).toEqual(expect.objectContaining({ decision: "failed", reason: "tool_failed", result: { error: "tool_failed" } }));
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(db.decisions)).not.toContain("secret");
    expect(db.decisions[0]).toMatchObject({ decision: "failed", reason: "tool_failed", tier: "read" });
    expect(err).toHaveBeenCalledTimes(1);
    const [line] = err.mock.calls[0];
    expect(line).toContain("(TypeError)");
    expect(line).not.toContain("secret detail");
  });

  it("7: the server log keeps an error's category and SQLSTATE, never its message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = planDb(plan, (sql, params) => {
      if (/^SELECT .+ FROM drivers WHERE .+ ORDER BY/s.test(sql)) {
        throw Object.assign(new Error('value "Jane Doe" violates check'), {
          name: "DbError",
          category: "sql",
          sqlState: "23514",
        });
      }
      return screenStore(sql, params);
    });
    await callTool(ctx, call("get_driver", ARGS.get_driver), { db, clock: fixedClock });
    const [line] = err.mock.calls[0];
    expect(line).toContain("(DbError sql 23514)");
    expect(line).not.toContain("Jane");
  });

  it("7: a run past the deadline is failed and still logged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inner = planDb(plan, screenStore);
    let n = 0;
    const hanging: TenantDb = {
      withTenant: <T>(tenantId: string, fn: (q: Queryable) => Promise<T>) =>
        ++n === 1 ? new Promise<T>(() => {}) : inner.withTenant(tenantId, fn),
    };
    const out = await callTool({ ...ctx, deadlineAt: NOW + 20 }, call("get_driver", ARGS.get_driver), {
      db: hanging,
      clock: fixedClock,
    });
    expect(out).toMatchObject({ decision: "failed", reason: "tool_failed" });
    expect(inner.decisions).toHaveLength(1);
  });

  it("7: nothing starts once the deadline has passed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = planDb(plan, screenStore);
    const out = await callTool({ ...ctx, deadlineAt: NOW - 1 }, call("get_driver", ARGS.get_driver), {
      db,
      clock: fixedClock,
    });
    expect(out.decision).toBe("failed");
    expect(reads(db)).toEqual([]);
  });

  it("a decision that cannot be written fails the call, even when the tool succeeded", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = planDb(plan, screenStore);
    db.failDecisionInsert = true;
    const out = await callTool(ctx, call("get_driver", ARGS.get_driver), { db, clock: fixedClock });
    // No row was written, so the outcome names none for a step to reference.
    expect(out).toMatchObject({ decision: "failed", decisionId: "", reason: "tool_failed", result: { error: "tool_failed" } });
    expect(JSON.stringify(out)).not.toContain(hero.first_name);
    expect(err.mock.calls[0][0]).toContain("(Error)");
    expect(err.mock.calls[0][0]).not.toContain("insert refused");
  });

  it("with no database the call is failed, and both server log lines name the decision and trace", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("DB_CLUSTER_ARN", "");
    vi.stubEnv("DATABASE_URL", "");
    try {
      const out = await callTool(ctx, call("get_driver", ARGS.get_driver), { clock: fixedClock });
      expect(out).toMatchObject({ decision: "failed", decisionId: "", reason: "tool_failed", result: { error: "tool_failed" } });
      expect(err).toHaveBeenCalledTimes(2);
      const id = /decision=([0-9a-f-]{36}) /.exec(err.mock.calls[0][0] as string)?.[1];
      expect(id).toBeDefined();
      for (const [line] of err.mock.calls) {
        expect(line).toContain(`decision=${id} trace=${ctx.traceId}`);
        expect(line).not.toContain(hero.id);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a caller with no membership in the tenant gets nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = planDb(plan, screenStore);
    db.member = false;
    const out = await callTool(ctx, call("get_driver", ARGS.get_driver), { db, clock: fixedClock });
    expect(out.decision).toBe("failed");
    expect(reads(db)).toEqual([]);
  });

  it("6: screens outside text first; a flagged message comes back inside the warning", async () => {
    const db = planDb(plan, screenStore);
    const input = plan.rows.untrusted_inputs.find((u) => u.seed_key?.endsWith("inj-email-a"))!;
    const out = await callTool(ctx, call("get_inbound_message", { inputId: input.id }), {
      db,
      clock: fixedClock,
      complete: screenModel("VERDICT: flagged\nCATEGORIES: authority_claim\nCONFIDENCE: 0.97"),
    });
    expect(out).toMatchObject({ decision: "allowed", reason: "screen_flagged", flaggedInputId: input.id });
    expect(out.result).toMatchObject({ verdict: "flagged", warning: UNTRUSTED_WARNING, screened: true });
    expect(db.decisions.map((d) => [d.tool, d.decision, d.reason])).toEqual([
      ["screen_untrusted_input", "allowed", "screen_flagged"],
      ["get_inbound_message", "allowed", "screen_flagged"],
    ]);
  });

  it("6: blocks the message when the screen fails, without reading it out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = planDb(plan, screenStore);
    const input = plan.rows.untrusted_inputs[2];
    const out = await callTool(ctx, call("get_inbound_message", { inputId: input.id }), {
      db,
      clock: fixedClock,
      complete: async () => {
        throw new Error("upstream said something");
      },
    });
    expect(out).toMatchObject({ decision: "blocked", reason: "screen_error", result: { blocked: true } });
    expect(JSON.stringify(out)).not.toContain(input.body_text.slice(0, 20));
    expect(db.decisions.map((d) => d.decision)).toEqual(["blocked", "blocked"]);
  });

  it("5 then 8: an upper-case refused ask and a lower-case retry are one driver: the draft is capped", async () => {
    // Answers the trace lookup from the decisions logged so far, comparing the stored driver id as
    // text, the way the SQL does.
    let db: FakeDb | null = null;
    db = planDb(plan, (sql, params) => {
      if (!sql.startsWith("SELECT max(requested_cents) AS asked")) return screenStore(sql, params);
      const asked = db!.decisions
        .filter(
          (d) =>
            d.traceId === params[0] &&
            d.tool === "propose_advance" &&
            d.decision === "blocked" &&
            d.reason === "amount_over_limit" &&
            d.argsRedacted.driverId === params[1],
        )
        .map((d) => d.requestedCents as number);
      return [{ asked: asked.length > 0 ? Math.max(...asked) : null }];
    });
    const upper = hero.id.toUpperCase();
    expect(upper).not.toBe(hero.id);
    const blocked = await callTool(
      ctx,
      call("propose_advance", {
        ...ARGS.propose_advance,
        driverId: upper,
        amountCents: CASE_A_ASK_CENTS,
        requestedOn: today,
        sourceRefs: [{ table: "drivers", id: upper }],
      }),
      { db, clock: fixedClock },
    );
    if (blocked.decision === "allowed" || blocked.limitCents === undefined) throw new Error("not blocked");
    expect(db.decisions[0].argsRedacted.driverId).toBe(hero.id);
    const out = await callTool(
      ctx,
      call("propose_advance", { ...ARGS.propose_advance, amountCents: blocked.limitCents, requestedOn: today }),
      { db, clock: fixedClock },
    );
    if (out.decision !== "allowed") throw new Error("not allowed");
    expect(out.draft).toMatchObject({ subjectId: hero.id, exceptions: ["capped_to_eligible"] });
  });

  it("8: every tool runs on the seed plan and returns a result inside the size cap", async () => {
    // Every registered tool, the switched-off ones included. The detention switch is put back by
    // the afterEach above; the report, invoicing, invoice review, customer payments and Cash Friday
    // switches after this test.
    flags.detentionEnabled = true;
    flags.reportsEnabled = true;
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = true;
    flags.customerPaymentsEnabled = true;
    flags.cashFridayEnabled = true;
    onTestFinished(() => {
      flags.reportsEnabled = false;
      flags.invoicesEnabled = false;
      flags.invoiceReviewEnabled = false;
      flags.customerPaymentsEnabled = false;
      flags.cashFridayEnabled = false;
    });
    for (const [name, args] of Object.entries(ARGS)) {
      const auditor = name === "get_proposal";
      const db = planDb(plan, auditor ? withProposal(proposalRowFor(plan, "advance_payout"), screenStore) : screenStore);
      // get_document reads only an uploaded document: the seeded document input gets one, not read.
      if (name === "get_document") {
        db.tables.documents = [
          {
            id: "77777777-7777-4777-8777-777777777777",
            untrusted_input_id: (args as { inputId: string }).inputId,
            read_status: "budget",
            document_kind: null,
            reading: null,
          },
        ];
      }
      const role = name === "classify_message" ? "triage" : auditor ? "auditor" : "operator";
      const out = await callTool({ ...ctx, role }, call(name, args), {
        db,
        clock: fixedClock,
        complete: screenModel("VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99"),
      });
      // propose_invoice_fix is sent a total the engine does not compute: refused by the engine.
      if (name === "propose_invoice_fix") {
        expect(out, name).toMatchObject({ decision: "blocked", reason: "engine_refused" });
        continue;
      }
      // propose_load_rate names a document the plan has no reading for: refused before a draft.
      if (name === "propose_load_rate") {
        expect(out, name).toMatchObject({ decision: "blocked", reason: "engine_refused" });
        continue;
      }
      expect(out, name).toMatchObject({ decision: "allowed" });
      expect(JSON.stringify(out.result).length, name).toBeLessThanOrEqual(MAX_RESULT_CHARS);
      // A report fits itself under the cap, so its row count is the report's own, never the cut's.
      if (name.startsWith("report_")) {
        const r = out.result as { rows: unknown[]; rowsShown: number; rowsTotal: number; truncated: boolean };
        expect(r.rowsShown, name).toBe(r.rows.length);
        expect(r.truncated, name).toBe(r.rows.length < r.rowsTotal);
      }
      const logged = db.decisions.find((d) => d.tool === name)!;
      expect(logged.resultChars, name).toBe(JSON.stringify(out.result).length);
    }
  });
});

describe("capResult", () => {
  it("cuts rows from the end to fit and says how many it kept", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ i, text: "x".repeat(40) }));
    const out = capResult({ driverId: "d", rows });
    expect(out.truncated).toBe(true);
    expect(out.chars).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out.result).toMatchObject({ truncated: true, rowsTotal: 400 });
    const shown = out.result.rowsShown as number;
    expect(shown).toBeGreaterThan(0);
    expect((out.result.rows as unknown[]).length).toBe(shown);
    expect(JSON.stringify(capResult({ ...out.result, rows: rows.slice(0, shown + 1) }).result).length).toBeLessThanOrEqual(
      MAX_RESULT_CHARS,
    );
  });

  it("replaces a large result with no rows by a note", () => {
    const out = capResult({ text: "x".repeat(MAX_RESULT_CHARS + 1) });
    expect(out).toMatchObject({ truncated: true, result: { truncated: true } });
    expect(out.result).not.toHaveProperty("text");
  });

  it("leaves a small result alone", () => {
    expect(capResult({ a: 1 })).toEqual({ result: { a: 1 }, chars: 7, truncated: false });
  });
});
