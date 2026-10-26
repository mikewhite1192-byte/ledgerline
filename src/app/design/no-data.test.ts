import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { metadata } from "./page";

// /design is public and static: nothing it renders may reach a session, a tenant, the database,
// a model or the seed. This walks the page's own folder and every shared component.
const ROOTS = ["src/app/design", "src/components"];
const FORBIDDEN = /from\s+["']@\/lib\/(db|tenant|auth|ai|seed)(\/[^"']*)?["']|import\(\s*["']@\/lib\/(db|tenant|auth|ai|seed)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("/design reads no data", () => {
  const files = ROOTS.flatMap((root) => sourceFiles(path.join(process.cwd(), root)));

  it("finds the files it guards", () => {
    expect(files.some((f) => f.endsWith(path.join("design", "page.tsx")))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("app", "data-table.tsx")))).toBe(true);
  });

  it("imports nothing from the database, tenant, auth, model or seed code", () => {
    const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it("matches the guard against a forbidden import", () => {
    expect(FORBIDDEN.test('import { query } from "@/lib/db";')).toBe(true);
    expect(FORBIDDEN.test("import { getSession } from '@/lib/auth/session';")).toBe(true);
    expect(FORBIDDEN.test('const m = await import("@/lib/ai/wrapper");')).toBe(true);
    expect(FORBIDDEN.test('import { cn } from "@/lib/cn";')).toBe(false);
    expect(FORBIDDEN.test('import { x } from "@/lib/dbx";')).toBe(false);
  });

  it("asks search engines not to index it", () => {
    const robots = metadata.robots;
    expect(robots && typeof robots === "object" ? robots.index : undefined).toBe(false);
  });
});
