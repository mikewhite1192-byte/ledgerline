import { internalKeyReader, keyMatches, type KeyDeps } from "../sweep/internal-key";

// The dispatch system's key for POST /api/internal/tms-hook/<tenant>, read the way the sweep's key
// is: TMS_HOOK_KEY from .env.local locally; in production (DB_CLUSTER_ARN set) Secrets Manager by
// the name in TMS_HOOK_KEY_SECRET_NAME (payday-copilot/tms-hook-key), a raw key refused. Kept for
// the life of the instance, with one fresh read on a mismatch at most once a minute. Never logged
// or returned. A missing key fails closed: the route answers not_configured and wakes nothing.

const reader = internalKeyReader({
  rawVar: "TMS_HOOK_KEY",
  nameVar: "TMS_HOOK_KEY_SECRET_NAME",
  label: "tms hook",
});

export function tmsHookKey(deps: KeyDeps = {}, opts: { fresh?: boolean } = {}): Promise<string | null> {
  return reader.read(deps, opts);
}

export { keyMatches };

// Tests only.
export function forgetTmsHookKey(): void {
  reader.forget();
}
