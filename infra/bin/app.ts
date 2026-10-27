import { App } from "aws-cdk-lib";
import { addStacks } from "../lib/stacks";

const app = new App();

// The account comes from the deploying credentials; never hardcode an account id.
// Deploy order: PaydayCopilotData and PaydayCopilotAuth, then PaydayCopilotHosting.
// The QuickBooks and Stripe test settings are exported in the deploying shell (never written to a
// tracked file). Every hosting deploy sets the branch's variables whole, so a deploy without them
// removes them from the branch: export them for every hosting deploy once they are in use.
const set = (name: string) => process.env[name]?.trim() || undefined;
addStacks(
  app,
  { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-2" },
  {
    qboClientId: set("QBO_CLIENT_ID"),
    qboRedirectUri: set("QBO_REDIRECT_URI"),
    qboAllowedRealmId: set("QBO_ALLOWED_REALM_ID"),
    stripeTestDestinationAccount: set("STRIPE_TEST_DESTINATION_ACCOUNT"),
  },
);
