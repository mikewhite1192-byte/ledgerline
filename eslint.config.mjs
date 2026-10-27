import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const NO_CREATE_REQUIRE = "No createRequire in agent code: every dependency is checked statically.";

// Every name that loads a module with no import line: require (also module.require and
// process.mainModule.require), createRequire, process.getBuiltinModule (which reaches createRequire
// with no import), module.constructor._load (the loader under require), and the bundler's own
// __webpack_require__ and __non_webpack_require__ (Next turns the second into Node's require).
// Each is refused by name wherever it appears: a call, an alias (const r = require), a member, a
// destructured key, or a quoted key or computed member ("createRequire", `_load`). Agent code has
// no use for any of them. A name built at run time is not caught here; the import-boundary test
// fails on anything it cannot follow.
const LOADER_NAMES =
  "^(require|createRequire|getBuiltinModule|__non_webpack_require__|__webpack_require__|_load|mainModule)$";
const LOADER_LIST =
  "require, createRequire, getBuiltinModule, _load, mainModule, __webpack_require__ and " +
  "__non_webpack_require__";
const NO_QUOTED_LOADER =
  `No module loader by a quoted name in agent code: a string naming any of ${LOADER_LIST} is ` +
  "refused, so a computed member cannot reach one.";

const NO_DYNAMIC_LOADING = [
  {
    selector: "ImportExpression",
    message: "No dynamic imports in agent code: every dependency is checked statically.",
  },
  {
    selector: `Identifier[name=/${LOADER_NAMES}/]`,
    message: `No module loader in agent code: ${LOADER_LIST} are refused by name, so every dependency is checked statically.`,
  },
  { selector: `Literal[value=/${LOADER_NAMES}/]`, message: NO_QUOTED_LOADER },
  {
    selector: `TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=/${LOADER_NAMES}/]`,
    message: NO_QUOTED_LOADER,
  },
];

// The ledger's own rule: nothing in agent code reaches a money write or a vendor adapter.
const LEDGER_WRITES = [
  {
    regex: "(^|/)money/(?!(read|types|keys|format)(\\.[cm]?[jt]s)?$)",
    message:
      "Agent code proposes only; a person approves and the executor moves money. " +
      "From money/ it may import read, types, keys and format.",
  },
  {
    regex: "(^|/)money$",
    message: "Import the ledger read module you need (money/read, types, keys, format).",
  },
  {
    regex: "(^|/)adapters/(?!(types|tms/[\\w-]+)(\\.[cm]?[jt]s)?$)",
    message:
      "Agent code never calls a payment or accounting adapter; it may use " +
      "adapters/types and adapters/tms only.",
  },
  {
    regex: "(^|/)adapters$",
    message: "Agent code may use adapters/types and adapters/tms only.",
  },
];

// Outside the gateway, agent code reaches records, the engine and money only by tool calls.
const GATEWAY_ONLY = [
  {
    regex: "(^|/)(db|data|rules-engine|money|adapters)(/|$)",
    message:
      "Agent code reaches records, the rules engine and money only through the gateway " +
      "(src/lib/agent/gateway).",
  },
];

const AI_ONLY = {
  regex: "(^|/)ai(/|$)",
  message: "Only the gateway's screener and the operator turn call the model wrapper.",
};

function agentImportRule(patterns) {
  return {
    paths: [
      { name: "module", message: NO_CREATE_REQUIRE },
      { name: "node:module", message: NO_CREATE_REQUIRE },
    ],
    patterns,
  };
}

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "**/cdk.out/**",
      "next-env.d.ts",
    ],
  },
  // The agent reads, explains and proposes; it never moves money. Three blocks, later ones
  // narrowing earlier ones for the files they name:
  //   1. All agent code (src/lib/agent, src/app/api/agent) may not import the database, the
  //      record readers, the rules engine, the model wrapper, money/ or adapters/ at all. Those
  //      are reached only through the gateway, so every tool call takes the gateway's checks.
  //   2. The gateway (src/lib/agent/gateway) may import those, except the money executor, the
  //      approval, the ledger writes, the reconcile pass and the payment and accounting
  //      adapters: under money/ and adapters/ each pattern is an allowlist, so any path with that
  //      segment is refused unless the rest is exactly a ledger read module (money/read, types,
  //      keys, format), adapters/types or a module of adapters/tms. "money/./execute",
  //      "money//execute" and "money/read/../ledger" are refused too.
  //   3. The operator turn may also call the model wrapper.
  // Every block refuses dynamic import and every module loader by name, so each dependency is
  // checked statically. Matching ignores case (case-insensitive file systems). A re-export from
  // a file outside these folders is not caught here; the import-boundary test walks those.
  {
    files: ["src/lib/agent/**", "src/app/api/agent/**"],
    rules: {
      "no-restricted-imports": ["error", agentImportRule([...GATEWAY_ONLY, AI_ONLY])],
      "no-restricted-syntax": ["error", ...NO_DYNAMIC_LOADING],
    },
  },
  {
    files: ["src/lib/agent/gateway/**"],
    rules: {
      "no-restricted-imports": ["error", agentImportRule(LEDGER_WRITES)],
    },
  },
  {
    files: ["src/lib/agent/operator/turn.ts"],
    rules: {
      "no-restricted-imports": ["error", agentImportRule(GATEWAY_ONLY)],
    },
  },
];

export default eslintConfig;
