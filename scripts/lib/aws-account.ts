import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

// Everything this project runs lives in one region.
export const REGION = "us-east-2";

// Laptop scripts that write to AWS run only against the one account they are meant for. The
// expected id comes from the environment (never from a tracked file), is compared whole with
// the caller's identity, and every ARN the script was given must sit in that account and region.
// Nothing here prints the id.
export async function assertAccount(arns: string[]): Promise<void> {
  const expected = process.env.EXPECTED_AWS_ACCOUNT_ID ?? "";
  if (!/^\d{12}$/.test(expected)) {
    throw new Error("set EXPECTED_AWS_ACCOUNT_ID to the 12-digit id of the project's account");
  }
  const sts = new STSClient({ region: REGION });
  try {
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    if (Account !== expected) throw new Error("these AWS credentials belong to another account");
  } finally {
    sts.destroy();
  }
  for (const arn of arns) {
    if (!arnIsIn(arn, expected, REGION)) {
      throw new Error("an ARN in the environment is not in the expected account and region");
    }
  }
}

// arn:partition:service:region:account:resource, compared field by field.
export function arnIsIn(arn: string, account: string, region: string): boolean {
  const parts = arn.split(":");
  return parts.length >= 6 && parts[0] === "arn" && parts[3] === region && parts[4] === account;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
