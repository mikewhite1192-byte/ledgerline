import type { Flags } from "./flags";
import { localHooksAllowed, type LocalModeEnv } from "./local-mode";

// The only switches FLAGS_LOCAL_OVERRIDES may set, and only to true or false. Never a cap, a
// limit, a start date or a provider: those always come from flags.ts as written.
export const LOCAL_OVERRIDABLE = [
  "aiEnabled",
  "agentEnabled",
  "auditorEnabled",
  "reportsEnabled",
  "driverNotesEnabled",
  "inboxEnabled",
  "advancesEnabled",
  "payoutsEnabled",
  "advancePayouts.armed",
] as const;

type Overridable = (typeof LOCAL_OVERRIDABLE)[number];

function isOverridable(key: string): key is Overridable {
  return (LOCAL_OVERRIDABLE as readonly string[]).includes(key);
}

// The demo-path test runs the app with its switches on, without editing flags.ts. In local mode
// only (no Aurora cluster, NODE_ENV exactly development or test; see local-mode.ts),
// FLAGS_LOCAL_OVERRIDES may hold a JSON object such as
// {"agentEnabled":true,"advancePayouts.armed":true}. All or nothing: a value that is not
// JSON, not an object, names any other key or holds anything but a boolean changes nothing, with
// one log line. Outside local mode the variable is ignored, with one log line. Returns the keys
// it set, in the order given.
export function applyLocalOverrides(target: Flags, env: LocalModeEnv = process.env): Overridable[] {
  const raw = env.FLAGS_LOCAL_OVERRIDES;
  if (raw === undefined || raw === "") return [];
  if (!localHooksAllowed(env)) {
    console.error("flags: FLAGS_LOCAL_OVERRIDES ignored outside local mode");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("flags: FLAGS_LOCAL_OVERRIDES is not JSON; nothing changed");
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("flags: FLAGS_LOCAL_OVERRIDES is not an object; nothing changed");
    return [];
  }
  const entries = Object.entries(parsed);
  const set: [Overridable, boolean][] = [];
  for (const [key, value] of entries) {
    if (!isOverridable(key) || typeof value !== "boolean") {
      console.error("flags: FLAGS_LOCAL_OVERRIDES sets something it may not; nothing changed");
      return [];
    }
    set.push([key, value]);
  }
  for (const [key, value] of set) {
    if (key === "advancePayouts.armed") {
      target.advancePayouts = { ...target.advancePayouts, armed: value };
    } else {
      target[key] = value;
    }
  }
  const keys = set.map(([key]) => key);
  if (keys.length > 0) console.log(`flags: local overrides set ${keys.join(", ")}`);
  return keys;
}
