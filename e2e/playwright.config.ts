import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { APP_PORT, APP_URL, appEnv, FAKE_HOST, REPO_ROOT } from "./env.local-mode";

// Two projects. "local" (npm run e2e): the fake host (model replay and sign-in), then next dev on
// the seeded throwaway database with the local overrides; nothing leaves the machine. "deployed"
// (npm run e2e:deployed): the site at E2E_BASE_URL with the demo login from the environment, no
// servers started here. Chromium only, no retries: a red run is a real failure.

const DEPLOYED = process.env.E2E_TARGET === "deployed";

// One report per day, named by the date in New York (the deadlines' time zone).
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
// E2E_REPORT_FILE (CI) is read from the repository root.
const reportFile = resolve(REPO_ROOT, process.env.E2E_REPORT_FILE || join("docs", "nightly", `demo-path-${today}.json`));

export default defineConfig({
  testDir: ".",
  testMatch: "demo-path.spec.ts",
  outputDir: join(REPO_ROOT, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // The first visit to each page compiles it under next dev.
  timeout: 6 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: reportFile }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
  },
  projects: [
    { name: "local", use: { baseURL: APP_URL } },
    { name: "deployed", use: { baseURL: process.env.E2E_BASE_URL } },
  ],
  webServer: DEPLOYED
    ? undefined
    : [
        {
          name: "fake host",
          command: "npx tsx e2e/fake-host.ts",
          cwd: REPO_ROOT,
          url: `${FAKE_HOST}/health`,
          reuseExistingServer: false,
          timeout: 30_000,
          stdout: "pipe",
          stderr: "pipe",
          // Recording reads the real key here, in this process only; next dev never sees it.
          env: { E2E_RECORD: process.env.E2E_RECORD ?? "" },
          // SIGTERM first, so the fake host removes the local key file on the way out.
          gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
        },
        {
          name: "app",
          command: `npx next dev --hostname 127.0.0.1 --port ${APP_PORT}`,
          cwd: REPO_ROOT,
          url: `${APP_URL}/api/health`,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: "pipe",
          stderr: "pipe",
          env: appEnv(),
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        },
      ],
});
