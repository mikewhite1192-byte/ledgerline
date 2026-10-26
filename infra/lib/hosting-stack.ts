import { SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CfnApp, CfnBranch } from "aws-cdk-lib/aws-amplify";
import type { Construct } from "constructs";

export const REPOSITORY_URL = "https://github.com/mikewhite1192-byte/payday-copilot";
export const GITHUB_TOKEN_SECRET_NAME = "payday-copilot/github-token";

// Amplify Hosting for the Next.js app. No inline build spec: Amplify reads amplify.yml from the
// repo. A merge to main builds and deploys production; each PR gets a preview.
export class HostingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const app = new CfnApp(this, "App", {
      name: "payday-copilot",
      platform: "WEB_COMPUTE",
      repository: REPOSITORY_URL,
      // A Secrets Manager dynamic reference: the template holds only the reference, and
      // CloudFormation resolves the token at deploy time.
      accessToken: SecretValue.secretsManager(GITHUB_TOKEN_SECRET_NAME).unsafeUnwrap(),
    });

    new CfnBranch(this, "MainBranch", {
      appId: app.attrAppId,
      branchName: "main",
      stage: "PRODUCTION",
      framework: "Next.js - SSR",
      enableAutoBuild: true,
      enablePullRequestPreview: true,
    });
  }
}
