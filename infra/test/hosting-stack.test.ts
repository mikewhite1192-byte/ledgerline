import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRANCH_ENV_NAMES,
  DATA_API_ACTIONS,
  GITHUB_TOKEN_SECRET_NAME,
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

  it("lets the runtime call the Data API and read the app secret, nothing more", () => {
    const [, compute] = role("ComputeRole");
    const statements = inlineStatements(compute);
    expect(statements).toHaveLength(2);

    const [dataApi, secret] = statements;
    expect([...asArray(dataApi.Action)].sort()).toEqual([...DATA_API_ACTIONS].sort());
    expect(asArray(dataApi.Resource)).toHaveLength(1);
    expect(dataApi.Resource).not.toBe("*");
    expect(JSON.stringify(dataApi.Resource)).toContain("PublishOutputRefCluster");

    expect(secret.Action).toBe("secretsmanager:GetSecretValue");
    expect(asArray(secret.Resource)).toHaveLength(1);
    expect(JSON.stringify(secret.Resource)).toContain("PublishOutputRefAppSecret");
    expect(JSON.stringify(secret.Resource)).not.toMatch(/AdminSecret|ClusterSecret/);
  });

  it("has no standalone IAM policy and no statement on every resource", () => {
    expect(Object.keys(template.findResources("AWS::IAM::Policy"))).toHaveLength(0);
    for (const s of policyStatements(template)) {
      expect(asArray(s.Resource)).not.toContain("*");
    }
  });

  it("sets the compute role and the five server settings on the main branch", () => {
    const [computeId] = role("ComputeRole");
    const branches = Object.values(template.findResources("AWS::Amplify::Branch"));
    expect(branches).toHaveLength(1);
    const props = branches[0].Properties;
    expect(props.ComputeRoleArn).toEqual({ "Fn::GetAtt": [computeId, "Arn"] });
    const vars = props.EnvironmentVariables as { Name: string; Value: unknown }[];
    expect(vars.map((e) => e.Name)).toEqual(BRANCH_ENV_NAMES);
    expect(BRANCH_ENV_NAMES).toHaveLength(5);

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
