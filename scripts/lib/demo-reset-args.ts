import { carrierBySlug, type DemoCarrier } from "../../src/lib/seed/carriers";

// The arguments of npm run demo:reset. One demo carrier per run, named by slug; there is no "all",
// so a reset of both carriers is two runs a person starts on purpose. Anything not listed in
// the usage is refused rather than ignored.

export type ResetTarget = "local" | "aurora";
export type ResetArgs = { target: ResetTarget; carrier: DemoCarrier; dryRun: boolean };

export const RESET_USAGE =
  "usage: npm run demo:reset -- --target local|aurora --tenant blue-ridge|prairie-wind [--dry-run]";

export function parseResetArgs(argv: readonly string[]): ResetArgs {
  let target: string | undefined;
  let tenant: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" && !dryRun) {
      dryRun = true;
    } else if (arg === "--target" && target === undefined && i + 1 < argv.length) {
      target = argv[++i];
    } else if (arg === "--tenant" && tenant === undefined && i + 1 < argv.length) {
      tenant = argv[++i];
    } else {
      throw new Error(RESET_USAGE);
    }
  }
  if (target !== "local" && target !== "aurora") throw new Error(RESET_USAGE);
  if (tenant === "all") throw new Error(`one tenant per run; ${RESET_USAGE}`);
  const carrier = tenant === undefined ? undefined : carrierBySlug(tenant);
  if (!carrier) throw new Error(RESET_USAGE);
  return { target, carrier, dryRun };
}
