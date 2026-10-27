import { SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CfnApp, CfnBranch } from "aws-cdk-lib/aws-amplify";
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export const REPOSITORY_URL = "https://github.com/mikewhite1192-byte/payday-copilot";
export const GITHUB_TOKEN_SECRET_NAME = "payday-copilot/github-token";
// Model API keys, stored by hand (each holds the raw key as its secret string). The server reads
// them by name; the branch variables carry only the names.
export const META_API_KEY_SECRET_NAME = "payday-copilot/meta-api-key";
export const BASETEN_API_KEY_SECRET_NAME = "payday-copilot/baseten-api-key";
// The highest a spend cap may be set, in cents ($400). The $150 Meta credit is spent first and the
// card on file covers the rest, up to the cap. The caps are the only real stop (Meta's spend limit
// only notifies), so a cap above this is refused at synth and by the app (CAP_CEILING_CENTS in
// src/lib/ai/prices.ts, kept equal).
export const AI_CAP_CEILING_CENTS = 40_000;

// The Data API calls the SSR code makes. Nothing else on the cluster, and never the admin secret.
export const DATA_API_ACTIONS = [
  "rds-data:BeginTransaction",
  "rds-data:CommitTransaction",
  "rds-data:RollbackTransaction",
  "rds-data:ExecuteStatement",
  "rds-data:BatchExecuteStatement",
];

// Values are ARNs, ids, model ids, secret names and the spend caps, never secrets. amplify.yml
// copies them into .env.production at build time so the Next.js server can read them.
export const BRANCH_ENV_NAMES = [
  "DB_CLUSTER_ARN",
  "DB_SECRET_ARN",
  "DB_NAME",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "AI_SPEND_CAP_CENTS",
  "AI_WONDER_CAP_CENTS",
  "META_MODEL_SPARK",
  "META_MODEL_WONDER",
  "META_MODEL_VOICE",
  "META_MODEL_IMAGE",
  "META_MODEL_SAM",
  "META_API_KEY_SECRET_NAME",
  "BASETEN_MODEL_ID",
  "BASETEN_API_KEY_SECRET_NAME",
];

// The exact Meta model id for each slot, as GET /v1/models lists it.
export type MetaModels = {
  spark: string;
  wonder: string;
  voice: string;
  image: string;
  sam: string;
};

export type HostingStackProps = StackProps & {
  clusterArn: string;
  appSecret: ISecret;
  dbName: string;
  userPoolId: string;
  userPoolClientId: string;
  // The app refuses every model call once spent plus reserved would pass this.
  aiSpendCapCents: number;
  // Muse Wonder's own stop inside the cap above.
  aiWonderCapCents: number;
  metaModels: MetaModels;
  basetenModelId: string;
};

// Amplify Hosting for the Next.js app. No inline build spec: Amplify reads amplify.yml from the
// repo. A merge to main builds and deploys production.
export class HostingStack extends Stack {
  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    const { account, partition, region } = Stack.of(this);
    const cap = props.aiSpendCapCents;
    if (!Number.isInteger(cap) || cap < 1 || cap > AI_CAP_CEILING_CENTS) {
      throw new Error(`aiSpendCapCents must be a whole number from 1 to ${AI_CAP_CEILING_CENTS}`);
    }
    const wonderCap = props.aiWonderCapCents;
    if (!Number.isInteger(wonderCap) || wonderCap < 1 || wonderCap > cap) {
      throw new Error("aiWonderCapCents must be a whole number from 1 to aiSpendCapCents");
    }

