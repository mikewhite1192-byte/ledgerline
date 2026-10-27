// The one file I/O in agent code: this test reads the source tree. No agent module imports it.
// eslint-disable-next-line no-restricted-imports -- a test reading the source tree
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// No path around the gateway, from the code's side. The lint rule sees each file's own import
// lines; this test walks the whole import graph from every agent file, through re-exports,
// folder indexes, dynamic imports, require and type imports, and through modules outside the
// agent folders, so a re-export from a helper elsewhere cannot carry a forbidden module in.
//
//   P1. Outside src/lib/agent/gateway, agent code reaches the database, the record readers, the
//       rules engine, the model wrapper, money/ and adapters/ only through the gateway. The two
//       exceptions are the operator turn and the auditor run, which call the model wrapper
//       directly.
//   P2. Nothing reachable from any agent file, the gateway included, is a money write or a
//       payment or accounting adapter: under money/ only read, types, keys and format, and under
//       adapters/ only types and tms/*.
//   P3. Nothing reachable from any agent file uploads, stores or reads a document with the model:
//       under documents/ only types, schema, match and candidates.
//
// A module loaded by a name that is not a string literal, a loader named anywhere but as the
// callee of a direct require("..."), or a local import that does not resolve, fails the walk:
// what cannot be followed cannot be proven. The limit: the walk sees names only as written, so a
// loader name put together at run time (process["getBuiltin" + "Module"]) and code run from a
// string (eval, new Function) get past it. eslint.config.mjs refuses the string-to-code routes
// (no-eval, no-new-func, no-implied-eval, the vm module); any other name assembled at run time is
// left to review. Packages are not walked: the lint rule refuses the database, AWS SDK, process,
// network and file packages in agent code outside the gateway, and vm and the network globals in
// all agent code.

type Host = { read(file: string): string | undefined };
type Edge = { to: string; spec: string };
type Graph = { edges: Map<string, Edge[]>; problems: string[] };

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const AGENT_DIRS = ["src/lib/agent", "src/app/api/agent"];
const SOURCE = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
// The agent files that may import the model wrapper directly, and nothing else restricted.
const MODEL_CALLERS: ReadonlySet<string> = new Set([
  "src/lib/agent/operator/turn.ts",
  "src/lib/agent/auditor/run.ts",
  "src/lib/agent/sweep/explain.ts",
]);
// Every area match ignores case: on a case-insensitive file system "../../Money/execute" resolves.
const MONEY_OK = /^src\/lib\/money\/(read|types|keys|format)\.[cm]?[jt]sx?$/i;
const ADAPTERS_OK = /(^|\/)adapters\/(types|tms\/[\w-]+)\.[cm]?[jt]sx?$/i;
const DOCUMENTS_OK = /^src\/lib\/documents\/(types|schema|match|candidates)\.[cm]?[jt]sx?$/i;
// Every name that loads a module with no import line; eslint.config.mjs bans the same set. Regexes,
// not strings: this file is agent code too, so it names no loader in quotes.
const LOADER_NAME =
  /^(require|createRequire|getBuiltinModule|__non_webpack_require__|__webpack_require__|_load|mainModule)$/;
const REQUIRE = /^require$/;

