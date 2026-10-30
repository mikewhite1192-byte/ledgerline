import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The rates code reaches a model in one place and touches no money or pay number. Each file's own
// module names (imports, re-exports, dynamic imports and require calls) are read from the source:
//   1. Only src/lib/rates/lookup.ts names the model wrapper (src/lib/ai).
//   2. No rates file names money/, adapters/ or the agent: a rate is pinned by a person, never sent.
//   3. No agent file asks for web search: the agent reads pins, it never looks a rate up.
// The limit: this reads each file's direct names, not the whole graph, so a helper elsewhere that
// re-exported the wrapper would get past it; the agent's own import boundary test walks the graph.

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DIRS = ["src/lib/rates", "src/app/api/rates", "src/app/settings/rates", "src/components/rates"];
const SOURCE = /\.[cm]?[jt]sx?$/;
// Tests are not app code: a test may name the wrapper's types and errors to fake a model.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const MODEL_OK = "src/lib/rates/lookup.ts";

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

const naming = (files: string[], areas: string[]) =>
  files.filter((f) =>
    namesOf(f).some((spec) => {
      const t = target(f, spec);
      return t !== null && areas.some((area) => under(t, area));
    }),
  );

describe("the rates import boundary", () => {
  const files = DIRS.flatMap(filesUnder).map((f) => f.split(sep).join("/"));

  it("finds the rates files", () => {
    expect(files).toContain(MODEL_OK);
    expect(files).toContain("src/lib/rates/read.ts");
    expect(files).toContain("src/app/api/rates/lookup/route.ts");
    expect(files).toContain("src/components/rates/rates-board.tsx");
  });

  it("lets only lookup.ts name the model wrapper", () => {
    expect(naming(files, ["src/lib/ai"])).toEqual([MODEL_OK]);
  });

  it("names nothing under money, adapters or the agent", () => {
    expect(naming(files, ["src/lib/money", "src/lib/adapters", "src/lib/agent"])).toEqual([]);
  });

  it("keeps web search out of every agent file", () => {
    const agent = filesUnder("src/lib/agent").map((f) => f.split(sep).join("/"));
    expect(agent.length).toBeGreaterThan(10);
    expect(agent.filter((f) => readFileSync(join(ROOT, f), "utf8").includes("webSearch"))).toEqual([]);
  });
});
