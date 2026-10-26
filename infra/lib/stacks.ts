import { Tags, type App, type Environment } from "aws-cdk-lib";
import { AuthStack } from "./auth-stack";
import { DataStack } from "./data-stack";
import { HostingStack } from "./hosting-stack";

export const PROJECT_TAG = { key: "project", value: "payday-copilot" };

// The whole app: data and auth first, then hosting, which reads their outputs. Every stack and
// every resource carries the project tag (cdk.json sets explicitStackTags, so stack tags are
// given here explicitly as well as on the app).
export function addStacks(app: App, env: Environment) {
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
  });
  hosting.addStackDependency(data);
  hosting.addStackDependency(auth);
  return { data, auth, hosting };
}
