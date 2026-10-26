import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_ADMIN_SECRET_NAME, DB_APP_SECRET_NAME } from "../lib/data-stack";
import { synthAll } from "./synth";

describe("DataStack", () => {
  let synth: ReturnType<typeof synthAll>;
  let template: Template;

  // Synthesize into a temp folder this test owns, and remove it afterward.
  beforeAll(() => {
    synth = synthAll();
    template = synth.data;
  });

  afterAll(() => synth?.cleanup());

  it("runs Aurora PostgreSQL 16 Serverless v2 that pauses at 0 and caps at 2 ACU", () => {
    template.resourceCountIs("AWS::RDS::DBCluster", 1);
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      EngineVersion: "16.13",
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0,
        MaxCapacity: 2,
        SecondsUntilAutoPause: 600,
      },
      EnableHttpEndpoint: true,
      DeletionProtection: false,
      StorageEncrypted: true,
      DatabaseName: "payday",
    });
  });

  it("has one serverless writer that is not publicly accessible", () => {
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.serverless",
      PubliclyAccessible: false,
    });
  });

  it("has no network path in: no NAT, no internet gateway, no inbound rule", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::InternetGateway", 0);
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
    for (const sg of Object.values(template.findResources("AWS::EC2::SecurityGroup"))) {
      expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    }
  });

  it("keeps exactly two database logins, the migrator's and the app's", () => {
    const secrets = Object.values(template.findResources("AWS::SecretsManager::Secret"));
    expect(secrets.map((s) => s.Properties.Name).sort()).toEqual(
      [DB_ADMIN_SECRET_NAME, DB_APP_SECRET_NAME].sort(),
    );
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: DB_APP_SECRET_NAME,
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: JSON.stringify({ username: "payday_app", dbname: "payday" }),
      }),
    });
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: DB_ADMIN_SECRET_NAME,
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: JSON.stringify({ username: "payday_admin" }),
      }),
    });
  });

  it("does not rotate or attach the app login to the cluster", () => {
    template.resourceCountIs("AWS::SecretsManager::RotationSchedule", 0);
    const attachments = Object.values(
      template.findResources("AWS::SecretsManager::SecretTargetAttachment"),
    );
    // Only the admin secret is attached (it is the cluster's master login).
    expect(attachments).toHaveLength(1);
    expect(JSON.stringify(attachments[0].Properties.SecretId)).not.toContain("AppSecret");
  });

  it("publishes the outputs the deploy steps read", () => {
    for (const name of ["ClusterArn", "AppSecretArn", "AdminSecretArn", "DbName"]) {
      template.hasOutput(name, {});
    }
  });

  it("places the database in two fixed zones, so synth looks nothing up", () => {
    const subnets = Object.values(template.findResources("AWS::EC2::Subnet"));
    expect(subnets.map((s) => s.Properties.AvailabilityZone).sort()).toEqual([
      "us-east-2a",
      "us-east-2b",
    ]);
    // With a concrete account a zone lookup would need credentials; a test account proves none
    // is attempted.
    const withAccount = synthAll("111111111111");
    try {
      expect(withAccount.app.synth().manifest.missing ?? []).toEqual([]);
      for (const stack of Object.values(withAccount.stacks)) {
        expect(Annotations.fromStack(stack).findError("*", Match.anyValue())).toEqual([]);
      }
    } finally {
      withAccount.cleanup();
    }
  });

  it("names no account id and tags the cluster with the project", () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
    expect(synth.stacks.data.tags.tagValues()).toEqual({ project: "payday-copilot" });
    for (const cluster of Object.values(template.findResources("AWS::RDS::DBCluster"))) {
      expect(cluster.Properties.Tags).toContainEqual({ Key: "project", Value: "payday-copilot" });
    }
  });
});
