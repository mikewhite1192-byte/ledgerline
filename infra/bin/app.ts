import { App } from "aws-cdk-lib";
import { HostingStack } from "../lib/hosting-stack";

const app = new App();

// The account comes from the deploying credentials; never hardcode an account id.
new HostingStack(app, "PaydayCopilotHosting", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-2" },
});
