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
});
