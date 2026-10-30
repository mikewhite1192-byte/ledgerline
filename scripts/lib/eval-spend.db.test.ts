import { afterAll, describe, expect, it } from "vitest";
import { NANOCENTS_PER_CENT } from "../../src/lib/ai/prices";
import { readSpend } from "../../src/lib/ai/spend";
import { createPgDb } from "../../src/lib/db/pg";
import { adminUrl } from "../../src/lib/db/test-urls";
import { carrySpend } from "./eval-spend";

// The carry against the real ledger row, as the admin login the eval script uses, inside a
// transaction that is always rolled back, so the shared test database's ledger is left as it was.
const db = createPgDb({ connectionString: adminUrl(), max: 1 });
afterAll(() => db.close());

class RolledBack extends Error {}

describe("an eval arm's spend carried into the local ledger", () => {
  it("adds to spent and to the second check's spent column, and nothing else", async () => {
    const seen = await db
      .withoutTenant(async (q) => {
        const before = await readSpend(q);
        await carrySpend(q, { nanocents: 3 * NANOCENTS_PER_CENT, wonderNanocents: 2 * NANOCENTS_PER_CENT });
        const after = await readSpend(q);
        throw Object.assign(new RolledBack(), { before, after });
      })
      .catch((e: unknown) => e);
    expect(seen).toBeInstanceOf(RolledBack);
    const { before, after } = seen as RolledBack & { before: Awaited<ReturnType<typeof readSpend>>; after: Awaited<ReturnType<typeof readSpend>> };
    expect(after).toEqual({
      ...before,
      spentNanocents: before.spentNanocents + 3 * NANOCENTS_PER_CENT,
      wonderSpentNanocents: before.wonderSpentNanocents + 2 * NANOCENTS_PER_CENT,
    });
  });
});
