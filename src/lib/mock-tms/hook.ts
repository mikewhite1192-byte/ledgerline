import { flags } from "../../config/flags";
import { tmsHookKey } from "../tms/hook-key";

// MOCK-TMS: after a change commits, the sample dispatch system calls our own webhook route the way a
// real dispatch system would: POST <origin>/api/internal/tms-hook/<tenant>?token=<key> with
// { recordType: "load", externalId }, over real HTTP. The route only wakes the desk; the desk then
// reads the change through the read-only dispatch source. The origin is TMS_HOOK_ORIGIN when set,
// else the origin of this app's own configured callback address (QBO_REDIRECT_URI), https only
// (http only on this machine); never a request's Host header, which would hand the key to whoever
// sent it. The answer is a category only: sent, refused_<status>, not_configured, hook_off,
// timeout or unreachable. A send that fails changes nothing: the desk's clock and "Sync dispatch
// now" find the change anyway. The key, the address and the body never reach a log, a row or a page.

export type HookResult = "sent" | "not_configured" | "hook_off" | "timeout" | "unreachable" | `refused_${number}`;

// The route queues the wake-up before it runs the desk, so a short wait is enough: past it the
// answer is "timeout" and the queued wake-up or the desk's clock reads the change.
export const HOOK_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;

export type HookDeps = {
  fetch?: typeof fetch;
  key?: () => Promise<string | null>;
  env?: Env;
  timeoutMs?: number;
};

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password) return null;
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local))) return null;
  return url.origin;
}

export function hookOrigin(env: Env): string | null {
  return env.TMS_HOOK_ORIGIN ? originOf(env.TMS_HOOK_ORIGIN) : originOf(env.QBO_REDIRECT_URI);
}

export async function sendMockHook(tenantId: string, externalId: string, deps: HookDeps = {}): Promise<HookResult> {
  // Each switch is re-read here: the route would refuse anyway, and nothing is sent while off.
  if (flags.mockTms.enabled !== true || flags.tmsHook.enabled !== true || flags.tmsSync.enabled !== true) return "hook_off";
  const origin = hookOrigin(deps.env ?? process.env);
  if (origin === null) return "not_configured";
  let key: string | null;
  try {
    key = await (deps.key ?? (() => tmsHookKey()))();
  } catch {
    key = null;
  }
  if (!key) return "not_configured";
  const url = `${origin}/api/internal/tms-hook/${encodeURIComponent(tenantId)}?token=${encodeURIComponent(key)}`;
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordType: "load", externalId }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? HOOK_TIMEOUT_MS),
    });
    if (res.status === 202) return "sent";
    const status = Number.isSafeInteger(res.status) && res.status >= 100 && res.status <= 599 ? res.status : 500;
    return `refused_${status}`;
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.error(`mock tms hook send failed: ${name}`);
    return name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
  }
}
