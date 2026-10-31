import { describe, expect, it } from "vitest";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db/types";
import { rejectProposal } from "./reject";

// The reject's ledger check with a faked database: a ledger state that does not read, or a ledger
// read that fails, never lets the reject write. The real database cases are in approve.db.test.ts.

const SESSION: Session = { sub: "sub-test", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const ID = "22222222-2222-4222-8222-222222222222";

function fake(ledger: () => Promise<unknown[]>): { db: TenantDb; writes: string[] } {
  const writes: string[] = [];
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM proposals")) return [{ status: "proposed", money_action_id: null }] as T[];
      if (sql.includes("FROM money_actions")) return (await ledger()) as T[];
      throw new Error(`unexpected read: ${sql}`);
    },
    async execute(sql: string): Promise<number> {
      writes.push(sql);
      return 1;
    },
  };
  return { db: { withTenant: (_t, fn) => fn(q) }, writes };
}

describe("rejectProposal's ledger check", () => {
  it("rejects with no ledger row", async () => {
    const { db, writes } = fake(async () => []);
    expect(await rejectProposal(SESSION, ID, "other", { db })).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
  });

  it("refuses on a state that does not read, and writes nothing", async () => {
    for (const state of [null, 7, "SENT", "reserved"]) {
      const { db, writes } = fake(async () => [{ state }]);
      expect(await rejectProposal(SESSION, ID, "other", { db }), String(state)).toEqual({
        ok: false,
        category: "reject_after_money_moved",
      });
      expect(writes).toEqual([]);
    }
  });

  it("fails closed when the ledger read fails: it throws and writes nothing", async () => {
    const { db, writes } = fake(async () => {
      throw new Error("ledger down");
    });
    await expect(rejectProposal(SESSION, ID, "other", { db })).rejects.toThrow("ledger down");
    expect(writes).toEqual([]);
  });
});
