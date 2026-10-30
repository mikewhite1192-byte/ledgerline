import { NANOCENTS_PER_CENT } from "../../src/lib/ai/prices";
import type { Spend } from "../../src/lib/ai/spend";
import type { Queryable } from "../../src/lib/db";

// Each eval arm runs on its own throwaway database, so its model calls are reserved and settled
// in that database's ledger, which is dropped after the arm. Before the drop the arm's spend is
// carried into the developer's own local ledger (the one npm run eval checks for room), so the
// running spend log sees eval money and the next run's room check counts it.

// What an arm spent, as its own ledger holds it: spent plus any reservation still open (unknown
// is never zero), overall and on Muse Wonder.
export type ArmSpend = { nanocents: number; wonderNanocents: number };

export function armSpendOf(s: Spend): ArmSpend {
  return {
    nanocents: s.spentNanocents + s.reservedNanocents,
    wonderNanocents: s.wonderSpentNanocents + s.wonderReservedNanocents,
  };
}

// One statement, on the local ledger's one row, as its admin login.
export const CARRY_SQL =
  "UPDATE ops.ai_spend SET spent_nanocents = spent_nanocents + CAST($1 AS bigint)," +
  " wonder_spent_nanocents = wonder_spent_nanocents + CAST($2 AS bigint), updated_at = now() WHERE id = 1";

export async function carrySpend(q: Pick<Queryable, "execute">, s: ArmSpend): Promise<void> {
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!whole(s.nanocents) || !whole(s.wonderNanocents)) throw new Error("an arm's spend is not a whole number of nanocents");
  if ((await q.execute(CARRY_SQL, [s.nanocents, s.wonderNanocents])) !== 1) {
    throw new Error("the local spend ledger row was not updated");
  }
}

export type SettleDeps = {
  // The arm's own ledger, read before its database is dropped.
  read: () => Promise<Spend>;
  // Adds the arm's spend to the local ledger (carrySpend on the developer's database).
  carry: (s: ArmSpend) => Promise<void>;
};

// The arm's spend for the run's own count, carried into the local ledger. An arm ledger that
// cannot be read counts, and is carried as, the arm's whole allowance. A carry that fails also
// counts the whole allowance (never less than what was read) and returns carried false: the run
// then stops and exits non-zero after its cleanup.
export async function settleArmSpend(
  arm: string,
  allowanceCents: number,
  deps: SettleDeps,
): Promise<{ spentNanocents: number; carried: boolean }> {
  const allowance = allowanceCents * NANOCENTS_PER_CENT;
  let spend: ArmSpend;
  try {
    spend = armSpendOf(await deps.read());
  } catch {
    console.error(`eval: the ${arm} arm's ledger could not be read; its whole allowance is counted`);
    spend = { nanocents: allowance, wonderNanocents: allowance };
  }
  try {
    await deps.carry(spend);
  } catch {
    console.error(`eval: the ${arm} arm's spend was not confirmed in the local spend ledger; its whole allowance is counted`);
    return { spentNanocents: Math.max(allowance, spend.nanocents), carried: false };
  }
  console.log(`eval: added ${(spend.nanocents / NANOCENTS_PER_CENT).toFixed(2)} cents from the ${arm} arm to the local spend ledger`);
  return { spentNanocents: spend.nanocents, carried: true };
}
