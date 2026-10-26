import { App } from "aws-cdk-lib";
import { addStacks } from "../lib/stacks";

const app = new App();

// The account comes from the deploying credentials; never hardcode an account id.
// Deploy order: PaydayCopilotData and PaydayCopilotAuth, then PaydayCopilotHosting.
addStacks(app, { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-2" });
