import { describe, expect, it } from "vitest";
import { localHooksAllowed } from "./local-mode";

describe("localHooksAllowed", () => {
  it("allows the local hooks only off Aurora and in an explicit local mode", () => {
    expect(localHooksAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(localHooksAllowed({ NODE_ENV: "test" })).toBe(true);
    // An empty cluster setting is no cluster: local mode, as the demo-path run sets it.
    expect(localHooksAllowed({ NODE_ENV: "development", DB_CLUSTER_ARN: "" })).toBe(true);
    expect(localHooksAllowed({ NODE_ENV: "test", DB_CLUSTER_ARN: "" })).toBe(true);
  });

  it("is off in a production build", () => {
    expect(localHooksAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(localHooksAllowed({ NODE_ENV: "production", DB_CLUSTER_ARN: "" })).toBe(false);
  });

  it("is off when NODE_ENV is unset or empty, even with no Aurora cluster", () => {
    expect(localHooksAllowed({})).toBe(false);
    expect(localHooksAllowed({ DB_CLUSTER_ARN: "" })).toBe(false);
    expect(localHooksAllowed({ NODE_ENV: "" })).toBe(false);
    expect(localHooksAllowed({ NODE_ENV: undefined, DB_CLUSTER_ARN: undefined })).toBe(false);
  });

  it("is off for any NODE_ENV that is not exactly development or test", () => {
    for (const NODE_ENV of ["staging", "preview", "dev", "Development", "TEST", " test", "development ", "prod"]) {
      expect(localHooksAllowed({ NODE_ENV }), NODE_ENV).toBe(false);
      expect(localHooksAllowed({ NODE_ENV, DB_CLUSTER_ARN: "" }), NODE_ENV).toBe(false);
    }
  });

  it("is off whenever an Aurora cluster is configured, in any mode", () => {
    const arn = "arn:aws:rds:us-east-2:000000000000:cluster:example";
    expect(localHooksAllowed({ NODE_ENV: "development", DB_CLUSTER_ARN: arn })).toBe(false);
    expect(localHooksAllowed({ NODE_ENV: "test", DB_CLUSTER_ARN: arn })).toBe(false);
    expect(localHooksAllowed({ NODE_ENV: "production", DB_CLUSTER_ARN: arn })).toBe(false);
    expect(localHooksAllowed({ DB_CLUSTER_ARN: arn })).toBe(false);
  });
});