const diskHost: Host = {
  read(file) {
    try {
      return statSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  },
};

function memoryHost(files: Record<string, string>): Host {
  return { read: (file) => (Object.hasOwn(files, file) ? files[file] : undefined) };
}

const relTo = (root: string, file: string) => relative(root, file).split(sep).join("/");

// The require in require(x), which the call itself reports; any other require is a loader.
function isRequireCallee(node: ts.Node): boolean {
  return (
    ts.isIdentifier(node) &&
    REQUIRE.test(node.text) &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node
  );
}

// Every way a TypeScript file can name another module. A direct require("...") call is an edge.
// A null spec is a name that is not a string literal (import(x), require(x)), or a loader named
// any other way, as an identifier or in quotes: an alias of require, module.require,
// process.mainModule, module.constructor._load, createRequire, process.getBuiltinModule, the
// bundler's __webpack_require__ and __non_webpack_require__, or a computed member such as
// ["createRequire"].
function refsOf(file: string, text: string): { spec: string | null; line: number }[] {
  if (!SOURCE.test(file)) return [];
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: { spec: string | null; line: number }[] = [];
  const add = (node: ts.Node, expr: ts.Node | undefined) =>
    out.push({
      spec: expr && ts.isStringLiteralLike(expr) ? expr.text : null,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireCallee(node.expression))
    ) {
      add(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (
      ((ts.isIdentifier(node) && !isRequireCallee(node)) || ts.isStringLiteralLike(node)) &&
      LOADER_NAME.test(node.text)
    ) {
      add(node, undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Relative and "@/" specifiers resolve the way the bundler does; anything else is a package.
function resolveRef(root: string, from: string, spec: string, host: Host): string | "package" | null {
  let base: string;
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    base = resolve(dirname(from), spec);
  } else if (spec.startsWith("@/")) {
    base = resolve(root, "src", spec.slice(2));
  } else if (spec.startsWith("/")) {
    base = resolve(spec);
  } else {
    return "package";
  }
  const swapped = base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  const candidates = [
    base,
    swapped,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, `index${e}`)),
  ];
  return candidates.find((c) => host.read(c) !== undefined) ?? null;
}

function buildGraph(root: string, entries: string[], host: Host): Graph {
  const edges = new Map<string, Edge[]>();
  const problems: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (edges.has(file)) continue;
    const out: Edge[] = [];
    edges.set(file, out);
    const text = host.read(file);
    if (text === undefined) {
      problems.push(`${relTo(root, file)}: not readable`);
      continue;
    }
    for (const ref of refsOf(file, text)) {
      const where = `${relTo(root, file)}:${ref.line}`;
      if (ref.spec === null) {
        problems.push(`${where}: a module loaded by a name that is not a string literal`);
        continue;
      }
      const to = resolveRef(root, file, ref.spec, host);
      if (to === "package") continue;
      if (to === null) {
        problems.push(`${where}: "${ref.spec}" does not resolve`);
        continue;
      }
      out.push({ to, spec: ref.spec });
      if (!edges.has(to)) queue.push(to);
    }
  }
  return { edges, problems };
}

function restrictedArea(rel: string): string | null {
  const m = /^src\/lib\/(db|data|rules-engine|money|ai|adapters)(\/|\.|$)/i.exec(rel);
  if (m) return m[1].toLowerCase();
  return /(^|\/)adapters(\/|\.|$)/i.test(rel) ? "adapters" : null;
}

const isGateway = (rel: string) => rel.startsWith("src/lib/agent/gateway/");

// P1: from each agent file outside the gateway, walk without entering the gateway (the
// sanctioned path) and without following the turn's one allowed edge into the model wrapper.
function boundaryViolations(root: string, agentFiles: string[], graph: Graph): string[] {
  const out: string[] = [];
  for (const start of agentFiles.filter((f) => !isGateway(relTo(root, f)))) {
    const seen = new Set([start]);
    const queue: { file: string; chain: string[] }[] = [{ file: start, chain: [relTo(root, start)] }];
    while (queue.length > 0) {
      const { file, chain } = queue.shift()!;
      for (const edge of graph.edges.get(file) ?? []) {
        const to = relTo(root, edge.to);
        if (isGateway(to)) continue;
        const area = restrictedArea(to);
        if (area) {
          if (!(area === "ai" && MODEL_CALLERS.has(relTo(root, file)))) out.push([...chain, to].join(" -> "));
          continue;
        }
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push({ file: edge.to, chain: [...chain, to] });
        }
      }
    }
  }
  return out;
}

// Everything reachable from every agent file, the gateway included, each with the file it was
// first reached from.
function reachable(agentFiles: string[], graph: Graph): Map<string, string | null> {
  const parent = new Map<string, string | null>(agentFiles.map((f) => [f, null]));
  const queue = [...agentFiles];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const edge of graph.edges.get(file) ?? []) {
      if (parent.has(edge.to)) continue;
      parent.set(edge.to, file);
      queue.push(edge.to);
    }
  }
  return parent;
}

function chainTo(root: string, parent: Map<string, string | null>, file: string): string {
  const chain = [relTo(root, file)];
  for (let p = parent.get(file); p; p = parent.get(p)) chain.unshift(relTo(root, p));
  return chain.join(" -> ");
}

