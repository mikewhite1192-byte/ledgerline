import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

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
  // The agent reads, explains and proposes; it never moves money. Agent code may not reach the
  // money executor, the approval, the ledger writes, the reconcile pass or the payment and
  // accounting adapters, by static import, dynamic import, require or createRequire. Under
  // money/ and adapters/ each pattern is an allowlist: any path with that segment is refused
  // unless the rest is exactly a ledger read module (money/read, types, keys, format), or
  // adapters/types or a module of adapters/tms, so "money/./execute", "money//execute" and
  // "money/read/../ledger" are refused too. Matching ignores case (case-insensitive file
  // systems). A re-export from a file outside these folders is not caught here; review it.
  {
    files: ["src/lib/agent/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "module",
              message: "No createRequire in agent code: every dependency is checked statically.",
            },
            {
              name: "node:module",
              message: "No createRequire in agent code: every dependency is checked statically.",
            },
          ],
          patterns: [
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
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "No dynamic imports in agent code: every dependency is checked statically.",
        },
        {
          // The name itself, so an alias (const r = require) is refused like a direct call.
          selector: "Identifier[name='require']",
          message: "No require in agent code: every dependency is checked statically.",
        },
        {
          // process.getBuiltinModule("node:module") reaches createRequire with no import, and
          // destructuring, an alias or a computed key hides that name, so the way in is banned
          // instead: by name, or as a quoted key. It only returns Node's own modules; agent code
          // has no use for it. A name built at run time is not caught here; review it.
          selector: "Identifier[name='getBuiltinModule']",
          message: "No getBuiltinModule in agent code: it reaches createRequire with no import.",
        },
        {
          selector: "Literal[value='getBuiltinModule']",
          message: "No getBuiltinModule in agent code: it reaches createRequire with no import.",
        },
      ],
    },
  },
];

export default eslintConfig;
