import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { createPgDb } from "@/lib/db/pg";
import { adminUrl, appUrl } from "@/lib/db/test-urls";
import type { Db } from "@/lib/db/types";
import { forgetInboundKey } from "@/lib/inbound/internal-key";
import { dropTenant, makeTenant, type Fixture } from "@/lib/money/test-db";
import { POST } from "./route";

// The internal inbound route against a real database, as the app's own role: the same SES message
// posted twice (a retried poster invocation) is one row, named by its message id, the dedupe key.
// The models are switched off, so the sort stops at ai_off before any call and the row stays
// received. Every tenant made here is removed after each test.

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => holder.db,
}));

const KEY = "Zk3".repeat(16);
const saved = structuredClone(flags);
const savedKey = process.env.INBOUND_INTERNAL_KEY;
let admin: Db;
let app: Db;
let A: Fixture | undefined;

const post = (body: unknown) =>
  POST(
    new Request("https://app.example/api/internal/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", "x-inbound-key": KEY },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/internal/inbound (database)", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    holder.db = app;
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.inboundEmailEnabled = true;
    flags.inboxEnabled = true;
    flags.aiEnabled = false;
    process.env.INBOUND_INTERNAL_KEY = KEY;
    forgetInboundKey();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    A = await makeTenant(admin, `inbound-mail-${randomBytes(4).toString("hex")}`);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
           (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@inbound-mail-test.invalid', 'staff')`,
      ),
    );
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    if (savedKey === undefined) delete process.env.INBOUND_INTERNAL_KEY;
    else process.env.INBOUND_INTERNAL_KEY = savedKey;
    forgetInboundKey();
    vi.restoreAllMocks();
    if (A) await dropTenant(admin, A);
    A = undefined;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("keeps one row for a message posted twice with the same message id", async () => {
    const f = A!;
    const body = {
      tenantId: f.tenantId,
      messageId: `ses${randomBytes(8).toString("hex")}`,
      fromAddress: null,
      subject: "Lumper",
      text: "Need a lumper code at the dock, $120.",
      receivedAt: "2026-11-02T16:00:00.000Z",
    };
    const first = await post(body);
    expect(first.status).toBe(202);
    const one = await first.json();
    expect(one).toMatchObject({ status: "received" });

    const second = await post(body);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(one);

    const rows = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ id: string; channel: string; created_by: string }>(
        "SELECT CAST(id AS text) AS id, channel, created_by FROM inbound_messages WHERE tenant_id = current_tenant_id() AND message_id = $1",
        [body.messageId],
      ),
    );
    expect(rows).toEqual([{ id: one.id, channel: "email", created_by: `service:sweep:${f.tenantId}` }]);
  });

  it("refuses a carrier that has no service login", async () => {
    const f = A!;
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("DELETE FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = 'service:sweep:' || CAST(current_tenant_id() AS text)"),
    );
    const res = await post({
      tenantId: f.tenantId,
      messageId: "ses-unknown-carrier",
      fromAddress: null,
      subject: null,
      text: "Hello",
      receivedAt: "2026-11-02T16:00:00.000Z",
    });
    expect(res.status).toBe(403);
  });
});
