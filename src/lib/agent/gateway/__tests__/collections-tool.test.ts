import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { Session } from "../../../auth/claims";
import { COLLECTIONS_TOOL_MAX, getCollections } from "../tools/read/get-collections";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "./plan-db";
import { TENANT } from "./fake-db";

// get_collections only reads: the late invoices the rules engine plans reminders for, on today's
// carrier date, with the reminder state per invoice and stage. Drafting and approving happen only
// on the Collections page.

const plan = blueRidgePlan();
const SESSION: Session = { sub: "sub-1", email: "", tenantId: TENANT };
const ctx = {
  session: SESSION,
  turnId: "t-1",
  now: new Date(`${PLAN_ANCHOR}T16:00:00Z`),
  timeZone: plan.carrier.timezone,
} as Parameters<typeof getCollections.run>[1];
const EXTRAS = { screen: null, limit: null };

type Row = {
  invoiceId: string;
  customerId: string;
  stage: string;
  daysLate: number;
  balanceCents: number;
  reminder: string;
  sources: { table: string; id: string }[];
};
type Result = { asOf: string; total: number; omitted: number; rows: Row[] };

async function run(args: { customerId?: string }, drafts: Record<string, unknown>[] = []) {
  const db = planDb(plan);
  db.tables.collection_drafts = drafts;
  const out = await db.withTenant(TENANT, (q) => getCollections.run(q, ctx, args, EXTRAS));
  for (const s of db.statements) expect(s.sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/i);
  return out.result as unknown as Result;
}

beforeEach(() => {
  flags.collectionsEnabled = true;
});
afterEach(() => {
  flags.collectionsEnabled = false;
});

describe("get_collections", () => {
  it("lists the planted late invoices for one customer with no reminder yet, by stage", async () => {
    const planted = plan.planted.collections.filter((p) => p.daysLate >= 30);
    const customerId = planted[0].customerId;
    const out = await run({ customerId });
    expect(out.asOf).toBe(PLAN_ANCHOR);
    const byId = new Map(out.rows.map((r) => [r.invoiceId, r]));
    for (const p of planted.filter((x) => x.customerId === customerId)) {
      const row = byId.get(p.invoiceId);
      expect(row, p.invoiceId).toBeDefined();
      expect(row!.daysLate).toBe(p.daysLate);
      expect(row!.stage).toBe(p.daysLate >= 90 ? "90" : p.daysLate >= 60 ? "60" : "30");
      expect(row!.reminder).toBe("none");
      expect(row!.sources).toContainEqual({ table: "invoices", id: p.invoiceId });
    }
    for (const r of out.rows) {
      expect(r.customerId).toBe(customerId);
      expect(r.daysLate).toBeGreaterThanOrEqual(30);
      expect(Number.isSafeInteger(r.balanceCents)).toBe(true);
    }
    // The 12-day planted invoice is not late enough for a reminder.
    const early = plan.planted.collections.find((p) => p.daysLate < 30);
    if (early) expect(out.rows.map((r) => r.invoiceId)).not.toContain(early.invoiceId);
  });

  it("returns at most the cap, most overdue first, and counts the rest", async () => {
    const out = await run({});
    expect(out.rows.length).toBe(Math.min(out.total, COLLECTIONS_TOOL_MAX));
    expect(out.omitted).toBe(out.total - out.rows.length);
    for (let i = 1; i < out.rows.length; i++) {
      expect(out.rows[i - 1].daysLate).toBeGreaterThanOrEqual(out.rows[i].daysLate);
    }
  });

  it("shows the reminder state of the invoice's stage, not of another stage", async () => {
    const p = plan.planted.collections.find((x) => x.daysLate >= 60 && x.daysLate < 90)!;
    const draft = (stage: string, status: string) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${stage.padStart(12, "0")}`,
      invoice_id: p.invoiceId,
      customer_id: p.customerId,
      stage,
      tone: "direct",
      status,
    });
    const out = await run({ customerId: p.customerId }, [draft("30", "approved"), draft("60", "drafted")]);
    expect(out.rows.find((r) => r.invoiceId === p.invoiceId)?.reminder).toBe("drafted");
    const other = await run({ customerId: p.customerId }, [draft("30", "approved")]);
    expect(other.rows.find((r) => r.invoiceId === p.invoiceId)?.reminder).toBe("none");
  });

  it("refuses to run with its switch off, and is offered only while it is on", async () => {
    flags.collectionsEnabled = false;
    expect(getCollections.enabled?.()).toBe(false);
    await expect(run({})).rejects.toThrow(/switched off/);
    flags.collectionsEnabled = true;
    expect(getCollections.enabled?.()).toBe(true);
  });

  it("takes only a customer id: no tenant, no date, no other field", () => {
    expect(getCollections.args.safeParse({}).success).toBe(true);
    expect(getCollections.args.safeParse({ customerId: "not-an-id" }).success).toBe(false);
    expect(getCollections.args.safeParse({ tenantId: TENANT }).success).toBe(false);
    expect(getCollections.args.safeParse({ asOf: "2026-10-01" }).success).toBe(false);
    expect(getCollections.refs({ customerId: TENANT })).toEqual([{ table: "customers", id: TENANT }]);
    expect(getCollections.refs({})).toEqual([]);
  });
});
