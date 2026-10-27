import { describe, expect, it } from "vitest";
import { portalOrigin, recordDir, runnerMode } from "./config";

describe("runner config", () => {
  it("runs inline only where the app is not deployed", () => {
    expect(runnerMode({})).toBe("inline");
    expect(runnerMode({ PORTAL_RUNNER_MODE: "inline" })).toBe("inline");
    expect(runnerMode({ DB_CLUSTER_ARN: "arn:aws:rds:us-east-2:000000000000:cluster:x" })).toBeNull();
    expect(runnerMode({ NODE_ENV: "production" })).toBeNull();
  });

  it("has no runner for lambda yet, nor for an unknown mode", () => {
    expect(runnerMode({ PORTAL_RUNNER_MODE: "lambda", PORTAL_RUNNER_FUNCTION_NAME: "runner" })).toBeNull();
    expect(runnerMode({ PORTAL_RUNNER_MODE: "thread" })).toBeNull();
  });

  it("reads the portal origin whole, local default only when not deployed", () => {
    expect(portalOrigin({})).toBe("http://localhost:3000");
    expect(portalOrigin({ NODE_ENV: "production" })).toBeNull();
    expect(portalOrigin({ NODE_ENV: "production", PORTAL_BASE_URL: "https://app.example.test/portal" })).toBe("https://app.example.test");
    expect(portalOrigin({ PORTAL_BASE_URL: "file:///etc/passwd" })).toBeNull();
    expect(portalOrigin({ PORTAL_BASE_URL: "https://user:pw@app.example.test" })).toBeNull();
    expect(portalOrigin({ PORTAL_BASE_URL: "not a url" })).toBeNull();
  });

  it("records video only locally, never in tests", () => {
    expect(recordDir({ PORTAL_RECORD_DIR: "/tmp/runs" })).toBe("/tmp/runs");
    expect(recordDir({ PORTAL_RECORD_DIR: "/tmp/runs", NODE_ENV: "test" })).toBeNull();
    expect(recordDir({ PORTAL_RECORD_DIR: "/tmp/runs", NODE_ENV: "production" })).toBeNull();
  });
});
