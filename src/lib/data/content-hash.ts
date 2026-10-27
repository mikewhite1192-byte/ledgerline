import { createHash } from "node:crypto";

// The screening cache key for a piece of outside text: the sha256 hex of its kind, a newline and
// the text. The seed and the screener both use it, so a seeded row's stored hash is the key the
// screener looks up.
export function untrustedContentHash(
  kind: "email" | "transcript" | "document",
  text: string,
): string {
  return createHash("sha256").update(`${kind}\n${text}`, "utf8").digest("hex");
}
