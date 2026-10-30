import { Match, type Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INBOUND_INTERNAL_KEY_SECRET_NAME } from "../lib/hosting-stack";
import { INBOUND_RULE_SET_NAME, inboundSettingsFromContext } from "../lib/inbound-stack";
import { asArray, policyStatements, synthAll } from "./synth";

// Made-up values only: no real zone id, domain or carrier ever sits in this repo. The synth reads
// nothing from AWS (the zone is imported by id and name, never looked up).
const TENANT_A = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const TENANT_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CONTEXT = {
  INBOUND_ZONE_ID: "Z0000000000TEST",
  INBOUND_ZONE_NAME: "example.com",
  INBOUND_DOMAIN: "inbound.example.com",
  INBOUND_TENANTS: `acme=${TENANT_A},road-runner=${TENANT_B.toUpperCase()}`,
  INBOUND_APP_URL: "https://main.example.amplifyapp.com/",
};

type Resource = { Type: string; Properties: Record<string, unknown> };

describe("InboundStack", () => {
  let synth: ReturnType<typeof synthAll>;
  let template: Template;

  beforeAll(() => {
    synth = synthAll(undefined, undefined, {}, CONTEXT);
    template = synth.inbound!;
  }, 120_000);

  afterAll(() => synth?.cleanup());

  it("is left out when the deploy passes no zone context", () => {
    const s = synthAll();
    try {
      expect(s.stacks.inbound).toBeUndefined();
      expect(s.inbound).toBeUndefined();
      expect(s.app.node.children.map((c) => c.node.id)).not.toContain("PaydayCopilotInbound");
    } finally {
      s.cleanup();
    }
  });

  it("the inbound stack creates no record at the apex", () => {
    const records = Object.values(template.findResources("AWS::Route53::RecordSet")) as Resource[];
    // The subdomain's MX and the identity's three DKIM CNAMEs, and nothing else.
    expect(records.map((r) => r.Properties.Type).sort()).toEqual(["CNAME", "CNAME", "CNAME", "MX"]);
    for (const r of records) {
      expect(r.Properties.HostedZoneId).toBe("Z0000000000TEST");
      expect(r.Properties.Name).not.toBe("example.com");
      expect(r.Properties.Name).not.toBe("example.com.");
      expect(r.Properties.Type).not.toBe("TXT");
      expect(r.Properties.Type).not.toBe("SPF");
    }
    const mx = records.find((r) => r.Properties.Type === "MX")!;
    expect(mx.Properties.Name).toBe("inbound.example.com.");
    expect(mx.Properties.ResourceRecords).toEqual(["10 inbound-smtp.us-east-2.amazonaws.com"]);
    // The DKIM names are the subdomain identity's own tokens, so they sit under the subdomain.
    const [identityId] = Object.keys(template.findResources("AWS::SES::EmailIdentity"));
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "inbound.example.com",
      MailFromAttributes: Match.absent(),
    });
    for (const r of records.filter((x) => x.Properties.Type === "CNAME")) {
      expect(r.Properties.Name).toEqual({ "Fn::GetAtt": [identityId, expect.stringMatching(/^DkimDNSTokenName[123]$/)] });
    }
    // No hosted zone is made or looked up: the stack writes into the zone it was given.
    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    expect(synth.app.synth().manifest.missing ?? []).toEqual([]);
  });

  it("the mail bucket blocks public access and expires objects", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      LifecycleConfiguration: { Rules: [Match.objectLike({ Status: "Enabled", ExpirationInDays: 30 })] },
    });
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    // TLS only, and SES may put objects under raw/ for this account and nothing else.
    const policy = Object.values(template.findResources("AWS::S3::BucketPolicy"))[0] as Resource;
    const statements = (policy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement;
    expect(statements).toContainEqual(
      expect.objectContaining({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    );
    const allows = statements.filter((s) => s.Effect === "Allow");
    expect(allows).toHaveLength(1);
    expect(allows[0]).toMatchObject({
      Action: "s3:PutObject",
      Principal: { Service: "ses.amazonaws.com" },
      Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
    });
    const [bucketId] = Object.keys(template.findResources("AWS::S3::Bucket"));
    expect(allows[0].Resource).toEqual({ "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/raw/*"]] });
  });

  it("the poster can read only the raw prefix and one secret", () => {
    const [bucketId] = Object.keys(template.findResources("AWS::S3::Bucket"));
    const [secretId] = Object.keys(template.findResources("AWS::SecretsManager::Secret"));
    const statements = policyStatements(template);
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s.Effect).toBe("Allow");
      for (const r of asArray(s.Resource)) expect(r).not.toBe("*");
    }
    const read = statements.find((s) => s.Action === "s3:GetObject");
    expect(read?.Resource).toEqual({ "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/raw/*"]] });
    const secret = statements.find((s) => s.Action === "secretsmanager:GetSecretValue");
    expect(secret?.Resource).toEqual({ Ref: secretId });
    // Only SES in this account may invoke it.
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "ses.amazonaws.com",
      SourceAccount: { Ref: "AWS::AccountId" },
    });
    template.resourceCountIs("AWS::Lambda::Permission", 1);
  });

  it("generates the shared key under its fixed name: 48 letters and digits", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: INBOUND_INTERNAL_KEY_SECRET_NAME,
      GenerateSecretString: Match.objectLike({ PasswordLength: 48, ExcludePunctuation: true }),
      SecretString: Match.absent(),
    });
    expect(INBOUND_INTERNAL_KEY_SECRET_NAME).toBe("payday-copilot/inbound-internal-key");
  });

  it("runs the poster on Node 22 ARM with the carriers, domain and app origin, retried twice", () => {
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 60,
      VpcConfig: Match.absent(),
      Environment: {
        Variables: {
          SECRET_ARN: Match.anyValue(),
          BUCKET: Match.anyValue(),
          DOMAIN: "inbound.example.com",
          APP_URL: "https://main.example.amplifyapp.com",
          TENANTS: `acme=${TENANT_A},road-runner=${TENANT_B}`,
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
    expect(synth.stacks.inbound!.tags.tagValues()).toEqual({ project: "payday-copilot" });
  });

  it("receives for the subdomain only: stores under raw/, then invokes the poster, with the virus scan on", () => {
    template.hasResourceProperties("AWS::SES::ReceiptRuleSet", { RuleSetName: INBOUND_RULE_SET_NAME });
    template.resourceCountIs("AWS::SES::ReceiptRule", 1);
    const [fnId] = Object.keys(template.findResources("AWS::Lambda::Function"));
    const [bucketId] = Object.keys(template.findResources("AWS::S3::Bucket"));
    template.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: {
        Enabled: true,
        Recipients: ["inbound.example.com"],
        ScanEnabled: true,
        TlsPolicy: "Optional",
        Actions: [
          { S3Action: { BucketName: { Ref: bucketId }, ObjectKeyPrefix: "raw/" } },
          { LambdaAction: { FunctionArn: { "Fn::GetAtt": [fnId, "Arn"] }, InvocationType: "Event" } },
        ],
      },
    });
  });
});

