// Where the portal runner runs and which origin its browser may reach (design 3.6). None of these
// is a secret.
//
//   PORTAL_RUNNER_MODE           "inline" runs the loop in this process after the response, for
//                                local development only, and is the local default when unset;
//                                "lambda" is the production runner, which a later change wires.
//                                Anything else: not configured.
//   PORTAL_RUNNER_FUNCTION_NAME  the function "lambda" mode invokes.
//   PORTAL_BASE_URL              the portal's origin. Local default http://localhost:3000.
//   PORTAL_RECORD_DIR            local only: a folder for a video of each run.
//   PORTAL_CHROMIUM_PATH         local only: a Chromium binary for the browser, when the one the
//                                browser package expects is not installed.

export type RunnerMode = "inline" | "lambda";

type Env = Record<string, string | undefined>;

// On AWS the app reaches its database through the Data API, so DB_CLUSTER_ARN marks a deployed
// environment. Inline runs a browser inside the request process, which a deployed app cannot.
const deployed = (env: Env) => Boolean(env.DB_CLUSTER_ARN) || env.NODE_ENV === "production";

// The mode, or null when runs cannot start here. Inline is refused wherever the app is deployed;
// lambda needs its function name. Lambda is not wired in this version, so it is null too.
export function runnerMode(env: Env = process.env): RunnerMode | null {
  const mode = env.PORTAL_RUNNER_MODE || "inline";
  if (mode === "inline") return deployed(env) ? null : "inline";
  return null;
}

// The portal's origin (scheme, host and port), or null when it is not set where it must be or is
// not a plain http(s) origin.
export function portalOrigin(env: Env = process.env): string | null {
  const raw = env.PORTAL_BASE_URL || (deployed(env) ? undefined : "http://localhost:3000");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function recordDir(env: Env = process.env): string | null {
  if (deployed(env) || env.NODE_ENV === "test") return null;
  return env.PORTAL_RECORD_DIR || null;
}

export function chromiumPath(env: Env = process.env): string | null {
  return env.PORTAL_CHROMIUM_PATH || null;
}
