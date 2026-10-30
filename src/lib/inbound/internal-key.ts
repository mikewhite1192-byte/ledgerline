import { internalKeyReader, keyMatches, type KeyDeps } from "../sweep/internal-key";

// The inbound mail poster's key for POST /api/internal/inbound, read the way the sweep's key is:
// INBOUND_INTERNAL_KEY from .env.local locally; in production (DB_CLUSTER_ARN set) Secrets Manager
// by the name in INBOUND_INTERNAL_KEY_SECRET_NAME, a raw key refused. Kept for the life of the
// instance, with one fresh read on a mismatch at most once a minute. Never logged or returned.

const reader = internalKeyReader({
  rawVar: "INBOUND_INTERNAL_KEY",
  nameVar: "INBOUND_INTERNAL_KEY_SECRET_NAME",
  label: "inbound",
});

export function inboundKey(deps: KeyDeps = {}, opts: { fresh?: boolean } = {}): Promise<string | null> {
  return reader.read(deps, opts);
}

export { keyMatches };

// Tests only.
export function forgetInboundKey(): void {
  reader.forget();
}