// P2: walk everything reachable from every agent file, the gateway included.
function ledgerViolations(root: string, agentFiles: string[], graph: Graph): string[] {
  const parent = reachable(agentFiles, graph);
  const out: string[] = [];
  for (const file of parent.keys()) {
    const rel = relTo(root, file);
    // money/ is the ledger's folder (src/lib/rules-engine/money.ts is the engine's cents math).
    const money = /^src\/lib\/money(\/|\.[cm]?[jt]sx?$)/i.test(rel) && !MONEY_OK.test(rel);
    const adapter = /(^|\/)adapters(\/|\.[cm]?[jt]sx?$)/i.test(rel) && !ADAPTERS_OK.test(rel);
    if (!money && !adapter) continue;
    out.push(chainTo(root, parent, file));
  }
  return out;
}

// P3: the same walk; under documents/ only the shapes, the schema and the record comparison.
function documentViolations(root: string, agentFiles: string[], graph: Graph): string[] {
  const parent = reachable(agentFiles, graph);
  const out: string[] = [];
  for (const file of parent.keys()) {
    const rel = relTo(root, file);
    if (/^src\/lib\/documents(\/|\.[cm]?[jt]sx?$)/i.test(rel) && !DOCUMENTS_OK.test(rel)) {
      out.push(chainTo(root, parent, file));
    }
  }
  return out;
}

function check(root: string, agentFiles: string[], host: Host) {
  const graph = buildGraph(root, agentFiles, host);
  return {
    graph,
    problems: graph.problems,
    boundary: boundaryViolations(root, agentFiles, graph),
    ledger: ledgerViolations(root, agentFiles, graph),
    documents: documentViolations(root, agentFiles, graph),
  };
}

function listSources(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : listSources(path);
    return SOURCE.test(name) ? [path] : [];
  });
}

describe("agent import boundary, on the real tree", () => {
  const agentFiles = AGENT_DIRS.flatMap((d) => listSources(join(ROOT, d))).sort();
  const result = check(ROOT, agentFiles, diskHost);
  const reached = [...result.graph.edges.keys()].map((f) => relTo(ROOT, f));

  it("finds the agent files and walks past them", () => {
    expect(agentFiles.map((f) => relTo(ROOT, f))).toContain("src/lib/agent/gateway/index.ts");
    expect(reached).toContain("src/lib/db/index.ts");
    expect(reached.some((r) => r.startsWith("src/lib/rules-engine/"))).toBe(true);
    expect(reached.some((r) => r.startsWith("src/lib/ai/"))).toBe(true);
  });

  it("follows every import: no loader by a computed name, no local import that does not resolve", () => {
    expect(result.problems).toEqual([]);
  });

  it("P1: only the gateway reaches the database, records, engine, model wrapper and money", () => {
    expect(result.boundary).toEqual([]);
  });

  it("P2: nothing an agent file reaches writes money or calls a payment or accounting adapter", () => {
    expect(result.ledger).toEqual([]);
  });

  it("P3: nothing an agent file reaches uploads, stores or reads a document with the model", () => {
    expect(reached).toContain("src/lib/documents/match.ts");
    expect(result.documents).toEqual([]);
  });
});

