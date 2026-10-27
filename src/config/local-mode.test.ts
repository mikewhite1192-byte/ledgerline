import { describe, expect, it } from "vitest";
import { localHooksAllowed } from "./local-mode";

describe("localHooksAllowed", () => {
  it("allows the local hooks only off Aurora and outside a production build", () => {
    expect(localHooksAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(localHooksAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(localHooksAllowed({ NODE_ENV: "development", DB_CLUSTER_ARN: "" })).toBe(true);
  });

  it("is off in a production build", () => {
    expect(localHooksAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("is off whenever an Aurora cluster is configured, in any mode", () => {
    const arn = "arn:aws:rds:us-east-2:000000000000:cluster:example";
    expect(localHooksAllowed({ NODE_ENV: "development", DB_CLUSTER_ARN: arn })).toBe(false);
    expect(localHooksAllowed({ NODE_ENV: "test", DB_CLUSTER_ARN: arn })).toBe(false);
  });
});
