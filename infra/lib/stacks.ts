import { Tags, type App, type Environment } from "aws-cdk-lib";
import { AuthStack } from "./auth-stack";
import { DataStack } from "./data-stack";
import { HostingStack, type MoneySettings } from "./hosting-stack";
import { InboundStack, inboundSettingsFromContext } from "./inbound-stack";
import { SweepStack, type SweepSettings } from "./sweep-stack";

export const PROJECT_TAG = { key: "project", value: "payday-copilot" };

// The whole app: data and auth first, then hosting, which reads their outputs. Every stack and
// every resource carries the project tag (cdk.json sets explicitStackTags, so stack tags are
// given here explicitly as well as on the app). The money settings come from the deploying shell
// (infra/bin/app.ts); unset, the branch carries none of them. The sweep stack (the nightly kicker,
// its key and a schedule that ships disabled) stands alone: the app reads its key by name. The
// inbound mail stack stands alone the same way, and is added only when the deploy passes its zone
// context (INBOUND_ZONE_ID, INBOUND_ZONE_NAME, INBOUND_DOMAIN), so no other deploy needs it.
export function addStacks(app: App, env: Environment, money: MoneySettings = {}, sweep: SweepSettings = {}) {
  const tags = { [PROJECT_TAG.key]: PROJECT_TAG.value };
  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);

  const data = new DataStack(app, "PaydayCopilotData", { env, tags });
  const auth = new AuthStack(app, "PaydayCopilotAuth", { env, tags });
  const hosting = new HostingStack(app, "PaydayCopilotHosting", {
    env,
    tags,
    clusterArn: data.cluster.clusterArn,
    appSecret: data.appSecret,
    dbName: data.dbName,
    userPoolId: auth.userPool.userPoolId,
    userPoolClientId: auth.client.userPoolClientId,
    // $400: the $150 model credit first, then the card on file. Judging reserve (an operating
    // rule, not code): once the demo video is recorded, keep at least $40 of this unspent so
    // judges never hit the cap; the /models page shows the spend. One variable to change.
    aiSpendCapCents: 40_000,
    // $150 of that for Muse Wonder, the auditor.
    aiWonderCapCents: 15_000,
    // Standard tier: Meta does not train on the content.
    metaModels: {
      spark: "muse-spark-1.3",
      wonder: "muse-wonder-1.0",
      voice: "muse-voice-transcribe-1.0",
      image: "muse-image-1.0",
      sam: "sam-3.1",
    },
    basetenModelId: "meta-models/muse-spark-open-1026",
    // The standby host's id for the same model, used only while the fallback switch is on.
    fireworksModelId: "accounts/fireworks/models/muse-spark-open",
    money,
  });
  hosting.addStackDependency(data);
  hosting.addStackDependency(auth);
  const sweepStack = new SweepStack(app, "PaydayCopilotSweep", { env, tags, settings: sweep });
  const inboundSettings = inboundSettingsFromContext((key) => app.node.tryGetContext(key));
  // Left off the result entirely without its context, so a walk over the stacks sees only real ones.
  const inbound: { inbound?: InboundStack } = inboundSettings
    ? { inbound: new InboundStack(app, "PaydayCopilotInbound", { env, tags, settings: inboundSettings }) }
    : {};
  return { data, auth, hosting, sweep: sweepStack, ...inbound };
}
