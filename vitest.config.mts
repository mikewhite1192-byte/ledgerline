import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests: no database, no network. Infra tests synthesize CDK templates locally, no AWS calls.
// Component tests (*.test.tsx) opt into a DOM per file with `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "infra/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/*.db.test.ts", "**/node_modules/**", "**/cdk.out/**"],
  },
});
