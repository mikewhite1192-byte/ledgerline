import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The collections code reaches a model in one place and moves no money anywhere. Each file's own module
// names (imports, re-exports, dynamic imports and require calls) are read from the source:
//   1. Only src/lib/collections/draft.ts names the model wrapper (src/lib/ai).
//   2. No collections file names money/ or adapters/: a reminder is words, never a payment.
// The limit: this reads each file's direct names, not the whole graph, so a helper elsewhere that
// re-exported the wrapper would get past it; review covers that.

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DIRS = ["src/lib/collections", "src/app/api/collections", "src/app/collections"];
const SOURCE = /\.[cm]?[jt]sx?$/;
// Tests are not app code: a test may name the wrapper's types and errors to fake a model.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const MODEL_OK = "src/lib/collections/draft.ts";

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

describe("the collections import boundary", () => {
  const files = DIRS.flatMap(filesUnder).map((f) => f.split(sep).join("/"));

  it("finds the collections files", () => {
    expect(files).toContain(MODEL_OK);
    expect(files).toContain("src/lib/collections/verify.ts");
    expect(files).toContain("src/app/api/collections/draft/route.ts");
    expect(files).toContain("src/app/collections/page.tsx");
  });

  it("lets only draft.ts name the model wrapper", () => {
    const naming = files.filter((f) =>
      namesOf(f).some((spec) => {
        const t = target(f, spec);
        return t !== null && under(t, "src/lib/ai");
      }),
    );
    expect(naming).toEqual([MODEL_OK]);
  });

  it("names nothing under money or adapters", () => {
    const naming = files.filter((f) =>
      namesOf(f).some((spec) => {
        const t = target(f, spec);
        return t !== null && (under(t, "src/lib/money") || under(t, "src/lib/adapters"));
      }),
    );
    expect(naming).toEqual([]);
  });
});
