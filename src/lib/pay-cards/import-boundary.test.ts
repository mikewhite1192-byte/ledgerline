import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The pay cards code reaches a model in one place and moves no money anywhere. Each file's own
// module names (imports, re-exports, dynamic imports and require calls) are read from the source:
//   1. Only src/lib/pay-cards/check.ts names the model wrapper (src/lib/ai).
//   2. Only the POST route names check.ts, so the pages and the image route never start a call.
//   3. No pay cards file names money/ or adapters/: a card is a picture, never a payment.
// The limit: this reads each file's direct names, not the whole graph, so a helper elsewhere that
// re-exported the wrapper would get past it; review covers that.

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DIRS = ["src/lib/pay-cards", "src/app/api/pay-cards", "src/app/pay/[periodId]/cards", "src/components/pay-cards"];
const SOURCE = /\.[cm]?[jt]sx?$/;
// Tests are not app code: a test may name the wrapper's types and errors to fake a model.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const MODEL_OK = "src/lib/pay-cards/check.ts";
const CHECK_OK = "src/app/api/pay-cards/route.ts";

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

const naming = (files: string[], test: (t: string) => boolean) =>
  files.filter((f) =>
    namesOf(f).some((spec) => {
      const t = target(f, spec);
      return t !== null && test(t);
    }),
  );

describe("the pay cards import boundary", () => {
  const files = DIRS.flatMap(filesUnder).map((f) => f.split(sep).join("/"));

  it("finds the pay cards files", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        MODEL_OK,
        CHECK_OK,
        "src/lib/pay-cards/read.ts",
        "src/app/api/pay-cards/[id]/file/route.ts",
        "src/app/pay/[periodId]/cards/page.tsx",
        "src/components/pay-cards/cards-board.tsx",
      ]),
    );
  });

  it("lets only check.ts name the model wrapper", () => {
    expect(naming(files, (t) => under(t, "src/lib/ai"))).toEqual([MODEL_OK]);
  });

  it("lets only the POST route name check.ts", () => {
    const outside = ["src/app/driver-notes", "src/app/pay"].flatMap(filesUnder).map((f) => f.split(sep).join("/"));
    const all = [...new Set([...files, ...outside])];
    expect(naming(all, (t) => t === "src/lib/pay-cards/check" || t === MODEL_OK)).toEqual([CHECK_OK]);
  });

  it("names nothing under money or adapters", () => {
    expect(naming(files, (t) => under(t, "src/lib/money") || under(t, "src/lib/adapters"))).toEqual([]);
  });
});
