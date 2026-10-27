// The one gate for the hooks that exist only so the demo path can run on a laptop or a CI runner
// with no outside system: the model host override (src/lib/ai/host.ts), the local key set for
// sign-in (src/lib/auth/verify.ts) and the local switch overrides (src/config/flags.ts).
// Each hook asks this first. Local mode is explicit: no Aurora cluster configured, and NODE_ENV
// exactly "development" (next dev) or "test" (the unit tests). NODE_ENV unset, "production" or
// any other value (a staging or custom runtime) turns every hook off, and so does an Aurora
// cluster, whatever else the environment says.
export type LocalModeEnv = Readonly<Record<string, string | undefined>>;

export function localHooksAllowed(env: LocalModeEnv = process.env): boolean {
  if (env.DB_CLUSTER_ARN) return false;
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}
