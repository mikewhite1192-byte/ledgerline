import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database tests: run against a database built fresh from db/migrations.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.db.test.ts"],
    passWithNoTests: true,
    fileParallelism: false,
  },
});
