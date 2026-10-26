import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The product is LedgerLine. The old name survives only inside deployed identifiers (secret names
// under payday-copilot/), which cannot change without recreating the resource.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".css",
  ".md",
  ".json",
  ".txt",
  ".svg",
  ".html",
]);
// Only a whole secret name: never the tail of a longer path or URL, and it must visibly end (end of
// line, whitespace, a quote, a closing bracket, punctuation, or a sentence's final period). Anything
// else after it, such as a slash, a dotted path or a file extension, keeps the line caught.
const DEPLOYED_ID =
  /(?<![\w./-])payday-copilot\/[a-z0-9-]+(?=$|[\s"'`)\]},;:]|\.(?:\s|$))/g;
const THIS_FILE = fileURLToPath(import.meta.url);

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return TEXT.has(extname(name)) && path !== THIS_FILE ? [path] : [];
  });
}

function hasOldName(line: string): boolean {
  return /copilot/i.test(line.replace(DEPLOYED_ID, ""));
}

function oldNameHits(paths: string[]): string[] {
  return paths.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        hasOldName(line) ? [`${relative(ROOT, path)}:${i + 1}`] : [],
      ),
  );
}

describe("product name", () => {
  it("never shows the old name in the app, its public files or the README", () => {
    const dirs = ["src", "public"]
      .map((d) => join(ROOT, d))
      .filter((d) => statSync(d, { throwIfNoEntry: false }));
    const files = [join(ROOT, "README.md"), ...dirs.flatMap(textFiles)];
    expect(oldNameHits(files)).toEqual([]);
  });

  it("names the package ledgerline", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { name: string };
    expect(pkg.name).toBe("ledgerline");
  });

  it("still allows a deployed secret name", () => {
    expect("payday-copilot/meta-api-key".replace(DEPLOYED_ID, "")).toBe("");
    expect(`SecretId: "payday-copilot/db-admin"`.replace(DEPLOYED_ID, "")).toBe(
      `SecretId: ""`,
    );
    expect(hasOldName("Stored as payday-copilot/db-admin.")).toBe(false);
    expect(hasOldName("(payday-copilot/db-admin), then")).toBe(false);
  });

  it("still catches the old repo in a URL with a path", () => {
    const badge =
      "https://github.com/mikewhite1192-byte/payday-copilot/actions/workflows/ci.yml/badge.svg";
    expect(hasOldName(badge)).toBe(true);
  });

  it("still catches the old repo in a repo-relative link", () => {
    expect(hasOldName("[CI](payday-copilot/actions/workflows/ci.yml)")).toBe(
      true,
    );
    expect(hasOldName("See payday-copilot/ci.yml")).toBe(true);
    expect(
      hasOldName("[CI](payday-copilot/actions/.github/workflows/ci.yml)"),
    ).toBe(true);
    expect(hasOldName("payday-copilot/actions/")).toBe(true);
    expect(hasOldName("payday-copilot/db-admin.ts")).toBe(true);
  });
});
