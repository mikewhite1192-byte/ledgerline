import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIST_COLUMNS, META_COLUMNS } from "./store";

// The Data API answers at most 1 MiB. A document's file, its marked copy and its crop are each up
// to 700,000 bytes (about 933 KB as base64), so a statement may name one of the three bytea
// columns at most, and no statement selects every column. Read from the source, so a new statement is held to
// it the day it is written.

const DIR = fileURLToPath(new URL(".", import.meta.url));
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

// Every template or quoted string in a file that reads like SQL.
function statements(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g)) {
    const s = m[1] ?? m[2] ?? "";
    if (/\b(SELECT|UPDATE|INSERT|RETURNING)\b/.test(s)) out.push(s);
  }
  return out;
}

describe("documents statements", () => {
  it("finds the statements it guards", () => {
    const all = SOURCES.flatMap((f) => statements(readFileSync(join(DIR, f), "utf8")));
    expect(all.some((s) => /encode\(bytes, 'base64'\)/.test(s))).toBe(true);
    expect(all.some((s) => /encode\(markup_bytes, 'base64'\)/.test(s))).toBe(true);
    expect(all.some((s) => /encode\(crop_bytes, 'base64'\)/.test(s))).toBe(true);
  });

  it.each(SOURCES)("%s names at most one bytea column per statement and never selects every column", (file) => {
    for (const s of statements(readFileSync(join(DIR, file), "utf8"))) {
      const named = [/\bbytes\b/, /\bmarkup_bytes\b/, /\bcrop_bytes\b/].filter((column) => column.test(s));
      expect(named.length, s.slice(0, 120)).toBeLessThanOrEqual(1);
      expect(/SELECT\s+\*|RETURNING\s+\*|\w\.\*/.test(s), s.slice(0, 120)).toBe(false);
    }
  });

  it("keeps every file out of the row and list columns", () => {
    for (const columns of [LIST_COLUMNS, META_COLUMNS]) {
      expect(columns).not.toMatch(/\bbytes\b|markup_bytes|markup_check|crop_bytes/);
    }
  });
});
