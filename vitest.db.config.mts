import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database tests: run against a database built fresh from db/migrations (npm run test:db:fresh
// locally; CI migrates its new Postgres service first). Serial: they share one database.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.db.test.ts", "scripts/**/*.db.test.ts"],
    fileParallelism: false,
  },
});
