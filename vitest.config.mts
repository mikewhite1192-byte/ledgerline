import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests: no database, no network. Infra tests synthesize CDK templates locally, no AWS calls.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts", "infra/**/*.test.ts"],
    exclude: ["**/*.db.test.ts", "**/node_modules/**", "**/cdk.out/**"],
  },
});
