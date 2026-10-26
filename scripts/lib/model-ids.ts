// The Meta model slots `npm run ai:models` checks, by the variable that names each one's model.
export const META_MODEL_VARS = [
  "META_MODEL_SPARK",
  "META_MODEL_WONDER",
  "META_MODEL_VOICE",
  "META_MODEL_IMAGE",
  "META_MODEL_SAM",
] as const;

export type ModelCheck = { variable: string; value: string | null; live: boolean };

// The model ids in a GET /v1/models answer ({ data: [{ id }] }), or null when the answer is not
// that shape. Ids are compared whole, never as substrings.
export function liveIds(json: unknown): Set<string> | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const item of data) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

// One line per slot: its configured id, and whether the live list has exactly that id. An unset
// variable is never live.
export function compareModels(
  live: Set<string>,
  env: Record<string, string | undefined>,
): ModelCheck[] {
  return META_MODEL_VARS.map((variable) => {
    const value = env[variable]?.trim() || null;
    return { variable, value, live: value !== null && live.has(value) };
  });
}
