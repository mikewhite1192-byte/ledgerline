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
  // accounting adapters, by static import, dynamic import or require. Ledger reads
  // (money/read, types, keys, format) and the TMS reads stay open to it.
  {
    files: ["src/lib/agent/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)money/(execute|approval|ledger|reconcile)(\\.[cm]?[jt]s)?$",
              message: "Agent code proposes only; a person approves and the executor moves money.",
            },
            {
              regex: "(^|/)money(/index(\\.[cm]?[jt]s)?)?$",
              message: "Import the ledger read module you need (money/read, types, keys, format).",
            },
            {
              regex: "(^|/)adapters(/index(\\.[cm]?[jt]s)?)?$",
              message: "Agent code may use adapters/types and adapters/tms only.",
            },
            {
              regex: "(^|/)adapters/(payment|accounting)(/|$)",
              message: "Agent code never calls a payment or accounting adapter.",
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
          selector: "CallExpression[callee.name='require']",
          message: "No require in agent code: every dependency is checked statically.",
        },
      ],
    },
  },
];

export default eslintConfig;
