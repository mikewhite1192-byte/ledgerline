import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import {
  AI_CAP_CEILING_CENTS,
  BASETEN_API_KEY_SECRET_NAME,
  BRANCH_ENV_NAMES,
  DATA_API_ACTIONS,
  FIREWORKS_API_KEY_SECRET_NAME,
  GITHUB_TOKEN_SECRET_NAME,
  HostingStack,
  META_API_KEY_SECRET_NAME,
  moneyEnv,
  OPTIONAL_BRANCH_ENV_NAMES,
  QBO_CLIENT_SECRET_NAME,
  QBO_TOKEN_KEY_SECRET_NAME,
  REPOSITORY_URL,
  STRIPE_SECRET_KEY_SECRET_NAME,
  SWEEP_INTERNAL_KEY_SECRET_NAME,
} from "../lib/hosting-stack";
import { asArray, joined, policyStatements, synthAll } from "./synth";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = {
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: unknown;
};

describe("HostingStack", () => {
  let synth: ReturnType<typeof synthAll>;
  let template: Template;

  // Synthesize into a temp folder this test owns, and remove it afterward.
  beforeAll(() => {
    synth = synthAll();
    template = synth.hosting;
  });

  afterAll(() => synth?.cleanup());

  function role(prefix: string): [string, Resource] {
    const found = Object.entries(template.findResources("AWS::IAM::Role")).filter(([id]) =>
      id.startsWith(prefix),
    );
    expect(found).toHaveLength(1);
    return found[0] as [string, Resource];
  }

  function inlineStatements(r: Resource): Statement[] {
    const policies = r.Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[];
    expect(policies).toHaveLength(1);
    return policies[0].PolicyDocument.Statement;
  }

  // Replaces every cross-stack import (Fn::GetStackOutput) with the value its producing stack
  // exports, so a test sees which resource a setting really points at.
  function imported(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(imported);
    if (value === null || typeof value !== "object") return value;
    const get = (value as Record<string, unknown>)["Fn::GetStackOutput"] as
      | { StackName: string; Region: string; OutputName: string }
      | undefined;
    if (!get) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, imported(v)]));
    const producers = [
      [synth.stacks.data, synth.data],
      [synth.stacks.auth, synth.auth],
    ] as const;
    const found = producers.find(([s]) => s.stackName === get.StackName && s.region === get.Region);
    const outputs = found?.[1].toJSON().Outputs as Record<string, { Value: unknown }> | undefined;
    const output = outputs?.[get.OutputName];
    if (!output) throw new Error(`no producer for ${JSON.stringify(get)}`);
    return output.Value;
  }

  it("hosts the repo on the SSR platform with no inline build spec", () => {
    template.hasResourceProperties("AWS::Amplify::App", {
      Platform: "WEB_COMPUTE",
      Repository: REPOSITORY_URL,
      BuildSpec: Match.absent(),
    });
  });

  it("takes the GitHub token only from a Secrets Manager dynamic reference", () => {
    const apps = Object.values(template.findResources("AWS::Amplify::App"));
    expect(apps).toHaveLength(1);
    expect(apps[0].Properties.AccessToken).toBe(
      `{{resolve:secretsmanager:${GITHUB_TOKEN_SECRET_NAME}:SecretString:::}}`,
    );
    expect(JSON.stringify(template.toJSON())).not.toMatch(/ghp_|gho_|github_pat_/);
  });

  it("builds main as production with auto build and no pull request previews", () => {
    template.hasResourceProperties("AWS::Amplify::Branch", {
      BranchName: "main",
      Stage: "PRODUCTION",
      Framework: "Next.js - SSR",
      EnableAutoBuild: true,
      EnablePullRequestPreview: false,
    });
  });

  it("gives the SSR runtime a role only Amplify can assume, for this app's main branch", () => {
    const [, compute] = role("ComputeRole");
    const [appId] = Object.keys(template.findResources("AWS::Amplify::App"));
    expect(compute.Properties.AssumeRolePolicyDocument).toEqual({
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "amplify.amazonaws.com" },
          Condition: {
            StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
            ArnEquals: {
              "aws:SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:amplify:us-east-2:",
                    { Ref: "AWS::AccountId" },
                    ":apps/",
                    { "Fn::GetAtt": [appId, "AppId"] },
                    "/branches/main",
                  ],
                ],
              },
            },
          },
        },
      ],
      Version: "2012-10-17",
    });
  });

  it("lets the runtime call the Data API and read the app secret, the model keys and the money secrets, nothing more", () => {
    const [, compute] = role("ComputeRole");
    const statements = inlineStatements(compute);
    expect(statements).toHaveLength(2);

    const [dataApi, secret] = statements;
    expect([...asArray(dataApi.Action)].sort()).toEqual([...DATA_API_ACTIONS].sort());
    expect(asArray(dataApi.Resource)).toHaveLength(1);
    expect(dataApi.Resource).not.toBe("*");
    expect(JSON.stringify(dataApi.Resource)).toContain("PublishOutputRefCluster");

    expect(secret.Action).toBe("secretsmanager:GetSecretValue");
    // The policy minimizer orders resources, so they are matched by content, not position.
    const resources = asArray(secret.Resource);
    expect(resources).toHaveLength(8);
    const appSecret = resources.filter((r) =>
      JSON.stringify(r).includes("PublishOutputRefAppSecret"),
    );
    expect(appSecret).toHaveLength(1);
    expect(JSON.stringify(secret.Resource)).not.toMatch(/AdminSecret|ClusterSecret/);
    // Each key and secret by its exact name. The only wildcard is the six-character suffix Secrets
    // Manager appends to every secret ARN, one "?" per character.
    const modelKeys = resources
      .filter((r) => r !== appSecret[0])
      .map(joined)
      .sort();
    const secretArn = "arn:aws:secretsmanager:us-east-2:${AWS::AccountId}:secret:";
    expect(modelKeys).toEqual(
      [
        `${secretArn}${META_API_KEY_SECRET_NAME}-??????`,
        `${secretArn}${BASETEN_API_KEY_SECRET_NAME}-??????`,
        `${secretArn}${FIREWORKS_API_KEY_SECRET_NAME}-??????`,
        `${secretArn}${QBO_CLIENT_SECRET_NAME}-??????`,
        `${secretArn}${QBO_TOKEN_KEY_SECRET_NAME}-??????`,
        `${secretArn}${STRIPE_SECRET_KEY_SECRET_NAME}-??????`,
        `${secretArn}${SWEEP_INTERNAL_KEY_SECRET_NAME}-??????`,
      ].sort(),
    );
    for (const arn of modelKeys) expect(arn).not.toContain("*");
  });

  it("has no standalone IAM policy and no statement on every resource", () => {
    expect(Object.keys(template.findResources("AWS::IAM::Policy"))).toHaveLength(0);
    for (const s of policyStatements(template)) {
      expect(asArray(s.Resource)).not.toContain("*");
    }
  });

  it("sets the compute role and the twenty-three fixed server settings on the main branch", () => {
    const [computeId] = role("ComputeRole");
    const branches = Object.values(template.findResources("AWS::Amplify::Branch"));
    expect(branches).toHaveLength(1);
    const props = branches[0].Properties;
    expect(props.ComputeRoleArn).toEqual({ "Fn::GetAtt": [computeId, "Arn"] });
    const vars = props.EnvironmentVariables as { Name: string; Value: unknown }[];
    // No money settings exported, on purpose (MONEY_SETTINGS=none): those four are left off,
    // never sent empty.
    expect(vars.map((e) => e.Name)).toEqual(
      BRANCH_ENV_NAMES.filter((n) => !OPTIONAL_BRANCH_ENV_NAMES.includes(n)),
    );
    expect(BRANCH_ENV_NAMES).toHaveLength(27);
    expect(vars).toHaveLength(23);

    // Each value, followed to the stack that exports it, is the resource it names: the cluster,
    // the app's own database login (never the admin secret), the user pool and its client.
    const value = Object.fromEntries(vars.map((e) => [e.Name, imported(e.Value)]));
    const { data, auth } = synth.stacks;
    expect(value.DB_CLUSTER_ARN).toEqual(data.resolve(data.cluster.clusterArn));
    expect(value.DB_SECRET_ARN).toEqual({ Ref: expect.stringMatching(/^AppSecret/) });
    expect(value.DB_SECRET_ARN).toEqual(data.resolve(data.appSecret.secretArn));
    expect(value.DB_SECRET_ARN).not.toEqual(data.resolve(data.adminSecret.secretArn));
    expect(value.DB_NAME).toBe("payday");
    expect(value.COGNITO_USER_POOL_ID).toEqual(auth.resolve(auth.userPool.userPoolId));
    expect(value.COGNITO_CLIENT_ID).toEqual(auth.resolve(auth.client.userPoolClientId));
    // The spend caps, the model ids and the key secret names are plain values in this stack.
    expect(value).toMatchObject({
      AI_SPEND_CAP_CENTS: "40000",
      AI_WONDER_CAP_CENTS: "15000",
      META_MODEL_SPARK: "muse-spark-1.3",
      META_MODEL_WONDER: "muse-wonder-1.0",
      META_MODEL_VOICE: "muse-voice-transcribe-1.0",
      META_MODEL_IMAGE: "muse-image-1.0",
      META_MODEL_SAM: "sam-3.1",
      META_API_KEY_SECRET_NAME,
      BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
      BASETEN_API_KEY_SECRET_NAME,
      FIREWORKS_MODEL_ID: "accounts/fireworks/models/muse-spark-open",
      FIREWORKS_API_KEY_SECRET_NAME,
      QBO_ENVIRONMENT: "sandbox",
      QBO_MINOR_VERSION: "75",
      QBO_CLIENT_SECRET_NAME,
      QBO_TOKEN_KEY_SECRET_NAME,
      STRIPE_SECRET_KEY_SECRET_NAME,
      SWEEP_INTERNAL_KEY_SECRET_NAME,
    });
    expect(FIREWORKS_API_KEY_SECRET_NAME).toBe("payday-copilot/fireworks-api-key");
    // Names only: no variable carries a key, a token or a secret; the *_SECRET_NAME and
    // *_SECRET_ARN ones carry where a secret is stored.
    expect(
      BRANCH_ENV_NAMES.filter((n) => !/_SECRET_(NAME|ARN)$/.test(n) && /KEY|TOKEN|SECRET|PASSWORD/.test(n)),
    ).toEqual([]);
    for (const raw of [
      "QBO_CLIENT_SECRET",
      "QBO_TOKEN_KEY",
      "STRIPE_SECRET_KEY",
      "META_API_KEY",
      "BASETEN_API_KEY",
      "FIREWORKS_API_KEY",
      "SWEEP_INTERNAL_KEY",
    ]) {
      expect(BRANCH_ENV_NAMES).not.toContain(raw);
    }
  });

  // Made-up values: no real company id, client id or account ever sits in this repo.
  const MONEY = {
    qboClientId: "TESTCLIENT0000000000",
    qboRedirectUri: "https://app.example.com/api/qbo/callback",
    qboAllowedRealmId: "1234567890123456",
    stripeTestDestinationAccount: "acct_TESTDESTINATION01",
  };

  // The same values as the deploying shell exports them.
  const EXPORTED = {
    QBO_CLIENT_ID: MONEY.qboClientId,
    QBO_REDIRECT_URI: MONEY.qboRedirectUri,
    QBO_ALLOWED_REALM_ID: MONEY.qboAllowedRealmId,
    STRIPE_TEST_DESTINATION_ACCOUNT: MONEY.stripeTestDestinationAccount,
  };

  const branchVars = (exported: Record<string, string | undefined>) => {
    const s = synthAll(undefined, exported);
    try {
      const branches = Object.values(s.hosting.findResources("AWS::Amplify::Branch"));
      return branches[0].Properties.EnvironmentVariables as { Name: string; Value: unknown }[];
    } finally {
      s.cleanup();
    }
  };

  const synthRefusal = (exported: Record<string, string | undefined>) => {
    try {
      synthAll(undefined, exported).cleanup();
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  };

  it("refuses to synthesize with no money setting exported, naming all four and how to opt out", () => {
    const message = synthRefusal({});
    expect(message).toMatch(
      /^Refusing to synthesize: QBO_CLIENT_ID, QBO_REDIRECT_URI, QBO_ALLOWED_REALM_ID, STRIPE_TEST_DESTINATION_ACCOUNT are not exported\./,
    );
    expect(message).toContain("MONEY_SETTINGS=none");
    // Blank exports are the same as none.
    expect(synthRefusal({ QBO_CLIENT_ID: "", QBO_REDIRECT_URI: "  " })).toMatch(/^Refusing to synthesize: QBO_CLIENT_ID,/);
  });

  it("refuses a partial set, naming only the missing variables and never a value", () => {
    const partial = { QBO_CLIENT_ID: EXPORTED.QBO_CLIENT_ID, STRIPE_TEST_DESTINATION_ACCOUNT: EXPORTED.STRIPE_TEST_DESTINATION_ACCOUNT };
    const message = synthRefusal(partial);
    expect(message).toMatch(/^Refusing to synthesize: QBO_REDIRECT_URI, QBO_ALLOWED_REALM_ID are not exported\./);
    for (const value of Object.values(partial)) expect(message).not.toContain(value);
    const one = synthRefusal({ ...EXPORTED, QBO_ALLOWED_REALM_ID: undefined });
    expect(one).toMatch(/^Refusing to synthesize: QBO_ALLOWED_REALM_ID is not exported\./);
    for (const value of Object.values(EXPORTED)) expect(one).not.toContain(value);
  });

  it("with MONEY_SETTINGS=none, synthesizes with none or with the ones exported, still checked", () => {
    expect(branchVars({ MONEY_SETTINGS: "none" }).map((e) => e.Name)).toEqual(
      BRANCH_ENV_NAMES.filter((n) => !OPTIONAL_BRANCH_ENV_NAMES.includes(n)),
    );
    const stripeOnly = branchVars({
      MONEY_SETTINGS: "none",
      STRIPE_TEST_DESTINATION_ACCOUNT: EXPORTED.STRIPE_TEST_DESTINATION_ACCOUNT,
    });
    expect(stripeOnly.map((e) => e.Name).filter((n) => OPTIONAL_BRANCH_ENV_NAMES.includes(n))).toEqual([
      "STRIPE_TEST_DESTINATION_ACCOUNT",
    ]);
    // The opt-out never lets a partial QuickBooks set through.
    expect(synthRefusal({ MONEY_SETTINGS: "none", QBO_CLIENT_ID: EXPORTED.QBO_CLIENT_ID })).toMatch(/set together/);
    // Only the exact word opts out.
    for (const word of ["None", "all", "yes"]) {
      expect(synthRefusal({ MONEY_SETTINGS: word }), word).toBe("MONEY_SETTINGS may only be none");
    }
  });

  it("sets the money settings exported at deploy, in order", () => {
    const withMoney = synthAll(undefined, EXPORTED);
    try {
      const branches = Object.values(withMoney.hosting.findResources("AWS::Amplify::Branch"));
      const vars = branches[0].Properties.EnvironmentVariables as { Name: string; Value: unknown }[];
      expect(vars.map((e) => e.Name)).toEqual(BRANCH_ENV_NAMES);
      expect(Object.fromEntries(vars.map((e) => [e.Name, e.Value]))).toMatchObject({
        QBO_CLIENT_ID: MONEY.qboClientId,
        QBO_REDIRECT_URI: MONEY.qboRedirectUri,
        QBO_ALLOWED_REALM_ID: MONEY.qboAllowedRealmId,
        STRIPE_TEST_DESTINATION_ACCOUNT: MONEY.stripeTestDestinationAccount,
      });
    } finally {
      withMoney.cleanup();
    }
  });

  it("refuses partial or malformed money settings, naming the variable only", () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ qboAllowedRealmId: undefined }, /set together/],
      [{ qboClientId: "has space" }, /^QBO_CLIENT_ID/],
      [{ qboRedirectUri: "http://app.example.com/api/qbo/callback" }, /^QBO_REDIRECT_URI/],
      [{ qboRedirectUri: "https://app.example.com/api/qbo/callback?x=1" }, /^QBO_REDIRECT_URI/],
      [{ qboAllowedRealmId: "12345" }, /^QBO_ALLOWED_REALM_ID/],
      [{ stripeTestDestinationAccount: "acct-1" }, /^STRIPE_TEST_DESTINATION_ACCOUNT/],
    ];
    for (const [over, expected] of cases) {
      let message = "";
      try {
        moneyEnv({ ...MONEY, ...over });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(over)).toMatch(expected);
      for (const value of Object.values(over)) if (value) expect(message).not.toContain(value);
    }
    expect(moneyEnv({})).toEqual({});
    expect(moneyEnv({ stripeTestDestinationAccount: MONEY.stripeTestDestinationAccount })).toEqual({
      STRIPE_TEST_DESTINATION_ACCOUNT: MONEY.stripeTestDestinationAccount,
    });
  });

  it("copies exactly the branch variables into the server build, and never a raw key", () => {
    const spec = readFileSync(fileURLToPath(new URL("../../amplify.yml", import.meta.url)), "utf8");
    const copied = [...spec.matchAll(/-e '\^([A-Z_]+)='/g)].map((m) => m[1]);
    // Contributor mode is for synthetic data on a laptop, never the hosted app.
    expect(BRANCH_ENV_NAMES).not.toContain("META_CONTRIBUTOR_MODE");
    expect(spec).not.toContain("META_CONTRIBUTOR_MODE");
    expect(copied).toEqual([
      ...BRANCH_ENV_NAMES.slice(0, 5),
      "AWS_REGION",
      ...BRANCH_ENV_NAMES.slice(5),
    ]);
  });

  // The props a refusal test changes one field of.
  function hostingProps(caps: { aiSpendCapCents: number; aiWonderCapCents: number }) {
    return {
      env: { region: "us-east-2" },
      clusterArn: "arn:aws:rds:us-east-2:000000000000:cluster:test",
      appSecret: synth.stacks.data.appSecret,
      dbName: "payday",
      userPoolId: "pool",
      userPoolClientId: "client",
      ...caps,
      metaModels: {
        spark: "muse-spark-1.3",
        wonder: "muse-wonder-1.0",
        voice: "muse-voice-transcribe-1.0",
        image: "muse-image-1.0",
        sam: "sam-3.1",
      },
      basetenModelId: "meta-models/muse-spark-open-1026",
      fireworksModelId: "accounts/fireworks/models/muse-spark-open",
    };
  }

  it("accepts a spend cap at the ceiling, with a Wonder cap up to it", () => {
    expect(AI_CAP_CEILING_CENTS).toBe(40_000);
    const outdir = mkdtempSync(join(tmpdir(), "payday-hosting-ceiling-test-"));
    try {
      for (const aiWonderCapCents of [15_000, 40_000]) {
        const app = new App({ outdir: join(outdir, String(aiWonderCapCents)) });
        expect(
          () =>
            new HostingStack(
              app,
              "Hosting",
              hostingProps({ aiSpendCapCents: 40_000, aiWonderCapCents }),
            ),
          String(aiWonderCapCents),
        ).not.toThrow();
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("refuses a spend cap that is not a whole number of cents up to the ceiling", () => {
    // An App makes its output folder when it is built, so each one gets a folder this test owns.
    const outdir = mkdtempSync(join(tmpdir(), "payday-hosting-cap-test-"));
    try {
      for (const aiSpendCapCents of [0, -1, 12.5, AI_CAP_CEILING_CENTS + 1, Number.NaN]) {
        const app = new App({ outdir: join(outdir, String(aiSpendCapCents)) });
        expect(
          () =>
            new HostingStack(
              app,
              "Hosting",
              hostingProps({ aiSpendCapCents, aiWonderCapCents: 1 }),
            ),
          String(aiSpendCapCents),
        ).toThrow(/aiSpendCapCents/);
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("refuses a Wonder cap that is not a whole number of cents up to the overall cap", () => {
    const outdir = mkdtempSync(join(tmpdir(), "payday-hosting-wonder-cap-test-"));
    try {
      for (const aiWonderCapCents of [0, -1, 2.5, 12_001, Number.NaN]) {
        const app = new App({ outdir: join(outdir, String(aiWonderCapCents)) });
        expect(
          () =>
            new HostingStack(
              app,
              "Hosting",
              hostingProps({ aiSpendCapCents: 12_000, aiWonderCapCents }),
            ),
          String(aiWonderCapCents),
        ).toThrow(/aiWonderCapCents/);
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("gives Amplify a separate service role, assumable only for apps in this account", () => {
    const [serviceId, service] = role("ServiceRole");
    const [computeId] = role("ComputeRole");
    expect(serviceId).not.toBe(computeId);

    const trust = service.Properties.AssumeRolePolicyDocument as { Statement: Statement[] };
    expect(trust.Statement).toHaveLength(1);
    const [statement] = trust.Statement;
    expect(statement.Principal).toEqual({ Service: "amplify.amazonaws.com" });
    const condition = statement.Condition as {
      StringEquals: Record<string, unknown>;
      ArnLike: Record<string, unknown>;
    };
    expect(condition.StringEquals).toEqual({ "aws:SourceAccount": { Ref: "AWS::AccountId" } });
    expect(joined(condition.ArnLike["aws:SourceArn"])).toBe(
      "arn:aws:amplify:us-east-2:${AWS::AccountId}:apps/*",
    );
  });

  it("lets the service role write logs only under /aws/amplify/", () => {
    const [, service] = role("ServiceRole");
    const statements = inlineStatements(service).map((s) => ({
      actions: [...asArray(s.Action)].sort(),
      resources: asArray(s.Resource).map(joined),
    }));
    const logGroup = "arn:aws:logs:us-east-2:${AWS::AccountId}:log-group";
    expect(statements).toEqual([
      { actions: ["logs:CreateLogGroup"], resources: [`${logGroup}:/aws/amplify/*`] },
      {
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroup}:/aws/amplify/*:log-stream:*`],
      },
      { actions: ["logs:DescribeLogGroups"], resources: [`${logGroup}:*`] },
    ]);
  });

  it("attaches the service role to the app", () => {
    const [serviceId] = role("ServiceRole");
    const apps = Object.values(template.findResources("AWS::Amplify::App"));
    expect(apps[0].Properties.IAMServiceRole).toEqual({ "Fn::GetAtt": [serviceId, "Arn"] });
  });

  it("names no account id and carries the project tag", () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
    expect(synth.stacks.hosting.tags.tagValues()).toEqual({ project: "payday-copilot" });
    template.hasResourceProperties("AWS::Amplify::App", {
      Tags: Match.arrayWith([{ Key: "project", Value: "payday-copilot" }]),
    });
  });
});
