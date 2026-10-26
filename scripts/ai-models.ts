import { existsSync } from "node:fs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { compareModels, liveIds } from "./lib/model-ids";

// npm run ai:models
//
// Lists the Meta Model API's live model ids (GET /v1/models: read-only, free) and marks each
// configured META_MODEL_* value as live or missing. Exit 1 when any is missing, so it can run
// before a release. The key comes from META_API_KEY (.env.local) or, when that is unset, from
// Secrets Manager by META_API_KEY_SECRET_NAME. The key is never printed.

const MODELS_URL = "https://api.meta.ai/v1/models";
const DEFAULT_SECRET = "payday-copilot/meta-api-key";

async function key(): Promise<string> {
  const raw = process.env.META_API_KEY?.trim();
  if (raw) return raw;
  const name = process.env.META_API_KEY_SECRET_NAME?.trim() || DEFAULT_SECRET;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const value = out.SecretString?.trim();
    if (value) return value;
  } catch (err) {
    // The error's name only; its message can echo the request.
    throw new Error(`the key secret is unreadable (${err instanceof Error ? err.name : "error"})`);
  }
  throw new Error("the key secret is empty");
}

async function main(): Promise<number> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const response = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${await key()}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    console.error(`GET /v1/models: HTTP ${response.status}`);
    return 1;
  }
  const live = liveIds(await response.json());
  if (!live) {
    console.error("GET /v1/models: not a model list");
    return 1;
  }
  console.log(`live models (${live.size}):`);
  for (const id of [...live].sort()) console.log(`  ${id}`);
  const checks = compareModels(live, process.env);
  console.log("configured:");
  for (const c of checks) {
    console.log(`  ${c.variable}=${c.value ?? "(unset)"} ${c.live ? "live" : "MISSING"}`);
  }
  return checks.every((c) => c.live) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`ai:models failed: ${err instanceof Error ? err.message : "error"}`);
    process.exit(1);
  },
);
