import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SWEEP_INTERNAL_KEY_SECRET_NAME } from "../lib/hosting-stack";
import { SWEEP_SCHEDULE_EXPRESSION, sweepSettingsFromEnv } from "../lib/sweep-stack";
import { asArray, policyStatements, synthAll } from "./synth";

const TENANT_A = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const TENANT_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("SweepStack", () => {
  let synth: ReturnType<typeof synthAll>;
  let template: Template;

  beforeAll(() => {
    synth = synthAll();
    template = synth.sweep;
  });

  afterAll(() => synth?.cleanup());

  it("ships the nightly schedule disabled, at 10:00 UTC, with no flexible window and no retries", () => {
    template.resourceCountIs("AWS::Scheduler::Schedule", 1);
    expect(SWEEP_SCHEDULE_EXPRESSION).toBe("cron(0 10 * * ? *)");
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      State: "DISABLED",
      ScheduleExpression: "cron(0 10 * * ? *)",
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600 } }),
    });
  });

  it("runs the kicker on Node 22 with 128 MB, a 300 second timeout, no VPC and one attempt", () => {
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      MemorySize: 128,
      Timeout: 300,
      VpcConfig: Match.absent(),
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 0 });
  });

  it("generates the shared key under its fixed name: 48 letters and digits", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: SWEEP_INTERNAL_KEY_SECRET_NAME,
      GenerateSecretString: Match.objectLike({ PasswordLength: 48, ExcludePunctuation: true }),
      SecretString: Match.absent(),
    });
  });

  it("lets the kicker read only its key, and the schedule invoke only the kicker", () => {
    const statements = policyStatements(template);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      for (const r of asArray(s.Resource)) expect(r).not.toBe("*");
    }
    const [secretId] = Object.keys(template.findResources("AWS::SecretsManager::Secret"));
    const [fnId] = Object.keys(template.findResources("AWS::Lambda::Function"));
    const read = statements.find((s) => asArray(s.Action).includes("secretsmanager:GetSecretValue"));
    expect(read?.Resource).toEqual({ Ref: secretId });
    const invoke = statements.find((s) => asArray(s.Action).includes("lambda:InvokeFunction"));
    expect(JSON.stringify(invoke?.Resource)).toContain(fnId);
    for (const s of statements) {
      const actions = asArray(s.Action) as string[];
      expect(actions.every((a) => a.startsWith("secretsmanager:") || a.startsWith("lambda:") || a.startsWith("logs:"))).toBe(
        true,
      );
    }
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    const scheduler = roles.find((r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes("scheduler.amazonaws.com"),
    );
    expect(JSON.stringify(scheduler?.Properties.AssumeRolePolicyDocument)).toContain("aws:SourceAccount");
  });

  it("gives the kicker only the key's ARN when the shell exports no app URL or carriers", () => {
    const fn = Object.values(template.findResources("AWS::Lambda::Function"))[0];
    expect(Object.keys(fn.Properties.Environment.Variables)).toEqual(["SECRET_ARN"]);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
    expect(synth.stacks.sweep.tags.tagValues()).toEqual({ project: "payday-copilot" });
  });

  it("passes the exported app origin and carrier ids to the kicker", () => {
    const s = synthAll(undefined, undefined, {
      SWEEP_APP_URL: "https://main.example.amplifyapp.com",
      SWEEP_TENANT_IDS: `${TENANT_A}, ${TENANT_B.toUpperCase()}`,
    });
    try {
      s.sweep.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            SECRET_ARN: Match.anyValue(),
            APP_URL: "https://main.example.amplifyapp.com",
            TENANT_IDS: `${TENANT_A},${TENANT_B}`,
          },
        },
      });
    } finally {
      s.cleanup();
    }
  });
});

describe("sweepSettingsFromEnv", () => {
  it("takes nothing when nothing is exported", () => {
    expect(sweepSettingsFromEnv({})).toEqual({});
    expect(sweepSettingsFromEnv({ SWEEP_APP_URL: " ", SWEEP_TENANT_IDS: "" })).toEqual({});
  });

  it("refuses anything but a bare https origin", () => {
    for (const bad of [
      "http://main.example.amplifyapp.com",
      "https://main.example.amplifyapp.com/api",
      "https://main.example.amplifyapp.com/?x=1",
      "https://user:pw@main.example.amplifyapp.com",
      "not a url",
    ]) {
      expect(() => sweepSettingsFromEnv({ SWEEP_APP_URL: bad })).toThrow(/https origin/);
    }
    expect(sweepSettingsFromEnv({ SWEEP_APP_URL: "https://main.example.amplifyapp.com/" })).toEqual({
      appUrl: "https://main.example.amplifyapp.com",
    });
  });

  it("refuses carrier ids that are not whole uuids, and more than 20", () => {
    expect(() => sweepSettingsFromEnv({ SWEEP_TENANT_IDS: `${TENANT_A},acme` })).toThrow(/carrier ids/);
    expect(() => sweepSettingsFromEnv({ SWEEP_TENANT_IDS: `${TENANT_A}x` })).toThrow(/carrier ids/);
    const many = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(() => sweepSettingsFromEnv({ SWEEP_TENANT_IDS: many.join(",") })).toThrow(/carrier ids/);
    expect(sweepSettingsFromEnv({ SWEEP_TENANT_IDS: `${TENANT_A},${TENANT_A}` })).toEqual({ tenantIds: [TENANT_A] });
  });
});
