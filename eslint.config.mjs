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
// no use for any of them. The limit: a name put together at run time (process["getBuiltin" +
// "Module"]) is caught neither here nor by the import-boundary test, which sees names only as
// written. Code run from a string (eval, new Function, a string to setTimeout, the vm module) is
// refused by NO_STRING_CODE and NO_VM below; any other name assembled at run time is left to review.
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

// No code from a string in agent code: eval, new Function and a string to setTimeout, setInterval
// or execScript.
const NO_STRING_CODE = {
  "no-eval": "error",
  "no-new-func": "error",
  "no-implied-eval": "error",
};
// Nor the vm module, which runs a string as code with no eval in sight. Refused in every block.
const NO_VM = {
  regex: "^(node:)?vm(/|$)",
  message: "No vm module in agent code: it runs a string as code, and agent code runs none.",
};

// No network connection of its own in agent code: fetch, XMLHttpRequest, WebSocket and
// EventSource are refused bare and through globalThis, window, self or global. The model wrapper
// (src/lib/ai), outside these folders, makes every outside call.
const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];
const NO_NETWORK_MESSAGE =
  "Agent code opens no network connection of its own: fetch, XMLHttpRequest, WebSocket and " +
  "EventSource are refused, and every outside call goes through the model wrapper (src/lib/ai).";
const NO_NETWORK = {
  "no-restricted-globals": [
    "error",
    ...NETWORK_GLOBALS.map((name) => ({ name, message: NO_NETWORK_MESSAGE })),
  ],
  "no-restricted-properties": [
    "error",
    ...["globalThis", "window", "self", "global"].flatMap((object) =>
      NETWORK_GLOBALS.map((property) => ({ object, property, message: NO_NETWORK_MESSAGE })),
    ),
  ],
};

