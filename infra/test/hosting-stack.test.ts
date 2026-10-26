import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import {
  AI_CREDIT_CENTS,
  BASETEN_API_KEY_SECRET_NAME,
  BRANCH_ENV_NAMES,
  DATA_API_ACTIONS,
  GITHUB_TOKEN_SECRET_NAME,
  HostingStack,
  META_API_KEY_SECRET_NAME,
  REPOSITORY_URL,
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

  it("gives the SSR runtime a role only Amplify can assume", () => {
    const [, compute] = role("ComputeRole");
    expect(compute.Properties.AssumeRolePolicyDocument).toEqual({
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "amplify.amazonaws.com" },
        },
      ],
      Version: "2012-10-17",
    });
  });

  it("lets the runtime call the Data API and read the app secret and the model keys, nothing more", () => {
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
    expect(resources).toHaveLength(3);
    const appSecret = resources.filter((r) =>
      JSON.stringify(r).includes("PublishOutputRefAppSecret"),
    );
    expect(appSecret).toHaveLength(1);
    expect(JSON.stringify(secret.Resource)).not.toMatch(/AdminSecret|ClusterSecret/);
    // Each model key by its exact name. The only wildcard is the six-character suffix Secrets
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

  it("sets the compute role and the ten server settings on the main branch", () => {
    const [computeId] = role("ComputeRole");
    const branches = Object.values(template.findResources("AWS::Amplify::Branch"));
    expect(branches).toHaveLength(1);
    const props = branches[0].Properties;
    expect(props.ComputeRoleArn).toEqual({ "Fn::GetAtt": [computeId, "Arn"] });
    const vars = props.EnvironmentVariables as { Name: string; Value: unknown }[];
    expect(vars.map((e) => e.Name)).toEqual(BRANCH_ENV_NAMES);
    expect(BRANCH_ENV_NAMES).toHaveLength(10);

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
    // The spend cap, the model ids and the key secret names are plain values in this stack.
    expect(value).toMatchObject({
      AI_SPEND_CAP_CENTS: "12000",
      META_MODEL_ID: "muse-spark-1.3",
      META_API_KEY_SECRET_NAME,
      BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
      BASETEN_API_KEY_SECRET_NAME,
    });
    // Names only: no variable carries a key.
    expect(BRANCH_ENV_NAMES.filter((n) => /_KEY$|TOKEN|PASSWORD/.test(n))).toEqual([]);
  });

  it("copies exactly the branch variables into the server build, and never a raw key", () => {
    const spec = readFileSync(fileURLToPath(new URL("../../amplify.yml", import.meta.url)), "utf8");
    const copied = [...spec.matchAll(/-e '\^([A-Z_]+)='/g)].map((m) => m[1]);
    expect(copied).toEqual([
      ...BRANCH_ENV_NAMES.slice(0, 5),
      "AWS_REGION",
      ...BRANCH_ENV_NAMES.slice(5),
    ]);
  });

  it("refuses a spend cap that is not a whole number of cents up to the credit", () => {
    // An App makes its output folder when it is built, so each one gets a folder this test owns.
    const outdir = mkdtempSync(join(tmpdir(), "payday-hosting-cap-test-"));
    try {
      for (const aiSpendCapCents of [0, -1, 12.5, AI_CREDIT_CENTS + 1, Number.NaN]) {
        const app = new App({ outdir: join(outdir, String(aiSpendCapCents)) });
        expect(
          () =>
            new HostingStack(app, "Hosting", {
              env: { region: "us-east-2" },
              clusterArn: "arn:aws:rds:us-east-2:000000000000:cluster:test",
              appSecret: synth.stacks.data.appSecret,
              dbName: "payday",
              userPoolId: "pool",
              userPoolClientId: "client",
              aiSpendCapCents,
              metaModelId: "muse-spark-1.3",
              basetenModelId: "meta-models/muse-spark-open-1026",
            }),
          String(aiSpendCapCents),
        ).toThrow(/aiSpendCapCents/);
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
