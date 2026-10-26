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

// The model id a target calls: its variable's value, or, for Spark in Contributor mode, that
// id's Contributor counterpart. Null when the mode is invalid, when the variable names a
// Contributor id itself (reached only through the switch), or when Contributor mode is on and
// the Spark id has no counterpart.
export function modelIdFor(
  target: AiTarget,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env[TARGETS[target].env] ?? "";
  const contributor = contributorMode(env.META_CONTRIBUTOR_MODE);
  if (contributor === null || Object.values(CONTRIBUTOR_IDS).includes(configured)) return null;
  if (!contributor || target !== "spark") return configured;
  return Object.hasOwn(CONTRIBUTOR_IDS, configured) ? CONTRIBUTOR_IDS[configured] : null;
}

// The target's model id and its price, or null when there is no id (above), the id has no price
// for this target, or the price is not metered the way the call needs.
export function modelFor<U extends Price["unit"]>(
  target: AiTarget,
  unit: U,
): { model: string; price: Extract<Price, { unit: U }> } | null {
  const model = modelIdFor(target);
  if (model === null) return null;
  const price = priceFor(target, model);
  if (!price || price.unit !== unit) return null;
  return { model, price: price as Extract<Price, { unit: U }> };
}
