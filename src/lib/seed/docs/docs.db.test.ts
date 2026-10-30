import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db } from "../../db/types";
import { DEMO_CARRIERS, type DemoCarrier } from "../carriers";
import { buildCarrierPlan } from "../plan";
import { replaceTenantData } from "../run";
import { MANIFEST, isPhoto, type SampleDoc, type TenantSlug } from "./manifest";

// Every sample document's seeded row, read back from a real database as the app role: it is
// there, inside its own tenant, with the reference and amount the document prints, and the
// other tenant cannot see it. Two tenant rows carry the demo slugs; the fresh test database has
// no others with those slugs.

const [BR, PW] = DEMO_CARRIERS;
const ids: Record<TenantSlug, string> = { "blue-ridge": randomUUID(), "prairie-wind": randomUUID() };
const other: Record<TenantSlug, TenantSlug> = { "blue-ridge": "prairie-wind", "prairie-wind": "blue-ridge" };

let admin: Db;
let app: Db;

async function createTenant(id: string, carrier: DemoCarrier): Promise<void> {
  await admin.withTenant(id, (q) =>
    q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)",
      [carrier.slug, carrier.name, carrier.timezone],
    ),
  );
}

type Found = { human_ref: string; amount_cents: string | null; load_number: string | null };

// The row behind a document, with its human reference, its amount (receipts) and its load.
const SELECTS: Record<SampleDoc["ref"]["table"], string> = {
  load_accessorials:
    "SELECT l.load_number AS human_ref, a.amount_cents::text AS amount_cents, " +
    "l.load_number FROM load_accessorials a JOIN loads l ON l.id = a.load_id " +
    "WHERE a.id = CAST($1 AS uuid)",
  pay_items:
    "SELECT p.item_ref AS human_ref, p.amount_cents::text AS amount_cents, l.load_number " +
    "FROM pay_items p LEFT JOIN loads l ON p.ref_table = 'loads' AND l.id = p.ref_id " +
    "WHERE p.id = CAST($1 AS uuid)",
  fuel_purchases:
    "SELECT f.purchase_ref AS human_ref, f.amount_cents::text AS amount_cents, l.load_number " +
    "FROM fuel_purchases f LEFT JOIN loads l ON l.id = f.load_id WHERE f.id = CAST($1 AS uuid)",
  loads:
    "SELECT load_number AS human_ref, NULL AS amount_cents, load_number FROM loads " +
    "WHERE id = CAST($1 AS uuid)",
};

const find = (tenant: TenantSlug, doc: SampleDoc) =>
  app.withTenant(ids[tenant], (q) => q.query<Found>(SELECTS[doc.ref.table], [doc.ref.id]));

describe("the sample documents against a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug IN ($1, $2) ORDER BY slug", [
        BR.slug,
        PW.slug,
      ]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${leftover[0].slug} already exists: the database tests need a fresh database ` +
          "(npm run test:db:fresh)",
      );
    }
    for (const carrier of [BR, PW]) {
      const id = ids[carrier.slug as TenantSlug];
      await createTenant(id, carrier);
      await replaceTenantData(app, id, buildCarrierPlan(carrier, MANIFEST.anchor));
    }
  });

  afterAll(async () => {
    // Only what this file made: the two tenants (their rows go with them).
    for (const id of Object.values(ids)) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("finds each document's row in its own tenant, with what the document prints", async () => {
    for (const doc of MANIFEST.entries) {
      const rows = await find(doc.tenant, doc);
      expect(rows, doc.id).toHaveLength(1);
      const [row] = rows;
      expect(row.human_ref, doc.id).toBe(doc.ref.humanRef);
      // A receipt for a load (MONEY-CODE's) has no row of its own to match its total.
      if (isPhoto(doc) && doc.ref.table !== "loads") {
        expect(Number(row.amount_cents), doc.id).toBe(doc.expect.amountCents);
      }
      expect(row.load_number, doc.id).toBe(doc.ref.loadNumber);
    }
  });

  it("hides each document's row from the other tenant", async () => {
    for (const doc of MANIFEST.entries) {
      expect(await find(other[doc.tenant], doc), doc.id).toEqual([]);
    }
  });
});
