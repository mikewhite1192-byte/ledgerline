import { localHooksAllowed, type LocalModeEnv } from "../../config/local-mode";
import { AiError } from "./types";

// Hosts the override may point at: this machine only, so a mistaken value can never send a
// request, or the key it carries, anywhere else.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// The provider URL a call is sent to. Unset AI_HOST_OVERRIDE: the URL as given. Set, in local
// mode only (no Aurora cluster, not a production build): the same path and query on the local
// replay host the demo-path test starts, so no call leaves the machine. The ledger still names
// the real provider and model; only the origin changes.
// Set where local hooks are not allowed, or set to anything but a loopback origin: every call is
// refused not_configured with one log line, before any reservation. Never a silent reroute.
export function hostFor(url: string, env: LocalModeEnv = process.env): string {
  const override = env.AI_HOST_OVERRIDE;
  if (override === undefined || override === "") return url;
  if (!localHooksAllowed(env)) {
    console.error("ai: AI_HOST_OVERRIDE is set outside local mode; every call is refused");
    throw new AiError("not_configured");
  }
  const origin = loopbackOrigin(override);
  if (!origin) {
    console.error("ai: AI_HOST_OVERRIDE is not a loopback origin; every call is refused");
    throw new AiError("not_configured");
  }
  const target = new URL(url);
  return `${origin}${target.pathname}${target.search}`;
}

function loopbackOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!LOOPBACK.has(u.hostname)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  return u.origin;
}
