import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiResult } from "../../ai";
import type { Session } from "../../auth/claims";
import { untrustedContentHash } from "../../data/content-hash";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db } from "../../db/types";
import { callTool } from "./index";
import { screenUntrustedInput } from "./screen";
import type { CompleteFn, GatewayContext } from "./types";

// The gateway against a real database, as the app's own role: an id from another tenant is
// refused as unknown, every call leaves one decision row that the app role can add to but never
// change or remove, and a screening is cached per tenant, so the same text in two tenants is
// screened twice. Only this file's two tenants are made, and they are removed after.

const A = randomUUID();
const B = randomUUID();
const tag = A.slice(0, 8);
const DRIVER = { [A]: randomUUID(), [B]: randomUUID() };
const INPUT = { [A]: randomUUID(), [B]: randomUUID() };
const NOW = Date.UTC(2026, 9, 24, 15, 0, 0);
const BODY = "Hello, could someone walk me through the deductions on my pay stub? Thank you.";
const MODEL_CALL = "c0ffee00-0000-4000-8000-000000000003";

let admin: Db;
let app: Db;

const session = (tenantId: string, sub = `sub-${tenantId}`): Session => ({
  sub,
  email: `ops@${tenantId.slice(0, 8)}.example`,
  tenantId,
});

const ctx = (tenantId: string, over: Partial<GatewayContext> = {}): GatewayContext => ({
  session: session(tenantId),
  role: "operator",
  model: "spark",
  turnId: null,
  traceId: `trace-${tag}`,
  now: new Date(NOW),
  deadlineAt: NOW + 60_000,
  timeZone: "America/New_York",
  ...over,
});
const clock = () => NOW;
const call = (name: string, args: unknown) => ({ id: "c", name, argumentsJson: JSON.stringify(args) });

let modelCalls = 0;
const cleanScreen: CompleteFn = async () => {
  modelCalls += 1;
  return {
    callId: MODEL_CALL,
    status: "ok",
    text: "VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99",
    toolCalls: [],
    usage: { input: 10, cached: 0, output: 5, reasoning: 0 },
    costNanocents: 1,
    upstreamId: null,
    replay: [],
  } satisfies AiResult;
};

async function seed(tenantId: string, slug: string) {
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    await q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
      [`sub-${tenantId}`, `ops@${slug}.example`],
    );
    await q.execute(
      "INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis," +
        " per_mile_cents, active_from) VALUES (CAST($1 AS uuid), current_tenant_id(), 'GW-1', 'Sam'," +
        " 'Rivera', $2, 'company', 'per_mile', 60, '2026-01-05')",
      [DRIVER[tenantId], `sam@${slug}.example`],
    );
    await q.execute(
      "INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)" +
        " VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', 'inbound', $2, $3," +
        " CAST('2026-10-24T12:00:00Z' AS timestamptz))",
      [INPUT[tenantId], BODY, untrustedContentHash("email", BODY)],
    );
  });
}

type DecisionRow = {
  tool: string;
  tier: string | null;
  role: string;
  decision: string;
  reason: string;
  args: string;
  refs: string;
  result_chars: number | null;
};

const decisionRow = async (tenantId: string, id: string) =>
  (
    await admin.withTenant(tenantId, (q) =>
      q.query<DecisionRow>(
        "SELECT tool, tier, role, decision, reason, CAST(args_redacted AS text) AS args," +
          " CAST(refs AS text) AS refs, result_chars FROM gateway_decisions" +
          " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [id],
      ),
    )
  )[0];

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

