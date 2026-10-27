import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { ScreenOutcome } from "../agent/gateway/screen";
import { untrustedContentHash } from "../data/content-hash";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, TenantDb } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { handOffMessage, handOffText, receiveMessage, sortMessage, type InboundDeps } from "./pipeline";
import { EXISTING_SQL, insertInbound, listInbound, readInbound, readInboundDetail } from "./store";
import type { ReceiveInput } from "./types";

// The Inbox against a real database, as the app's own role, with the screen, the triage model
// and the agent faked: a paste goes from received to handed off; the sender matches its driver by
// the whole address; a repeated paste or email is one row; another carrier sees nothing and cannot
// write into this one; the app role deletes nothing and changes no fixed column; the checks hold.
// Fixed instants only. Every tenant made here is removed after each test.

const saved = structuredClone(flags);
// 10:00 in Chicago on Monday Nov 2, 2026.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const TEXT = "Need a $300 advance for diesel before the Nov 3 load.";

let admin: Db;
let app: Db;
let A: Fixture | undefined;
let B: Fixture | undefined;

const screenAllowed = (inputId: string, verdict: "clean" | "flagged" = "clean"): ScreenOutcome =>
  ({
    verdict: {
      inputId,
      verdict,
      categories: verdict === "flagged" ? ["instruction_to_agent"] : [],
      confidence: null,
      contentHash: "0".repeat(64),
      via: "model",
      modelCallId: null,
      screenerVersion: 1,
    },
    decisionId: randomUUID(),
    decision: "allowed",
    reason: verdict === "flagged" ? "screen_flagged" : "ok",
  }) as ScreenOutcome;

function deps(over: Partial<InboundDeps> = {}): InboundDeps {
  return {
    db: app,
    clock: () => NOW,
    screen: async (_ctx, inputId) => screenAllowed(inputId),
    triage: async () => ({
      category: "advance_request",
      urgency: "high",
      callId: null,
      decided: true,
      amountCents: 30_000,
      dates: ["2026-11-03"],
      driverId: null,
    }),
    ...over,
  };
}

const paste = (over: Partial<ReceiveInput> = {}): ReceiveInput => ({
  id: randomUUID(),
  channel: "paste",
  text: TEXT,
  fromAddress: null,
  subject: null,
  receivedAt: new Date(NOW - 60_000),
  messageId: null,
  ...over,
});

async function received(f: Fixture, over: Partial<ReceiveInput> = {}) {
  const r = await receiveMessage(f.session, paste(over), deps());
  if (!r.ok) throw new Error(`receive refused: ${r.category}`);
  return r;
}

