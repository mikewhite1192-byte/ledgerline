import { describe, expect, it } from "vitest";
import { arnIsIn } from "./aws-account";

const ACCOUNT = "000000000000";

describe("arnIsIn", () => {
  it("accepts an ARN in the account and region", () => {
    expect(arnIsIn(`arn:aws:rds:us-east-2:${ACCOUNT}:cluster:x`, ACCOUNT, "us-east-2")).toBe(true);
    expect(
      arnIsIn(`arn:aws:secretsmanager:us-east-2:${ACCOUNT}:secret:a/b-Xy12`, ACCOUNT, "us-east-2"),
    ).toBe(true);
  });

  it("compares whole fields, never a suffix or prefix", () => {
    expect(arnIsIn("arn:aws:rds:us-east-2:100000000000:cluster:x", ACCOUNT, "us-east-2")).toBe(false);
    expect(arnIsIn(`arn:aws:rds:us-east-2:${ACCOUNT}0:cluster:x`, ACCOUNT, "us-east-2")).toBe(false);
    expect(arnIsIn(`arn:aws:rds:us-west-2:${ACCOUNT}:cluster:x`, ACCOUNT, "us-east-2")).toBe(false);
    expect(arnIsIn(`cluster:${ACCOUNT}`, ACCOUNT, "us-east-2")).toBe(false);
  });
});