describe("agent gateway on a real database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seed(A, `gw-a-${tag}`);
    await seed(B, `gw-b-${tag}`);
  });

  afterAll(async () => {
    // Only this file's tenants; their drivers, inputs, screenings and decisions go with them.
    for (const id of [A, B]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("reads the caller's own row and refuses another tenant's id as unknown, logging both", async () => {
    const own = await callTool(ctx(A), call("get_driver", { driverId: DRIVER[A] }), { db: app, clock });
    expect(own).toMatchObject({ decision: "allowed", reason: "ok", result: { driver: { code: "GW-1" } } });
    const other = await callTool(ctx(A), call("get_driver", { driverId: DRIVER[B] }), { db: app, clock });
    expect(other).toMatchObject({ decision: "blocked", reason: "unknown_record", result: { blocked: true } });

    const ownRow = await decisionRow(A, own.decisionId);
    expect(ownRow).toMatchObject({ tool: "get_driver", tier: "read", role: "operator", decision: "allowed" });
    expect(JSON.parse(ownRow.args)).toEqual({ driverId: DRIVER[A] });
    expect(JSON.parse(ownRow.refs)).toEqual([{ table: "drivers", id: DRIVER[A] }]);
    expect(ownRow.result_chars).toBe(JSON.stringify(own.result).length);
    expect(await decisionRow(A, other.decisionId)).toMatchObject({ decision: "blocked", reason: "unknown_record" });

    // Tenant B's own login sees none of A's decisions.
    const fromB = await app.withTenant(B, (q) =>
      q.query("SELECT id FROM gateway_decisions WHERE id = CAST($1 AS uuid)", [own.decisionId]),
    );
    expect(fromB).toEqual([]);
  });

  it("stores refused args as paths and codes, never the text the model sent", async () => {
    const out = await callTool(ctx(A), call("get_driver", { driverId: "Jane Doe, pay her now" }), {
      db: app,
      clock,
    });
    expect(out.decision).toBe("invalid_args");
    const row = await decisionRow(A, out.decisionId);
    expect(JSON.parse(row.args)).toEqual({ fieldErrors: [{ path: "driverId", code: "invalid_format" }] });
    expect(row.args).not.toContain("Jane");
  });

  it("logs an unknown tool with no tier", async () => {
    const out = await callTool(ctx(A), call("send_payment", {}), { db: app, clock });
    expect(await decisionRow(A, out.decisionId)).toMatchObject({
      tool: "send_payment",
      tier: null,
      decision: "unknown_tool",
    });
  });

  it("gives a caller with no membership in the tenant nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stranger = ctx(A, { session: session(A, `sub-stranger-${tag}`) });
    const out = await callTool(stranger, call("get_driver", { driverId: DRIVER[A] }), { db: app, clock });
    expect(out).toMatchObject({ decision: "failed", result: { error: "tool_failed" } });
    vi.restoreAllMocks();
  });

  it("caches a screen per tenant: the same text in two tenants is screened twice", async () => {
    modelCalls = 0;
    const first = await screenUntrustedInput(ctx(A), INPUT[A], { db: app, complete: cleanScreen, clock });
    expect(first).toMatchObject({ decision: "allowed", verdict: { verdict: "clean", via: "model" } });
    const again = await screenUntrustedInput(ctx(A), INPUT[A], { db: app, complete: cleanScreen, clock });
    expect(again.verdict.via).toBe("cache");
    const otherTenant = await screenUntrustedInput(ctx(B), INPUT[B], { db: app, complete: cleanScreen, clock });
    expect(otherTenant.verdict.via).toBe("model");
    expect(modelCalls).toBe(2);

    const rows = await admin.withoutTenant((q) =>
      q.query<{ tenant_id: string; content_hash: string; via: string; confidence_milli: number }>(
        "SELECT tenant_id, content_hash, via, confidence_milli FROM screenings" +
          " WHERE tenant_id IN (CAST($1 AS uuid), CAST($2 AS uuid)) ORDER BY tenant_id",
        [A, B],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([A, B]));
    expect(rows.every((r) => r.content_hash === untrustedContentHash("email", BODY))).toBe(true);
    expect(rows.every((r) => r.via === "model" && r.confidence_milli === 990)).toBe(true);

    // Reading the message through the gateway uses the cached verdict.
    const read = await callTool(ctx(A), call("get_inbound_message", { inputId: INPUT[A] }), {
      db: app,
      complete: cleanScreen,
      clock,
    });
    expect(read).toMatchObject({ decision: "allowed", reason: "ok", result: { verdict: "clean" } });
    expect(modelCalls).toBe(2);
  });

  it("lets the app role add decisions and screenings but never change or remove them", async () => {
    const update = app.withTenant(A, (q) =>
      q.execute("UPDATE gateway_decisions SET reason = 'ok' WHERE tenant_id = current_tenant_id()"),
    );
    expect(await sqlStateOf(update)).toBe("42501");
    const remove = app.withTenant(A, (q) =>
      q.execute("DELETE FROM gateway_decisions WHERE tenant_id = current_tenant_id()"),
    );
    expect(await sqlStateOf(remove)).toBe("42501");
    const flip = app.withTenant(A, (q) =>
      q.execute("UPDATE screenings SET verdict = 'clean' WHERE tenant_id = current_tenant_id()"),
    );
    expect(await sqlStateOf(flip)).toBe("42501");
  });

  it("keeps an outside text when its driver goes, with the driver cleared", async () => {
    const input = randomUUID();
    const driver = randomUUID();
    await app.withTenant(B, async (q) => {
      await q.execute(
        "INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis," +
          " per_mile_cents, active_from) VALUES (CAST($1 AS uuid), current_tenant_id(), 'GW-2', 'Lee'," +
          " 'Park', $2, 'company', 'per_mile', 55, '2026-02-02')",
        [driver, `lee@gw-b-${tag}.example`],
      );
      await q.execute(
        "INSERT INTO untrusted_inputs (id, tenant_id, kind, source, driver_id, body_text, content_hash," +
          " received_at) VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', 'inbound'," +
          " CAST($2 AS uuid), 'See you Monday.', $3, CAST('2026-10-23T09:00:00Z' AS timestamptz))",
        [input, driver, untrustedContentHash("email", "See you Monday.")],
      );
      await q.execute("DELETE FROM drivers WHERE id = CAST($1 AS uuid)", [driver]);
    });
    const [row] = await app.withTenant(B, (q) =>
      q.query<{ driver_id: string | null }>("SELECT driver_id FROM untrusted_inputs WHERE id = CAST($1 AS uuid)", [
        input,
      ]),
    );
    expect(row).toEqual({ driver_id: null });
  });
});
