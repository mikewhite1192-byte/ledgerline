// The pattern pre-screen: a short fixed list of phrases that read as instructions to an automated
// system. A hit only ever adds a flag (pattern_match); it never clears one. This is the one
// substring check in the gateway, and it can only make an outcome stricter.

export const SCREEN_PATTERNS = [
  "ignore previous",
  "system prompt",
  "as the assistant",
  "pre-approved",
  "already approved",
  "skip the check",
  "skip the eligibility check",
  "mark as paid",
  "mark it approved",
  "do not tell",
  "do not mention",
  "for automated systems",
  "payroll assistant",
] as const;

// Lower case, compatibility forms folded, zero-width characters removed, every run of whitespace
// one space, and each hyphen variant a plain hyphen, so look-alike spellings still match.
export function normalizeForPatterns(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ");
}

export function patternHits(text: string): string[] {
  const norm = normalizeForPatterns(text);
  return SCREEN_PATTERNS.filter((p) => norm.includes(p));
}
