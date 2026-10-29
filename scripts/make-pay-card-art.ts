import { join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createPgDb } from "../src/lib/db/pg";
import type { Db } from "../src/lib/db/types";
import { carrierBySlug } from "../src/lib/seed/carriers";
import { findDemoTenant } from "../src/lib/seed/run";
import { localDatabaseUrl } from "./lib/local-db";
import { parseArtArgs, runArt, type ArtCalls } from "./lib/pay-card-art";

// npm run cards:art [-- --go] [--cap <cents>]
//
// Makes public/pay-cards/art-01.webp to art-03.webp. Without --go it is a dry run: the list and
// the most it could reserve, no call. --go calls Muse Image and Muse Spark through the app's
// wrapper, against the LOCAL database's ledger only (the Blue Ridge demo tenant seeded there),
// with the switch turned on in this process alone, and stops at --cap (20 cents when left out).
// The key comes from META_API_KEY or Secrets Manager by name, is set in this process only and is
// never printed. Each kept file's name, size and sha256 is printed for art.test.ts to pin.

const OUT_DIR = join(process.cwd(), "public", "pay-cards");
const DEFAULT_SECRET = "payday-copilot/meta-api-key";

async function loadKey(): Promise<void> {
  if (process.env.META_API_KEY?.trim()) return;
  const name = process.env.META_API_KEY_SECRET_NAME?.trim() || DEFAULT_SECRET;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  let value: string | undefined;
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
    value = out.SecretString?.trim();
  } catch (err) {
    // The error's name only; its message can echo the request.
    throw new Error(`the key secret is unreadable (${err instanceof Error ? err.name : "error"})`);
  }
  if (!value) throw new Error("the key secret is empty");
  process.env.META_API_KEY = value;
}

async function localSession(admin: Db): Promise<ArtCalls["session"]> {
  const carrier = carrierBySlug("blue-ridge");
  if (!carrier) throw new Error("no blue-ridge carrier");
  const tenantId = await findDemoTenant(admin, carrier);
  const rows = await admin.withoutTenant((q) =>
    q.query<{ cognito_sub: string; email: string }>(
      "SELECT cognito_sub, email FROM memberships WHERE tenant_id = $1 AND role = 'admin' " +
        "ORDER BY created_at, cognito_sub LIMIT 1",
      [tenantId],
    ),
  );
  if (rows.length !== 1) throw new Error("no admin login for blue-ridge: run the demo users first");
  return { sub: rows[0].cognito_sub, email: rows[0].email, tenantId };
}

async function main(): Promise<number> {
  const options = parseArtArgs(process.argv.slice(2));
  const io = { outDir: OUT_DIR, log: (l: string) => console.log(l) };
  if (options.mode !== "go") {
    await runArt(options, io);
    return 0;
  }
  // Production reads its key and database another way; this script is for a laptop only.
  if (process.env.DB_CLUSTER_ARN) throw new Error("DB_CLUSTER_ARN is set: run this locally only");
  await loadKey();
  const adminUrl = localDatabaseUrl();
  const appUrl = new URL(adminUrl);
  appUrl.username = "payday_app";
  appUrl.password = "";
  const admin = createPgDb({ connectionString: adminUrl.toString(), max: 1 });
  const app = createPgDb({ connectionString: appUrl.toString(), max: 1 });
  try {
    const session = await localSession(admin);
    const result = await runArt(options, io, { session, ai: { db: app } });
    return result.stopped ? 1 : 0;
  } finally {
    await admin.close();
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
