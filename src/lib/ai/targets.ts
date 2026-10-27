import { priceFor, type Price } from "./prices";
import type { AiCallKind, AiProvider, AiTarget } from "./types";

// Each model slot: who serves it, the variable that holds its exact model id, and what sort of
// call it makes. The price comes from ./prices.ts, by that id.
export const TARGETS: Record<AiTarget, { provider: AiProvider; env: string; kind: AiCallKind }> = {
  // The operator agent: tools, structured output, images and PDFs.
  spark: { provider: "meta", env: "META_MODEL_SPARK", kind: "text" },
  // The auditor, the expensive model; it has its own cap inside the overall one.
  wonder: { provider: "meta", env: "META_MODEL_WONDER", kind: "text" },
  // Triage, open weights on Baseten.
  spark_open: { provider: "baseten", env: "BASETEN_MODEL_ID", kind: "text" },
  voice: { provider: "meta", env: "META_MODEL_VOICE", kind: "transcribe" },
  image: { provider: "meta", env: "META_MODEL_IMAGE", kind: "image" },
  sam: { provider: "meta", env: "META_MODEL_SAM", kind: "segment" },
};

export function isTarget(value: unknown): value is AiTarget {
  return typeof value === "string" && Object.hasOwn(TARGETS, value);
}

// A target's standby host: the one other host the wrapper may try, once, when the primary fails
// for a reason that is the host's own, and only while flags.sparkOpenFallback names it. Only
// Muse Spark Open has one (open weights run anywhere); Meta's API is the only path for the rest.
export const FALLBACKS: Partial<Record<AiTarget, { provider: AiProvider; env: string }>> = {
  spark_open: { provider: "fireworks", env: "FIREWORKS_MODEL_ID" },
};

// The variable that holds a target's model id on a host: the primary's own, the standby's, or
// none for a host that does not serve the target.
function modelEnvFor(target: AiTarget, provider: AiProvider): string | null {
  if (provider === TARGETS[target].provider) return TARGETS[target].env;
  const standby = FALLBACKS[target];
  return standby && standby.provider === provider ? standby.env : null;
}

// Muse Spark's Contributor tier, by the Standard id it replaces. Meta may train on what is sent
// to it, so it is for synthetic data only (development and EVAL) and META_CONTRIBUTOR_MODE is
// never set on the hosted app. Wonder, Voice, Image, SAM and Baseten have no such tier.
export const CONTRIBUTOR_IDS: Readonly<Record<string, string>> = {
  "muse-spark-1.3": "muse-spark-1.3-contributor",
};

// META_CONTRIBUTOR_MODE, read strictly: unset or "false" is off, "true" is on, and anything else
// is null, which refuses every model call.
export function contributorMode(value: string | undefined): boolean | null {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  return null;
}

// True when the Contributor switch refuses every target: the mode is invalid, or it is on in
// production (DB_CLUSTER_ARN set, the signal ./keys.ts reads too: real tenants' data must never
// reach a tier Meta may train on). Like an invalid mode, the mode on in production refuses every
// target, not only Spark, so no half-working mode is left. It is a refusal of ours, never a
// host's, so no standby host is tried after it.
export function contributorRefusesAll(env: Record<string, string | undefined>): boolean {
  const contributor = contributorMode(env.META_CONTRIBUTOR_MODE);
  return contributor === null || (contributor && Boolean(env.DB_CLUSTER_ARN));
}

// The model id a target calls on a host (default: its primary): that host's variable, or, for
// Spark in Contributor mode, that id's Contributor counterpart. Null when the Contributor switch
// refuses every target (above), when the host does not serve the target, when the variable names
// a Contributor id itself (reached only through the switch), or when Contributor mode is on and
// the Spark id has no counterpart.
export function modelIdFor(
  target: AiTarget,
  env: Record<string, string | undefined> = process.env,
  provider: AiProvider = TARGETS[target].provider,
): string | null {
  const name = modelEnvFor(target, provider);
  if (name === null || contributorRefusesAll(env)) return null;
  const configured = env[name] ?? "";
  if (Object.values(CONTRIBUTOR_IDS).includes(configured)) return null;
  if (contributorMode(env.META_CONTRIBUTOR_MODE) !== true || target !== "spark") return configured;
  return Object.hasOwn(CONTRIBUTOR_IDS, configured) ? CONTRIBUTOR_IDS[configured] : null;
}

// The target's model id on a host (default: its primary) and its price, or null when there is no
// id (above), that host has no price for the id, or the price is not metered the way the call
// needs.
export function modelFor<U extends Price["unit"]>(
  target: AiTarget,
  unit: U,
  provider: AiProvider = TARGETS[target].provider,
): { model: string; price: Extract<Price, { unit: U }> } | null {
  const model = modelIdFor(target, process.env, provider);
  if (model === null) return null;
  const price = priceFor(target, provider, model);
  if (!price || price.unit !== unit) return null;
  return { model, price: price as Extract<Price, { unit: U }> };
}
