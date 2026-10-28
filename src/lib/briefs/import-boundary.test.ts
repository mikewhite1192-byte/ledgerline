import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The profit brief reaches a model in one place and moves no money anywhere. Each file's own module
// names (imports, re-exports, dynamic imports and require calls) are read from the source:
//   1. Only src/lib/briefs/write.ts names the model wrapper (src/lib/ai).
//   2. Only the POST route names write.ts: the page and the agent's read tool only read.
//   3. No brief file names money/ or adapters/: a brief is words about figures, never a payment.
// The limit: this reads each file's direct names, not the whole graph, so a helper elsewhere that
// re-exported the wrapper would get past it; review covers that.

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DIRS = ["src/lib/briefs", "src/app/api/briefs", "src/app/profit", "src/components/profit"];
const FILES = ["src/lib/agent/gateway/tools/read/get-profit-brief.ts", "src/components/app/nav/items/profit-brief.tsx"];
const SOURCE = /\.[cm]?[jt]sx?$/;
// Tests are not app code: a test may name the wrapper's types and errors to fake a model.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const MODEL_OK = "src/lib/briefs/write.ts";
const WRITE_OK = "src/app/api/briefs/profit/route.ts";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const abs = join(ROOT, dir);
  for (const name of readdirSync(abs)) {
    const path = join(abs, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(join(dir, name)));
    else if (SOURCE.test(name) && !TEST.test(name)) out.push(join(dir, name));
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join("/");

// The repo path a module name points at, or null for a package.
function target(file: string, spec: string): string | null {
  if (spec.startsWith("@/")) return rel(join(ROOT, "src", spec.slice(2)));
  if (spec.startsWith(".")) return rel(resolve(dirname(join(ROOT, file)), spec));
  return null;
}

const under = (path: string, area: string) => {
  const p = path.toLowerCase();
  return p === area || p.startsWith(`${area}/`) || p.startsWith(`${area}.`);
};

function namesOf(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(join(ROOT, file), "utf8"), true, true);
  return info.importedFiles.map((f) => f.fileName);
}

function naming(files: readonly string[], area: (t: string) => boolean): string[] {
  return files.filter((f) =>
    namesOf(f).some((spec) => {
      const t = target(f, spec);
      return t !== null && area(t);
    }),
  );
}

describe("the profit brief import boundary", () => {
  const files = [...DIRS.flatMap(filesUnder), ...FILES].map((f) => f.split(sep).join("/"));

  it("finds the brief files", () => {
    expect(files).toContain(MODEL_OK);
    expect(files).toContain(WRITE_OK);
    expect(files).toContain("src/lib/briefs/verify.ts");
    expect(files).toContain("src/app/profit/page.tsx");
    expect(files).toContain("src/components/profit/write-brief.tsx");
  });

  it("lets only write.ts name the model wrapper", () => {
    expect(naming(files, (t) => under(t, "src/lib/ai"))).toEqual([MODEL_OK]);
  });

  it("lets only the POST route name write.ts", () => {
    expect(naming(files, (t) => under(t, "src/lib/briefs/write"))).toEqual([WRITE_OK]);
  });

  it("names nothing under money or adapters", () => {
    expect(naming(files, (t) => under(t, "src/lib/money") || under(t, "src/lib/adapters"))).toEqual([]);
  });
});