describe("the walker itself, on fixture trees", () => {
  const V = "/v";
  const at = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([k, v]) => [`${V}/${k}`, v]));
  const run = (files: Record<string, string>) => {
    const tree = at(files);
    const agentFiles = Object.keys(tree).filter((f) =>
      AGENT_DIRS.some((d) => relTo(V, f).startsWith(`${d}/`)),
    );
    return check(V, agentFiles, memoryHost(tree));
  };

  it("passes the allowed paths: gateway to records and ledger reads, the turn to the model wrapper", () => {
    const out = run({
      "src/lib/agent/gateway/ok.ts":
        'import { q } from "../../db";\nimport { r } from "../../money/read";\n' +
        'import type { T } from "@/lib/adapters/types";\nimport { tms } from "../../adapters/tms/db";',
      "src/lib/agent/operator/turn.ts": 'import { complete } from "../../ai";\nimport { callTool } from "../gateway/ok";',
      "src/lib/agent/operator/other.ts": 'import { complete } from "@/lib/ai";',
      "src/lib/ai/index.ts": 'import { db } from "../db";\nexport const complete = 1;',
      "src/lib/db/index.ts": "export const q = 1;",
      "src/lib/money/read.ts": 'import "./keys";',
      "src/lib/money/keys.ts": "",
      "src/lib/adapters/types.ts": "",
      "src/lib/adapters/tms/db.ts": 'import "../../data/tables";',
      "src/lib/data/tables.ts": "",
    });
    expect(out.problems).toEqual([]);
    expect(out.ledger).toEqual([]);
    expect(out.boundary).toEqual(["src/lib/agent/operator/other.ts -> src/lib/ai/index.ts"]);
  });

  it("catches a re-export chain through a helper outside the agent folders", () => {
    const out = run({
      "src/lib/agent/operator/plan.ts": 'export * from "../../seed/helpers";',
      "src/lib/seed/helpers.ts": 'export { pay } from "@/lib/money/execute";',
      "src/lib/money/execute.ts": "export const pay = 1;",
    });
    expect(out.boundary).toEqual([
      "src/lib/agent/operator/plan.ts -> src/lib/seed/helpers.ts -> src/lib/money/execute.ts",
    ]);
    expect(out.ledger).toEqual([
      "src/lib/agent/operator/plan.ts -> src/lib/seed/helpers.ts -> src/lib/money/execute.ts",
    ]);
  });

  it("catches a dynamic import and a require in the gateway itself", () => {
    const out = run({
      "src/lib/agent/gateway/a.ts": 'export async function f() {\n  return import("../../money/ledger");\n}',
      "src/lib/agent/gateway/b.ts": 'export const m = require("@/lib/adapters/payment/mock");',
      "src/lib/money/ledger.ts": "",
      "src/lib/adapters/payment/mock.ts": "",
    });
    expect(out.boundary).toEqual([]);
    expect(out.ledger.sort()).toEqual([
      "src/lib/agent/gateway/a.ts -> src/lib/money/ledger.ts",
      "src/lib/agent/gateway/b.ts -> src/lib/adapters/payment/mock.ts",
    ]);
  });

  it("catches a folder index, an import-equals and a type import", () => {
    const out = run({
      "src/lib/agent/gateway/c.ts": 'import money = require("../../money");\nexport { money };',
      "src/lib/agent/operator/loop.ts":
        'import type { Queryable } from "@/lib/db";\nexport type Q = import("../../rules-engine/types").Cents;',
      "src/lib/money/index.ts": 'export * from "./approval";',
      "src/lib/money/approval.ts": "",
      "src/lib/db/index.ts": "export type Queryable = object;",
      "src/lib/rules-engine/types.ts": "export type Cents = number;",
    });
    expect(out.ledger).toEqual([
      "src/lib/agent/gateway/c.ts -> src/lib/money/index.ts",
      "src/lib/agent/gateway/c.ts -> src/lib/money/index.ts -> src/lib/money/approval.ts",
    ]);
    expect(out.boundary.sort()).toEqual([
      "src/lib/agent/operator/loop.ts -> src/lib/db/index.ts",
      "src/lib/agent/operator/loop.ts -> src/lib/rules-engine/types.ts",
    ]);
  });

  it("refuses a computed module name, a loader with no import, and a local import that does not resolve", () => {
    const out = run({
      "src/lib/agent/operator/x.ts": [
        'const n = "../../money/" + "execute";',
        "export const a = import(n);",
        "export const b = require(n);",
        'export const c = process.getBuiltinModule("node:module").createRequire(import.meta.url)(n);',
        'import "./missing";',
      ].join("\n"),
    });
    expect(out.problems).toEqual([
      "src/lib/agent/operator/x.ts:2: a module loaded by a name that is not a string literal",
      "src/lib/agent/operator/x.ts:3: a module loaded by a name that is not a string literal",
      "src/lib/agent/operator/x.ts:4: a module loaded by a name that is not a string literal",
      "src/lib/agent/operator/x.ts:4: a module loaded by a name that is not a string literal",
      'src/lib/agent/operator/x.ts:5: "./missing" does not resolve',
    ]);
  });

  it("refuses every other way to name a loader: an alias, a member, the bundler's, a quoted key", () => {
    // Each spelling with the lines its problems are on: one problem per loader name it uses.
    const cases: [code: string, lines: number[]][] = [
      ['const r = require;\nexport const m = r("../../money/execute");', [1]],
      ['export const m = module.require("../../money/execute");', [1]],
      ['export const m = process.mainModule.require("../../money/execute");', [1, 1]],
      ['export const m = __non_webpack_require__("../../money/execute");', [1]],
      ['export const m = __webpack_require__("../../money/execute");', [1]],
      [
        'export const m = process.getBuiltinModule("node:module")["createRequire"](import.meta.url)("../../money/execute");',
        [1, 1],
      ],
      ['export const m = module.constructor._load("../../money/execute");', [1]],
      ['export const m = module.constructor[`_load`]("../../money/execute");', [1]],
    ];
    for (const [code, lines] of cases) {
      const out = run({ "src/lib/agent/operator/x.ts": code, "src/lib/money/execute.ts": "" });
      expect(out.problems, code).toEqual(
        lines.map((n) => `src/lib/agent/operator/x.ts:${n}: a module loaded by a name that is not a string literal`),
      );
    }
  });

  it("passes names that only look like a loader's, and a direct require is one edge, not a problem", () => {
    const out = run({
      "src/lib/agent/operator/names.ts": [
        'export const schema = { required: ["driverId"], requirements: ["a"] };',
        'export const loadItems = () => "required";',
        "export const more = { requireAll: 1, _loaded: true, mainModules: [] };",
        'export const ok = require("./ok");',
      ].join("\n"),
      "src/lib/agent/operator/ok.ts": "",
    });
    expect(out.problems).toEqual([]);
    expect(out.graph.edges.get(`${V}/src/lib/agent/operator/names.ts`)).toEqual([
      { to: `${V}/src/lib/agent/operator/ok.ts`, spec: "./ok" },
    ]);
  });

  it("matches areas whatever the case, as a case-insensitive file system resolves them", () => {
    const out = run({
      "src/lib/agent/operator/x.ts": 'import { pay } from "../../Money/execute";',
      "src/lib/agent/operator/turn.ts": 'import { complete } from "../../AI";',
      "src/lib/agent/gateway/g.ts":
        'import { r } from "../../Money/Read";\nimport { m } from "../../ADAPTERS/payment/mock";',
      "src/lib/Money/execute.ts": "",
      "src/lib/Money/Read.ts": "",
      "src/lib/AI/index.ts": "",
      "src/lib/ADAPTERS/payment/mock.ts": "",
    });
    expect(out.problems).toEqual([]);
    expect(out.boundary).toEqual(["src/lib/agent/operator/x.ts -> src/lib/Money/execute.ts"]);
    expect(out.ledger.sort()).toEqual([
      "src/lib/agent/gateway/g.ts -> src/lib/ADAPTERS/payment/mock.ts",
      "src/lib/agent/operator/x.ts -> src/lib/Money/execute.ts",
    ]);
  });

  it("resolves a .js specifier to its .ts file", () => {
    const out = run({
      "src/lib/agent/operator/y.ts": 'export * from "../../money/execute.js";',
      "src/lib/money/execute.ts": "",
    });
    expect(out.problems).toEqual([]);
    expect(out.ledger).toEqual(["src/lib/agent/operator/y.ts -> src/lib/money/execute.ts"]);
  });

  it("P3: allows the document shapes, schema and comparison, and catches the upload, store and read", () => {
    const out = run({
      "src/lib/agent/gateway/doc.ts":
        'import "../../documents/types";\nimport "../../documents/match";\nimport "../../documents/candidates";',
      "src/lib/agent/gateway/bad.ts": 'import { uploadDocument } from "@/lib/documents/service";',
      "src/lib/agent/operator/x.ts": 'export * from "../../Documents/store";',
      "src/lib/documents/types.ts": "",
      "src/lib/documents/match.ts": 'import "./types";',
      "src/lib/documents/candidates.ts": 'import "./match";',
      "src/lib/documents/service.ts": 'import "./read";',
      "src/lib/documents/read.ts": "",
      "src/lib/Documents/store.ts": "",
    });
    expect(out.problems).toEqual([]);
    expect(out.documents.sort()).toEqual([
      "src/lib/agent/gateway/bad.ts -> src/lib/documents/service.ts",
      "src/lib/agent/gateway/bad.ts -> src/lib/documents/service.ts -> src/lib/documents/read.ts",
      "src/lib/agent/operator/x.ts -> src/lib/Documents/store.ts",
    ]);
  });
});