// The ledger's own rule: nothing in agent code reaches a money write or a vendor adapter.
const LEDGER_WRITES = [
  {
    regex: "(^|/)money/(?!(read|types|keys|format)(\\.[cm]?[jt]s)?$)",
    message:
      "Agent code proposes only; a person approves and the executor moves money. " +
      "From money/ it may import read, types, keys and format.",
  },
  {
    // rules-engine/money is the engine's cents math, not the ledger: the gateway uses the engine
    // (design 3.5), and the import-boundary test allows it too.
    regex: "(^|/)(?<!(?:^|/)rules-engine/)money(\\.[cm]?[jt]s)?$",
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
  {
    // factoring/ holds the executor that submits to the factoring partner; the gateway may read
    // requests and papers, say them in words and size a card, never submit or check one. The
    // simulated partner under adapters/factoring is refused by the adapters rule above.
    regex: "(^|/)(?<!(?:^|/)adapters/)factoring/(?!(read|packet|words|propose)(\\.[cm]?[jt]s)?$)",
    message:
      "Agent code proposes only; a person approves and the executor submits to the factoring " +
      "partner. From factoring/ it may import read, packet, words and propose.",
  },
  {
    // rules-engine/factoring is the engine's factoring math, not the executor.
    regex: "(^|/)(?<!(?:^|/)rules-engine/)factoring(\\.[cm]?[jt]s)?$",
    message: "Import the factoring read module you need (factoring/read, packet, words, propose).",
  },
  {
    // A money code is issued and revealed only after a person approves it: the gateway may read
    // codes and their words, never the executor, the reveal or the request form.
    regex: "(^|/)money-codes/(?!(read|words|switches)(\\.[cm]?[jt]s)?$)",
    message:
      "Agent code never issues or reveals a money code; from money-codes/ it may import read, " +
      "words and switches.",
  },
  {
    regex: "(^|/)money-codes$",
    message: "Import the money-codes module you need (read, words, switches).",
  },
];

// Uploaded documents: agent code may use the shapes, the strict schema and the record comparison
// (documents/types, schema, match, candidates), never the upload, the store or the model read.
const DOCUMENT_READS = [
  {
    regex: "(^|/)documents/(?!(types|schema|match|candidates)(\\.[cm]?[jt]s)?$)",
    message:
      "Agent code never uploads, stores or reads a document with the model; from documents/ it " +
      "may import types, schema, match and candidates.",
  },
  {
    regex: "(^|/)documents$",
    message: "Import the documents module you need (types, schema, match, candidates).",
  },
];

// Outside the gateway, agent code reaches records, the engine and money only by tool calls.
const GATEWAY_ONLY = [
  {
    regex: "(^|/)(db|data|rules-engine|money|money-codes|adapters|factoring)(/|$)",
    message:
      "Agent code reaches records, the rules engine and money only through the gateway " +
      "(src/lib/agent/gateway).",
  },
];

// Outside the gateway, agent code opens no connection of its own: no database driver, AWS SDK,
// child process, worker, socket or file access. The import-boundary test does not walk packages,
// so this is their check. The gateway, which holds the database, is not under this rule.
const NO_DIRECT_IO_MESSAGE =
  "Agent code outside the gateway opens no database, AWS, process, network or file connection; " +
  "it reaches records only through the gateway (src/lib/agent/gateway).";
const NO_DIRECT_IO = [
  { regex: "^pg(-[\\w.-]+)?(/|$)", message: NO_DIRECT_IO_MESSAGE },
  { regex: "^@aws-sdk/", message: NO_DIRECT_IO_MESSAGE },
  {
    regex: "^(node:)?(child_process|worker_threads|http|https|http2|net|tls|dgram|dns|fs)(/|$)",
    message: NO_DIRECT_IO_MESSAGE,
  },
];

const AI_ONLY = {
  regex: "(^|/)ai(/|$)",
  message: "Only the gateway's screener, the operator turn and the auditor run call the model wrapper.",
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
  //      are reached only through the gateway, so every tool call takes the gateway's checks. Nor
  //      may it import a database driver, the AWS SDK, or a process, network or file package.
  //   2. The gateway (src/lib/agent/gateway) may import those, except the money executor, the
  //      approval, the ledger writes, the reconcile pass and the payment and accounting
  //      adapters: under money/ and adapters/ each pattern is an allowlist, so any path with that
  //      segment is refused unless the rest is exactly a ledger read module (money/read, types,
  //      keys, format), adapters/types or a module of adapters/tms; under money-codes/ only read,
  //      words and switches pass. "money/./execute",
  //      "money//execute" and "money/read/../ledger" are refused too. rules-engine/money, the
  //      engine's cents math, is not the ledger and is allowed.
  //   3. The operator turn, the auditor run and the sweep's explanation may also call the model
  //      wrapper; the package rule of 1 still holds.
  // Every block refuses dynamic import, every module loader by name and code from a string (vm
  // included), so each dependency is checked statically, and every block refuses fetch,
  // XMLHttpRequest, WebSocket and EventSource, bare or through globalThis, window, self or global
  // (an alias of the global object is left to review). Every block also limits documents/ to
  // types, schema, match and candidates: no upload, store or model read. Matching ignores case
  // (case-insensitive file systems).
  // A re-export from a file outside these folders is not caught here; the import-boundary test
  // walks those.
  {
    files: ["src/lib/agent/**", "src/app/api/agent/**"],
    rules: {
      "no-restricted-imports": ["error", agentImportRule([...GATEWAY_ONLY, AI_ONLY, ...NO_DIRECT_IO, ...DOCUMENT_READS, NO_VM])],
      "no-restricted-syntax": ["error", ...NO_DYNAMIC_LOADING],
      ...NO_STRING_CODE,
      ...NO_NETWORK,
    },
  },
  // The two blocks below set only no-restricted-imports, so they keep every other rule above.
  {
    files: ["src/lib/agent/gateway/**"],
    rules: {
      "no-restricted-imports": ["error", agentImportRule([...LEDGER_WRITES, ...DOCUMENT_READS, NO_VM])],
    },
  },
  {
    files: ["src/lib/agent/operator/turn.ts", "src/lib/agent/auditor/run.ts", "src/lib/agent/sweep/explain.ts"],
    rules: {
      "no-restricted-imports": ["error", agentImportRule([...GATEWAY_ONLY, ...NO_DIRECT_IO, ...DOCUMENT_READS, NO_VM])],
    },
  },
];

export default eslintConfig;
