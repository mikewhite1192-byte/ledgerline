import { App } from "aws-cdk-lib";
import { moneySettingsFromEnv } from "../lib/hosting-stack";
import { addStacks } from "../lib/stacks";

const app = new App();

// The account comes from the deploying credentials; never hardcode an account id.
// Deploy order: PaydayCopilotData and PaydayCopilotAuth, then PaydayCopilotHosting.
// The QuickBooks and Stripe test settings are exported in the deploying shell (never written to a
// tracked file). Every hosting deploy sets the branch's variables whole, so a deploy without them
// would remove them from the branch, and once accounting is on every request would then fail while
// Amplify shows green. So synth (any cdk command) is refused unless all four are exported:
// QBO_CLIENT_ID, QBO_REDIRECT_URI, QBO_ALLOWED_REALM_ID and STRIPE_TEST_DESTINATION_ACCOUNT. To
// deploy with fewer on purpose, set MONEY_SETTINGS=none: exactly the ones exported reach the branch
// and the rest are removed from it.
addStacks(
  app,
  { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-2" },
  moneySettingsFromEnv(process.env),
);
