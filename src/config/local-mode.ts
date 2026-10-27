// The one gate for the hooks that exist only so the demo path can run on a laptop or a CI runner
// with no outside system: the model host override (src/lib/ai/host.ts), the local key set for
// sign-in (src/lib/auth/verify.ts) and the local switch overrides (src/config/flags.ts).
// Each hook asks this first. With an Aurora cluster configured, or in a production build, every
// hook is inert, whatever else the environment says.
export type LocalModeEnv = Readonly<Record<string, string | undefined>>;

export function localHooksAllowed(env: LocalModeEnv = process.env): boolean {
  return !env.DB_CLUSTER_ARN && env.NODE_ENV !== "production";
}