describe("inboundSettingsFromContext", () => {
  const ctx = (values: Record<string, unknown>) => (key: string) => values[key];

  it("takes nothing when no zone context is passed", () => {
    expect(inboundSettingsFromContext(ctx({}))).toBeNull();
    expect(inboundSettingsFromContext(ctx({ INBOUND_TENANTS: `acme=${TENANT_A}` }))).toBeNull();
  });

  it("refuses part of the zone context, a malformed zone, and the apex as the receiving domain", () => {
    const { INBOUND_ZONE_ID, INBOUND_ZONE_NAME, INBOUND_DOMAIN } = CONTEXT;
    expect(() => inboundSettingsFromContext(ctx({ INBOUND_ZONE_ID, INBOUND_ZONE_NAME }))).toThrow(/all three or none/);
    expect(() => inboundSettingsFromContext(ctx({ INBOUND_DOMAIN }))).toThrow(/all three or none/);
    const zone = { INBOUND_ZONE_ID, INBOUND_ZONE_NAME };
    expect(() => inboundSettingsFromContext(ctx({ ...zone, INBOUND_DOMAIN: "example.com" }))).toThrow(/subdomain/);
    expect(() => inboundSettingsFromContext(ctx({ ...zone, INBOUND_DOMAIN: "inbound.example.org" }))).toThrow(/subdomain/);
    expect(() => inboundSettingsFromContext(ctx({ ...zone, INBOUND_DOMAIN: "notexample.com" }))).toThrow(/subdomain/);
    expect(() => inboundSettingsFromContext(ctx({ ...zone, INBOUND_ZONE_ID: "zone-1", INBOUND_DOMAIN }))).toThrow(/hosted zone id/);
    expect(() => inboundSettingsFromContext(ctx({ ...zone, INBOUND_DOMAIN, INBOUND_APP_URL: "http://x.example" }))).toThrow(
      /https origin/,
    );
    expect(inboundSettingsFromContext(ctx({ ...zone, INBOUND_DOMAIN: "Inbound.Example.com." }))).toEqual({
      zoneId: INBOUND_ZONE_ID,
      zoneName: "example.com",
      domain: "inbound.example.com",
      tenants: [],
    });
  });

  it("refuses carriers that are not whole slug=uuid pairs, a slug twice, and more than 20", () => {
    const base = { INBOUND_ZONE_ID: "Z0000000000TEST", INBOUND_ZONE_NAME: "example.com", INBOUND_DOMAIN: "inbound.example.com" };
    for (const bad of [
      "acme",
      `acme=${TENANT_A}x`,
      `acme=${TENANT_A}=x`,
      `-acme=${TENANT_A}`,
      `ac.me=${TENANT_A}`,
      `acme=${TENANT_A},acme=${TENANT_B}`,
    ]) {
      expect(() => inboundSettingsFromContext(ctx({ ...base, INBOUND_TENANTS: bad })), bad).toThrow(/INBOUND_TENANTS/);
    }
    const many = Array.from({ length: 21 }, (_, i) => `c${i}=00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(() => inboundSettingsFromContext(ctx({ ...base, INBOUND_TENANTS: many.join(",") }))).toThrow(/up to 20/);
    expect(inboundSettingsFromContext(ctx({ ...base, INBOUND_TENANTS: ` Acme = ${TENANT_A.toUpperCase()} ` }))?.tenants).toEqual([
      ["acme", TENANT_A],
    ]);
  });
});
