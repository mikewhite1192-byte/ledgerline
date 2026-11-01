import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "./pg";
import { adminUrl } from "./test-urls";
import type { Db } from "./types";

let admin: Db;

describe("migrations", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
  });

  afterAll(async () => {
    await admin?.close();
  });

  it("recorded every file in db/migrations, in order", async () => {
    const dir = new URL("../../../db/migrations/", import.meta.url);
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .map((n) => n.slice(0, -".sql".length));
    const rows = await admin.withoutTenant((q) =>
      q.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version"),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.version)).toEqual(files);
  });

  it("leaves money_actions with exactly the checks 0048 means it to have", async () => {
    // 0048 drops three of 0006's unnamed checks by their generated names (check2, check5, check7:
    // the channel, invoice subject and counterparty pairings) with IF EXISTS, then adds named ones
    // in their place. A wrong name would drop nothing and keep the old check, so the whole set is
    // compared here, sorted in code so the database's collation does not matter.
    const rows = await admin.withoutTenant((q) =>
      q.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = CAST('public.money_actions' AS regclass) AND contype = 'c'`,
      ),
    );
    const names = rows.map((r) => r.conname).sort();
    expect(names).toEqual(
      [
        // 0006's unnamed checks that 0048 keeps.
        "money_actions_check",
        "money_actions_check1",
        "money_actions_check3",
        "money_actions_check4",
        "money_actions_check6",
        "money_actions_check8",
        "money_actions_check9",
        "money_actions_check10",
        "money_actions_check11",
        "money_actions_check12",
        // Column checks, named by Postgres after their column.
        "money_actions_amount_cents_check",
        "money_actions_attempt_check",
        "money_actions_channel_check",
        "money_actions_check_count_check",
        "money_actions_counterparty_table_check",
        "money_actions_failure_category_check",
        "money_actions_idempotency_key_check",
        "money_actions_kind_check",
        "money_actions_outside_amount_cents_check",
        "money_actions_outside_id_check",
        "money_actions_outside_ref_check",
        "money_actions_outside_system_check",
        "money_actions_outside_type_check",
        "money_actions_proposed_by_check",
        "money_actions_request_id_check",
        "money_actions_settled_via_check",
        "money_actions_state_check",
        "money_actions_subject_table_check",
        // The pairings 0048 names in place of check2, check5 and check7, and its own.
        "money_actions_channel_pairing",
        "money_actions_invoice_subject_pairing",
        "money_actions_counterparty_pairing",
        "money_actions_money_code_subject_pairing",
        // 0069's: an escrow release is paired with its escrow_releases subject.
        "money_actions_escrow_subject_pairing",
        // 0080's: a card pull-back is paired with its card_pullbacks subject.
        "money_actions_pullback_subject_pairing",
      ].sort(),
    );
    // The three unnamed subject pairings it keeps are the advance, settlement and customer payment
    // ones, so none of the replaced pairings survives under a kept name.
    const def = (name: string) => rows.find((r) => r.conname === name)?.def ?? "";
    expect(def("money_actions_check3")).toContain("'advances'::text");
    expect(def("money_actions_check4")).toContain("'settlements'::text");
    expect(def("money_actions_check6")).toContain("'customer_payments'::text");
  });
});
