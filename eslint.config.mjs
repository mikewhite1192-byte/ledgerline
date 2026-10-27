import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const NO_CREATE_REQUIRE = "No createRequire in agent code: every dependency is checked statically.";

const NO_DYNAMIC_LOADING = [
  {
    selector: "ImportExpression",
    message: "No dynamic imports in agent code: every dependency is checked statically.",
  },
  {
    selector: "CallExpression[callee.name='require']",
    message: "No require in agent code: every dependency is checked statically.",
  },
  {
    // process.getBuiltinModule("node:module").createRequire needs no import.
    selector: "MemberExpression[property.name='createRequire']",
    message: NO_CREATE_REQUIRE,
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
  // Every block refuses dynamic import, require and createRequire, so each dependency is
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
