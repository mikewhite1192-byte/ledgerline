import { createHash } from "node:crypto";
import type { SourceRef } from "../rules-engine";

// The fingerprint of a paystub's lines, carried on the settlement_approve card (args.linesHash).
// Any change to what is paid (a kind, an amount, a cited record) is a new hash and so a new card;
// the order the lines come in is not, and neither is a label or the line's meta.

export type HashLine = { kind: string; amountCents: number; sources: readonly SourceRef[] };

export function sourceKey(sources: readonly SourceRef[]): string {
  return sources
    .map((s) => `${s.table}:${s.id.toLowerCase()}`)
    .sort()
    .join(",");
}

export function canonicalLines(lines: readonly HashLine[]): string[] {
  return lines.map((l) => `${l.kind}|${l.amountCents}|${sourceKey(l.sources)}`).sort();
}

export function linesHash(lines: readonly HashLine[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalLines(lines))).digest("hex");
}