    // Amplify's service role, used here only to write SSR logs to CloudWatch. Amplify's docs list
    // these four actions. DescribeLogGroups is a list call, scoped the way AWS's own Amplify policy
    // scopes it (every log group), but to this account and region only. The app id is not in
    // the policy (the app refers to this role, so naming the app here would be a cycle);
    // apps/* in this account is the confused-deputy guard Amplify's docs recommend.
    const logGroupArn = `arn:${partition}:logs:${region}:${account}:log-group`;
    const serviceRole = new Role(this, "ServiceRole", {
      description: "Amplify writes this app's SSR logs to CloudWatch",
      assumedBy: new ServicePrincipal("amplify.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:${partition}:amplify:${region}:${account}:apps/*` },
        },
      }),
      inlinePolicies: {
        "ssr-logs": new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["logs:CreateLogGroup"],
              resources: [`${logGroupArn}:/aws/amplify/*`],
            }),
            new PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [`${logGroupArn}:/aws/amplify/*:log-stream:*`],
            }),
            new PolicyStatement({
              actions: ["logs:DescribeLogGroups"],
              resources: [`${logGroupArn}:*`],
            }),
          ],
        }),
      },
    });

    const app = new CfnApp(this, "App", {
      name: "payday-copilot",
      platform: "WEB_COMPUTE",
      repository: REPOSITORY_URL,
      // A Secrets Manager dynamic reference: the template holds only the reference, and
      // CloudFormation resolves the token at deploy time. The first deploy goes in this order:
      // 1) install the Amplify GitHub App for the deploy region on this repository only:
      //    https://github.com/apps/aws-amplify-us-east-2/installations/new
      // 2) store a GitHub classic token with only the admin:repo_hook scope in Secrets Manager
      //    under GITHUB_TOKEN_SECRET_NAME;
      // 3) npm run cdk -- deploy.
      accessToken: SecretValue.secretsManager(GITHUB_TOKEN_SECRET_NAME).unsafeUnwrap(),
      iamServiceRole: serviceRole.roleArn,
    });

    // The model API keys, by exact name. fromSecretNameV2 gives the ARN without the suffix
    // Secrets Manager appends to every secret ARN ("-" and six random characters), so "-??????"
    // (exactly six, one per "?") is the narrowest pattern that matches the named secret and no
    // other. It is what grantRead would use, but inline and with GetSecretValue only.
    // A grant on a secret that does not exist yet is valid IAM; the Baseten one waits for its key.
    const modelKeyArns = [
      Secret.fromSecretNameV2(this, "MetaApiKey", META_API_KEY_SECRET_NAME),
      Secret.fromSecretNameV2(this, "BasetenApiKey", BASETEN_API_KEY_SECRET_NAME),
    ].map((secret) => `${secret.secretArn}-??????`);

    // The SSR runtime's credentials: the Data API on this cluster, the app's own database login
    // and the two model API keys, nothing else. No Cognito permission is needed (sign-in is an
    // unauthenticated API). Set on the branch, not the app, as Amplify recommends for a public
    // repository. Amplify may assume it only for this account and this app's main branch; the
    // app does not refer to this role, so naming the app here is no cycle.
    const branchName = "main";
    const appArn = `arn:${partition}:amplify:${region}:${account}:apps/${app.attrAppId}`;
    const computeRole = new Role(this, "ComputeRole", {
      description: "Payday Copilot SSR runtime: Data API, the app database login and model keys",
      assumedBy: new ServicePrincipal("amplify.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnEquals: { "aws:SourceArn": `${appArn}/branches/${branchName}` },
        },
      }),
      inlinePolicies: {
        data: new PolicyDocument({
          statements: [
            new PolicyStatement({ actions: DATA_API_ACTIONS, resources: [props.clusterArn] }),
            new PolicyStatement({
              actions: ["secretsmanager:GetSecretValue"],
              resources: [props.appSecret.secretArn, ...modelKeyArns],
            }),
          ],
        }),
      },
    });

    const env: Record<string, string> = {
      DB_CLUSTER_ARN: props.clusterArn,
      DB_SECRET_ARN: props.appSecret.secretArn,
      DB_NAME: props.dbName,
      COGNITO_USER_POOL_ID: props.userPoolId,
      COGNITO_CLIENT_ID: props.userPoolClientId,
      AI_SPEND_CAP_CENTS: String(cap),
      AI_WONDER_CAP_CENTS: String(wonderCap),
      META_MODEL_SPARK: props.metaModels.spark,
      META_MODEL_WONDER: props.metaModels.wonder,
      META_MODEL_VOICE: props.metaModels.voice,
      META_MODEL_IMAGE: props.metaModels.image,
      META_MODEL_SAM: props.metaModels.sam,
      META_API_KEY_SECRET_NAME,
      BASETEN_MODEL_ID: props.basetenModelId,
      BASETEN_API_KEY_SECRET_NAME,
    };

    new CfnBranch(this, "MainBranch", {
      appId: app.attrAppId,
      branchName,
      stage: "PRODUCTION",
      framework: "Next.js - SSR",
      enableAutoBuild: true,
      // Off: Amplify refuses SSR PR previews on a public repo (outside code would run as our role).
      enablePullRequestPreview: false,
      computeRoleArn: computeRole.roleArn,
      environmentVariables: BRANCH_ENV_NAMES.map((name) => ({ name, value: env[name] })),
    });
  }
}