const rowsIn = (f: Fixture, table: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [r] = await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${table} WHERE tenant_id = current_tenant_id()`);
    return Number(r.n);
  });

describe("the Inbox (database)", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.inboxEnabled = true;
    flags.aiEnabled = true;
    flags.agentEnabled = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tag = randomBytes(4).toString("hex");
    A = await makeTenant(admin, `inbox-a-${tag}`);
    B = await makeTenant(admin, `inbox-b-${tag}`);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    vi.restoreAllMocks();
    for (const f of [A, B]) await dropTenant(admin, f);
    A = undefined;
    B = undefined;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("takes a pasted message from received to handed off, matching its sender to a driver", async () => {
    const f = A!;
    const slug = (await admin.withTenant(f.tenantId, (q) => q.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = current_tenant_id()")))[0].slug;
    const r = await received(f, { fromAddress: `Driver One <DRV-1@${slug}.example>`, subject: "Advance" });
    expect(r).toMatchObject({ duplicate: false, message: { status: "received", driverId: f.driverId, driverCode: "DRV-1", attempts: 0 } });
    const id = r.message.id;

    // The text is an untrusted input (kind email, source inbound), the kind the agent's read tool reads.
    const detail = () => app.withTenant(f.tenantId, (q) => readInboundDetail(q, id));
    const fresh = await detail();
    expect(fresh).toMatchObject({ text: TEXT, fromAddress: `drv-1@${slug}.example`, subject: "Advance", trace: [] });
    const [input] = await app.withTenant(f.tenantId, (q) => q.query<{ kind: string; source: string }>(
      "SELECT kind, source FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = (SELECT input_id FROM inbound_messages WHERE id = CAST($1 AS uuid))",
      [id],
    ));
    expect(input).toEqual({ kind: "email", source: "inbound" });

    expect(await sortMessage(f.session, id, deps())).toEqual({ ok: true, inboundId: id, status: "triaged", category: null, attempts: 1 });
    expect(await detail()).toMatchObject({
      status: "triaged",
      category: "advance_request",
      urgency: "high",
      amountCents: 30_000,
      dates: ["2026-11-03"],
      triageTarget: "spark_open",
      driverId: f.driverId,
    });
    // A second press finds it sorted and changes nothing.
    expect(await sortMessage(f.session, id, deps())).toMatchObject({ ok: true, status: "triaged", attempts: 1 });

    const conversationId = randomUUID();
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
        conversationId,
        f.session.sub,
      ]),
    );
    const sentences: string[] = [];
    const handed = await handOffMessage(
      f.session,
      id,
      deps({
        newId: () => randomUUID(),
        open: async (_s, opened) => {
          sentences.push(opened.text);
          return { conversationId, turnId: opened.turnId } as never;
        },
        run: async () => "done",
      }),
    );
    expect(handed).toMatchObject({ ok: true, status: "handed_off", conversationId, turnStatus: "done" });
    const inputId = (await app.withTenant(f.tenantId, (q) =>
      q.query<{ input_id: string }>("SELECT CAST(input_id AS text) AS input_id FROM inbound_messages WHERE id = CAST($1 AS uuid)", [id]),
    ))[0].input_id;
    expect(sentences).toEqual([handOffText(inputId)]);
    expect(await detail()).toMatchObject({ status: "handed_off", conversationId });
    expect(await handOffMessage(f.session, id, deps())).toMatchObject({ ok: false, category: "already_handed_off" });
  });

  it("holds a flagged message for a person and never sorts or hands it on", async () => {
    const f = A!;
    const { message } = await received(f);
    let triaged = 0;
    const d = deps({
      screen: async (_ctx, inputId) => screenAllowed(inputId, "flagged"),
      triage: async () => {
        triaged += 1;
        throw new Error("never");
      },
    });
    expect(await sortMessage(f.session, message.id, d)).toMatchObject({ ok: true, status: "blocked", category: "screen_flagged" });
    expect(triaged).toBe(0);
    // The person who must read it can.
    expect(await app.withTenant(f.tenantId, (q) => readInboundDetail(q, message.id))).toMatchObject({ status: "blocked", text: TEXT });
    expect(await handOffMessage(f.session, message.id, d)).toMatchObject({ ok: false, category: "not_ready" });
  });

  it("a carrier cannot read another carrier's inbox rows", async () => {
    const { message } = await received(A!);
    const b = B!;
    const seen = await app.withTenant(b.tenantId, async (q) => ({
      list: await listInbound(q),
      row: await readInbound(q, message.id),
      detail: await readInboundDetail(q, message.id),
    }));
    expect(seen).toEqual({ list: [], row: null, detail: null });
    expect(await sortMessage(b.session, message.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await handOffMessage(b.session, message.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    // Carrier B pasting with carrier A's message id stores nothing and reads nothing of A's.
    expect(await receiveMessage(b.session, paste({ id: message.id }), deps())).toEqual({ ok: false, category: "conflict", retryable: false });
    expect(await rowsIn(b, "untrusted_inputs")).toBe(0);
    // Nor can it write a row into carrier A, or change A's row.
    const state = await sqlStateOf(
      app.withTenant(b.tenantId, (q) =>
        q.execute(
          "INSERT INTO inbound_messages (id, tenant_id, channel, received_at, status, created_by, trace_id)" +
            " VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'paste', now(), 'received', 'x', CAST($3 AS uuid))",
          [randomUUID(), A!.tenantId, randomUUID()],
        ),
      ),
    );
    expect(state).toBe("42501");
    const changed = await app.withTenant(b.tenantId, (q) =>
      q.execute("UPDATE inbound_messages SET status = 'failed', fail_category = 'timeout' WHERE id = CAST($1 AS uuid)", [message.id]),
    );
    expect(changed).toBe(0);
  });

  it("the app role cannot delete an inbox row", async () => {
    const f = A!;
    const { message } = await received(f);
    const asApp = (sql: string) => sqlStateOf(app.withTenant(f.tenantId, (q) => q.execute(sql, [message.id])));
    expect(await asApp("DELETE FROM inbound_messages WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)")).toBe("42501");
    // The channel, input, sender, subject, Message-ID, trace, author and tenant are fixed once written.
    for (const set of [
      "channel = 'email'",
      "input_id = NULL",
      "from_address = 'x@y.example'",
      "subject = 'x'",
      "message_id = 'x'",
      "trace_id = gen_random_uuid()",
      "created_by = 'x'",
      "received_at = now()",
      `tenant_id = CAST('${B!.tenantId}' AS uuid)`,
    ]) {
      expect(await asApp(`UPDATE inbound_messages SET ${set} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`), set).toBe(
        "42501",
      );
    }
    expect(await app.withTenant(f.tenantId, (q) => readInbound(q, message.id))).not.toBeNull();
  });

  it("a repeated email message id is one row per carrier", async () => {
    const messageId = "<a1b2c3@mail.example>";
    const email = (f: Fixture) => receiveMessage(f.session, paste({ channel: "email", messageId }), deps());
    const first = await email(A!);
    const again = await email(A!);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.ok && first.ok && again.message.id).toBe(first.ok && first.message.id);
    expect(await rowsIn(A!, "inbound_messages")).toBe(1);
    expect(await rowsIn(A!, "untrusted_inputs")).toBe(1);
    // The same Message-ID at another carrier is that carrier's own row.
    expect(await email(B!)).toMatchObject({ ok: true, duplicate: false });
    expect(await rowsIn(B!, "inbound_messages")).toBe(1);
    // The unique index holds even for a write that skips the pipeline's lookup.
    const state = await sqlStateOf(
      app.withTenant(A!.tenantId, (q) =>
        q.execute(
          "INSERT INTO inbound_messages (id, tenant_id, channel, message_id, received_at, status, created_by, trace_id)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', $2, now(), 'received', 'x', CAST($3 AS uuid))",
          [randomUUID(), messageId, randomUUID()],
        ),
      ),
    );
    expect(state).toBe("23505");
    // And a repeated paste id is the same row.
    const p = paste();
    await receiveMessage(A!.session, p, deps());
    expect(await receiveMessage(A!.session, p, deps())).toMatchObject({ ok: true, duplicate: true });
    expect(await rowsIn(A!, "inbound_messages")).toBe(2);
  });

  it("counts a repeated insert as no row written, from the rows it returns", async () => {
    const f = A!;
    const p = paste({ channel: "email", messageId: "<twice@mail.example>" });
    const row = { ...p, text: TEXT };
    const hash = untrustedContentHash("email", TEXT);
    const ids = () => ({ inputId: randomUUID(), driverId: null, traceId: randomUUID(), createdBy: f.session.sub, nowIso: new Date(NOW).toISOString() });
    expect(await app.withTenant(f.tenantId, (q) => insertInbound(q, row, hash, ids()))).toBe(1);

    // The same message again, and the same Message-ID under a new id: each insert returns no row,
    // and its transaction is rolled back, as the pipeline does.
    class RolledBack extends Error {}
    for (const again of [row, { ...row, id: randomUUID() }]) {
      let written = -1;
      await expect(
        app.withTenant(f.tenantId, async (q) => {
          written = await insertInbound(q, again, hash, ids());
          throw new RolledBack();
        }),
      ).rejects.toBeInstanceOf(RolledBack);
      expect(written).toBe(0);
    }
    expect(await rowsIn(f, "inbound_messages")).toBe(1);
    expect(await rowsIn(f, "untrusted_inputs")).toBe(1);

    // A delivery that missed the first one's row on its lookup (they arrived together) inserts
    // nothing and answers with the first one's row.
    let skipped = false;
    const racing: TenantDb = {
      withTenant: (tenant, fn) =>
        app.withTenant(tenant, (q) =>
          fn({
            query: async <T>(sql: string, params?: Param[]): Promise<T[]> => {
              if (sql === EXISTING_SQL && !skipped) {
                skipped = true;
                return [];
              }
              return q.query<T>(sql, params);
            },
            execute: (sql, params) => q.execute(sql, params),
          }),
        ),
    };
    const raced = await receiveMessage(f.session, p, deps({ db: racing }));
    expect(skipped).toBe(true);
    expect(raced).toMatchObject({ ok: true, duplicate: true, message: { id: row.id } });
    expect(await rowsIn(f, "inbound_messages")).toBe(1);
    expect(await rowsIn(f, "untrusted_inputs")).toBe(1);
  });

  it("counts the carrier's own day toward the daily cap", async () => {
    const f = A!;
    flags.inboxLimits.messagesPerDay = 2;
    await received(f);
    await received(f);
    expect(await receiveMessage(f.session, paste(), deps())).toEqual({ ok: false, category: "daily_cap", retryable: false });
    // 00:30 the next morning in Chicago is a new day.
    const tomorrow = Date.UTC(2026, 10, 3, 6, 30, 0);
    expect(await receiveMessage(f.session, paste(), deps({ clock: () => tomorrow }))).toMatchObject({ ok: true });
  });

  it("holds the table's checks", async () => {
    const f = A!;
    const insert = (cols: Record<string, string | number | null>) => {
      const row: Record<string, string | number | null> = {
        id: randomUUID(),
        channel: "paste",
        received_at: new Date(NOW).toISOString(),
        status: "received",
        created_by: "x",
        trace_id: randomUUID(),
        ...cols,
      };
      const names = Object.keys(row);
      return sqlStateOf(
        admin.withTenant(f.tenantId, (q) =>
          q.execute(
            `INSERT INTO inbound_messages (tenant_id, ${names.join(", ")}) VALUES (current_tenant_id(), ${names.map((_n, i) => `$${i + 1}`).join(", ")})`,
            names.map((n) => row[n]),
          ),
        ),
      );
    };
    expect(await insert({})).toBe("no error");
    expect(await insert({ channel: "email" })).toBe("23514");
    expect(await insert({ message_id: "<x@y>" })).toBe("23514");
    expect(await insert({ status: "failed" })).toBe("23514");
    expect(await insert({ status: "triaged" })).toBe("23514");
    expect(await insert({ attempts: 4 })).toBe("23514");
    expect(await insert({ triage_amount_cents: 100_000_000 })).toBe("23514");
    expect(await insert({ triage_urgency: "urgent" })).toBe("23514");
    expect(await insert({ triage_target: "wonder" })).toBe("23514");
    expect(await insert({ fail_category: "Bad Words", status: "failed" })).toBe("23514");
    expect(await insert({ subject: "s".repeat(301) })).toBe("23514");
  });
});
