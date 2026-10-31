import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbTurnStore, openAgentTurn } from "@/lib/agent/gateway/store";
import type { Session } from "@/lib/auth/claims";
import { createPgDb } from "@/lib/db/pg";
import { adminUrl, appUrl } from "@/lib/db/test-urls";
import type { Db } from "@/lib/db/types";
import { readNeedsYou } from "./needs-you";

// Home's escalated row against a real database, as the app's role: it counts the turns in this
// person's own chat that ended with a person in the last 7 days, links to the chat's page, and counts
// nothing for another person, a demo visit or an older turn. The turns are opened and finished
// through the agent's own store. One tenant, removed after.

const T = randomUUID();
const NOW = new Date("2026-11-02T16:00:00.000Z");
const ME: Session = { sub: `sub-${T}`, email: "ops@home-escalated-test.example", tenantId: T };
const OTHER: Session = { sub: `other-${T}`, email: "other@home-escalated-test.example", tenantId: T };

let admin: Db;
let app: Db;

// One turn in a new conversation, finished at the given time with the given ending.
async function turnEnding(session: Session, at: Date, endedReason: string | null): Promise<string> {
  const turnId = randomUUID();
  const opened = await openAgentTurn(
    session,
    { conversationId: null, turnId, text: "Can this driver get an advance?", now: at, summaryChars: 10_000 },
    { db: app, clock: () => at },
  );
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  await dbTurnStore(session, { db: app, clock: () => at }).finishTurn(turnId, {
    status: endedReason === null ? "done" : "partial",
    endedReason,
    text: "Done.",
    summary: "Done.",
    stepCount: 0,
    modelCallCount: 1,
    costNanocents: 0,
  });
  return turnId;
}

const home = (sub: string, now: Date, visitId: string | null = null) =>
  app.withTenant(T, (q) =>
    readNeedsYou(q, {
      today: "2026-11-02",
      settlements: false,
      advances: false,
      invoices: false,
      escalations: { now, sub, visitId },
    }),
  );

describe("Home's escalated row", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await admin.withTenant(T, async (q) => {
      await q.execute(
        "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
        [`home-esc-${T.slice(0, 8)}`, "Home Escalated Test"],
      );
      for (const s of [ME, OTHER]) {
        await q.execute(
          "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')",
          [s.sub, s.email],
        );
      }
    });
    // Two escalated turns of mine this week, one answered, one escalated 9 days ago, and another
    // person's escalated turn.
    await turnEnding(ME, new Date(NOW.getTime() - 9 * 86_400_000), "escalated");
    await turnEnding(ME, new Date(NOW.getTime() - 3_600_000), "escalated");
    await turnEnding(ME, new Date(NOW.getTime() - 60_000), "escalated");
    await turnEnding(ME, new Date(NOW.getTime() - 30_000), null);
    await turnEnding(OTHER, new Date(NOW.getTime() - 10_000), "escalated");
  });

  afterAll(async () => {
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    await app?.close();
    await admin?.close();
  });

  it("counts this person's escalated turns from the last 7 days and links to the agent card", async () => {
    expect(await home(ME.sub, NOW)).toEqual([
      {
        key: "escalated",
        count: 2,
        atLeast: false,
        what: "requests in your chat escalated to a person",
        amounts: [],
        href: "#ask",
        linkLabel: "Open your chat",
      },
    ]);
  });

  it("counts nothing for a demo visit, nor once the turns are older than 7 days", async () => {
    expect(await home(ME.sub, NOW, randomUUID())).toEqual([]);
    expect(await home(ME.sub, new Date(NOW.getTime() + 8 * 86_400_000))).toEqual([]);
  });

  it("counts another person's own escalation for them only", async () => {
    expect((await home(OTHER.sub, NOW)).map((r) => [r.key, r.count])).toEqual([["escalated", 1]]);
    expect(await home(`nobody-${T}`, NOW)).toEqual([]);
  });
});
