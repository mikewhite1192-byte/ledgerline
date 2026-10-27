import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createPgDb } from "../src/lib/db/pg";
import type { Db } from "../src/lib/db/types";
import { carrierBySlug } from "../src/lib/seed/carriers";
import { parseManifest } from "../src/lib/seed/docs/manifest";
import { findDemoTenant } from "../src/lib/seed/run";
import { localDatabaseUrl } from "./lib/local-db";
import { loadPhotoArgs, parseCap, runPhotos, type PhotoCalls } from "./lib/sample-photos";

// npm run docs:photos [-- --go | --compose] [--only <id>] [--cap <cents>]
//
// Makes the six receipt photos in public/samples/docs/ and rewrites their manifest entries.
// Without --go it is a dry run: the list, prompt lengths and the estimate, no call. --go calls
// Muse Image and Muse Spark through the app's wrapper, against the LOCAL database's ledger only
// (the demo tenants seeded there), with the switch turned on in this process alone; the run
// stops at --cap, else SEED_DOCS_CAP_CENTS (the shell, then .env.local), else 60 cents. --compose
// draws every photo as the composed fallback with no key and no database. The key comes from
// META_API_KEY (.env.local) or Secrets Manager by name, is set in this process only and is never
// printed.

const MANIFEST_PATH = join(process.cwd(), "src", "lib", "seed", "docs", "manifest.json");
const PUBLIC = join(process.cwd(), "public");
const DEFAULT_SECRET = "payday-copilot/meta-api-key";

// The key as scripts/ai-models.ts reads it, set in this process for the wrapper to read.
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

// The Blue Ridge tenant and its admin login in the local database: who the calls are made as.
async function localSession(admin: Db): Promise<PhotoCalls["session"]> {
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
  // .env.local is read before the command line, so a cap set there counts.
  const args = loadPhotoArgs(process.argv.slice(2), ".env.local");
  const capCents = parseCap(args.cap);
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  const io = { publicDir: PUBLIC, manifestPath: MANIFEST_PATH, log: (l: string) => console.log(l) };
  if (args.mode !== "go") {
    await runPhotos(manifest, { mode: args.mode, only: args.only, capCents }, io);
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
    const result = await runPhotos(
      manifest,
      { mode: "go", only: args.only, capCents },
      io,
      { session, ai: { db: app } },
    );
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
