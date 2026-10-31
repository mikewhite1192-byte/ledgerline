import type { Flags } from "./flags";
import { localHooksAllowed, type LocalModeEnv } from "./local-mode";

// The only switches FLAGS_LOCAL_OVERRIDES may set, and only to true or false. Never a cap, a
// limit, a start date or a provider: those always come from flags.ts as written.
export const LOCAL_OVERRIDABLE = [
  "aiEnabled",
  "agentEnabled",
  "agentFocusEnabled",
  "auditorEnabled",
  "reportsEnabled",
  "driverNotesEnabled",
  "inboxEnabled",
  "advancesEnabled",
  "payoutsEnabled",
  "advancePayouts.armed",
] as const;

// Switches FLAGS_LOCAL_OVERRIDES may only turn off, never on. They ship on, but the demo-path
// test's model replay was recorded with them off: each one adds a tool, a prompt line or a
// request field the replay never saw (or, for accounting, a start-up check that needs the sandbox
// company's id; for the rest, a page, a card or a route the recorded run never had). The local run
// sets every one of them false so it replays what it recorded. The armed switches for money
// codes, the desk loop, factoring, escrow releases and the autopilot are listed ahead of their own
// arming, while they still ship off, so each arming PR changes only its flag: an off-only switch can never be
// turned on, so listing one early lets the local run do nothing it could not already do.
export const LOCAL_OFF_ONLY = [
  "accountingEnabled",
  "documentsEnabled",
  "advanceTakeback.enabled",
  "agentToolSearch",
  "agentPromptCache.enabled",
  "invoicesEnabled",
  "customerPaymentsEnabled",
  "clipsEnabled",
  "voiceIntakeEnabled",
  "detentionEnabled",
  "demoResetEnabled",
  "rulesByTalkingEnabled",
  "sweepEnabled",
  "payCorrectionsEnabled",
  "fanoutEnabled",
  "cashFridayEnabled",
  "settlementsEnabled",
  "batchApproveEnabled",
  "invoiceReviewEnabled",
  "collectionsEnabled",
  "profitBriefEnabled",
  "carrierMemoryEnabled",
  "fuelAnomalyEnabled",
  "cardRecon.enabled",
  "inboundEmailEnabled",
  "stepThrough.staff",
  "documentCrop",
  "documentMarkupEnabled",
  "payCardsEnabled",
  "iftaEnabled",
  "yearEndEnabled",
  "trustMeterEnabled",
  "policyOnboardEnabled",
  "sweepScheduleEnabled",
  "quarterReviewEnabled",
  "judgeAccess.enabled",
  "moneyCodes.enabled",
  "moneyCodes.armed",
  "deskLoop.enabled",
  "deskLoop.armed",
  "factoring.enabled",
  "factoring.armed",
  "evalCardEnabled",
  "groundedRatesEnabled",
  "verification.enabled",
  "ratecon.enabled",
  "phoneLineEnabled",
  "escrowRelease.enabled",
  "escrowRelease.armed",
  "autopilot.enabled",
  "autopilot.armed",
  "agentAsks.reasonEnabled",
] as const;

type Overridable = (typeof LOCAL_OVERRIDABLE)[number];
type OffOnly = (typeof LOCAL_OFF_ONLY)[number];
type LocalKey = Overridable | OffOnly;
// A switch inside a switch object, by its path ("deskLoop.enabled").
type InnerKey = Extract<LocalKey, `${string}.${string}`>;

function isOverridable(key: string): key is Overridable {
  return (LOCAL_OVERRIDABLE as readonly string[]).includes(key);
}

function isOffOnly(key: string): key is OffOnly {
  return (LOCAL_OFF_ONLY as readonly string[]).includes(key);
}

function isInner(key: LocalKey): key is InnerKey {
  return key.includes(".");
}

// The demo-path test runs the app with its switches set, without editing flags.ts. In local mode
// only (no Aurora cluster, NODE_ENV exactly development or test; see local-mode.ts),
// FLAGS_LOCAL_OVERRIDES may hold a JSON object such as
// {"agentEnabled":true,"advancePayouts.armed":true,"detentionEnabled":false}. All or nothing: a
// value that is not JSON, not an object, names any other key, holds anything but a boolean or
// turns an off-only switch on changes nothing, with one log line. Outside local mode the variable
// is ignored, with one log line. Returns the keys it set, in the order given.
export function applyLocalOverrides(target: Flags, env: LocalModeEnv = process.env): LocalKey[] {
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
  const set: [LocalKey, boolean][] = [];
  for (const [key, value] of entries) {
    const allowed = typeof value === "boolean" && (isOverridable(key) || (isOffOnly(key) && value === false));
    if (!allowed) {
      console.error("flags: FLAGS_LOCAL_OVERRIDES sets something it may not; nothing changed");
      return [];
    }
    set.push([key, value]);
  }
  for (const [key, value] of set) {
    if (isInner(key)) {
      // A copy of the switch object with that one field set; its caps, limits and dates as they were.
      const [outer, inner] = key.split(".") as [keyof Flags, string];
      (target as Record<keyof Flags, unknown>)[outer] = { ...(target[outer] as object), [inner]: value };
    } else {
      target[key] = value;
    }
  }
  const keys = set.map(([key]) => key);
  if (keys.length > 0) console.log(`flags: local overrides set ${keys.join(", ")}`);
  return keys;
}
