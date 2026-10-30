import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { MxRecord, PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { EmailIdentity, type Identity, ReceiptRuleSet, TlsPolicy } from "aws-cdk-lib/aws-ses";
import { Lambda as LambdaAction, LambdaInvocationType, S3 as S3Action } from "aws-cdk-lib/aws-ses-actions";
import type { Construct } from "constructs";
import { INBOUND_INTERNAL_KEY_SECRET_NAME } from "./hosting-stack";
import { httpsOrigin } from "./sweep-stack";

// Drivers' email into the Inbox. SES receives mail for one subdomain of the owner's zone, stores
// each message under raw/ in a private bucket, then invokes a small poster (infra/lambda/
// inbound-mail) that posts the message's text to the app's internal inbound route with a shared
// key. The app refuses every post unless inboundEmailEnabled and inboxEnabled are on.
//
// The zone is never looked up: its id and name come from the deploy's cdk context, so a synth
// reads nothing from Route 53. The only records written are the subdomain's MX and the SES
// identity's three DKIM CNAMEs under the subdomain; the zone's apex (its MX, SPF and DKIM) is
// never touched. CDK cannot make a rule set active; the owner does that once (docs/runbook.md).
//
// Context (passed with -c at deploy, never stored in a tracked file):
//   INBOUND_ZONE_ID, INBOUND_ZONE_NAME, INBOUND_DOMAIN: all three, or the stack is left out;
//   INBOUND_TENANTS: slug=carrier-uuid,... (a recipient's whole local part names a carrier);
//   INBOUND_APP_URL: the app's https origin.
// Without the last two the poster logs "not configured" and posts nothing.

export const INBOUND_RULE_SET_NAME = "payday-copilot-inbound";
export const RAW_PREFIX = "raw/";
export const RAW_MAIL_DAYS = 30;
export const INBOUND_CONTEXT_KEYS = [
  "INBOUND_ZONE_ID",
  "INBOUND_ZONE_NAME",
  "INBOUND_DOMAIN",
  "INBOUND_TENANTS",
  "INBOUND_APP_URL",
] as const;

const POSTER_ENTRY = join(__dirname, "..", "lambda", "inbound-mail", "index.mjs");
const REPO_ROOT = join(__dirname, "..", "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ZONE_ID = /^Z[A-Z0-9]{1,32}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_TENANTS = 20;

export type InboundSettings = {
  zoneId: string;
  zoneName: string;
  domain: string;
  tenants: readonly (readonly [slug: string, tenantId: string])[];
  appUrl?: string;
};

function hostname(value: string): boolean {
  const labels = value.split(".");
  return value.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

// The deploy's inbound context, checked whole. None of the three zone values: no inbound stack.
// Some but not all, or any malformed value: the synth is refused rather than ship a mailbox that
// writes the wrong records or posts to the wrong place.
export function inboundSettingsFromContext(get: (key: string) => unknown): InboundSettings | null {
  const read = (key: string): string | undefined => {
    const v = get(key);
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    const t = v.trim();
    return t === "" ? undefined : t;
  };
  const zoneId = read("INBOUND_ZONE_ID");
  const zoneName = read("INBOUND_ZONE_NAME")?.toLowerCase().replace(/\.$/, "");
  const domain = read("INBOUND_DOMAIN")?.toLowerCase().replace(/\.$/, "");
  const present = [zoneId, zoneName, domain].filter((v) => v !== undefined).length;
  if (present === 0) return null;
  if (present !== 3 || !zoneId || !zoneName || !domain) {
    throw new Error("INBOUND_ZONE_ID, INBOUND_ZONE_NAME and INBOUND_DOMAIN go together: all three or none");
  }
  if (!ZONE_ID.test(zoneId)) throw new Error("INBOUND_ZONE_ID must be a Route 53 hosted zone id");
  if (!hostname(zoneName)) throw new Error("INBOUND_ZONE_NAME must be a domain name");
  // A subdomain of the zone, never the zone itself: the apex keeps its own mail.
  if (!hostname(domain) || !domain.endsWith(`.${zoneName}`)) {
    throw new Error("INBOUND_DOMAIN must be a subdomain of INBOUND_ZONE_NAME, never the zone itself");
  }

  const tenants: [string, string][] = [];
  const rawTenants = read("INBOUND_TENANTS");
  if (rawTenants) {
    for (const entry of rawTenants.split(",")) {
      const parts = entry.trim().split("=");
      const slug = parts[0]?.trim().toLowerCase() ?? "";
      const id = parts[1]?.trim().toLowerCase() ?? "";
      if (parts.length !== 2 || !SLUG.test(slug) || !UUID.test(id) || tenants.some(([s]) => s === slug)) {
        throw new Error("INBOUND_TENANTS must be slug=carrier-id pairs, each slug once");
      }
      tenants.push([slug, id]);
    }
    if (tenants.length > MAX_TENANTS) throw new Error(`INBOUND_TENANTS takes up to ${MAX_TENANTS} carriers`);
  }
  const appUrl = read("INBOUND_APP_URL");
  return {
    zoneId,
    zoneName,
    domain,
    tenants,
    ...(appUrl ? { appUrl: httpsOrigin(appUrl, "INBOUND_APP_URL") } : {}),
  };
}

export type InboundStackProps = StackProps & { settings: InboundSettings };

export class InboundStack extends Stack {
  readonly key: Secret;
  readonly bucket: Bucket;
  readonly poster: NodejsFunction;
  readonly ruleSet: ReceiptRuleSet;

  constructor(scope: Construct, id: string, props: InboundStackProps) {
    super(scope, id, props);
    const { settings } = props;

    this.key = new Secret(this, "InternalKey", {
      secretName: INBOUND_INTERNAL_KEY_SECRET_NAME,
      description: "Shared key between the inbound mail poster and the app's internal inbound route",
      generateSecretString: { passwordLength: 48, excludePunctuation: true, includeSpace: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Raw messages, private, kept 30 days and then removed. Kept on stack delete: it holds mail.
    this.bucket = new Bucket(this, "RawMail", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        {
          id: "expire-raw-mail",
          expiration: Duration.days(RAW_MAIL_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Imported by id and name: no lookup, no Route 53 read at synth.
    const zone = PublicHostedZone.fromPublicHostedZoneAttributes(this, "Zone", {
      hostedZoneId: settings.zoneId,
      zoneName: settings.zoneName,
    });

    new MxRecord(this, "InboundMx", {
      zone,
      recordName: `${settings.domain}.`,
      values: [{ priority: 10, hostName: `inbound-smtp.${this.region}.amazonaws.com` }],
      ttl: Duration.minutes(30),
    });

    // The identity is the subdomain, with the zone it lives in, so its DKIM CNAMEs land under the
    // subdomain (Identity.publicHostedZone would verify the zone's apex instead). This is the shape
    // Identity's own factories return. No MAIL FROM domain, so no SPF or MX for one is written.
    const identity: Identity = { value: settings.domain, hostedZone: zone };
    new EmailIdentity(this, "Identity", { identity });

    const environment: Record<string, string> = {
      SECRET_ARN: this.key.secretArn,
      BUCKET: this.bucket.bucketName,
      DOMAIN: settings.domain,
    };
    if (settings.appUrl) environment.APP_URL = settings.appUrl;
    if (settings.tenants.length > 0) environment.TENANTS = settings.tenants.map(([s, t]) => `${s}=${t}`).join(",");

    const logGroup = new LogGroup(this, "PosterLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Bundled on this machine with the pinned esbuild (no Docker); the AWS SDK comes from the
    // Lambda runtime, mailparser is bundled at the version package-lock.json pins.
    this.poster = new NodejsFunction(this, "MailPoster", {
      description: "Posts each received driver email's text to the app's internal inbound route",
      entry: POSTER_ENTRY,
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // The app's route may take its full 30 seconds; this leaves room for the read and parse.
      timeout: Duration.seconds(60),
      environment,
      logGroup,
      projectRoot: REPO_ROOT,
      depsLockFilePath: join(REPO_ROOT, "package-lock.json"),
      bundling: {
        format: OutputFormat.CJS,
        target: "node22",
        minify: false,
        sourceMap: false,
        externalModules: ["@aws-sdk/*"],
        forceDockerBundling: false,
      },
    });
    // Two retries of a failed post, within the hour; the app's message id dedupe keeps one row.
    this.poster.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(1) });
    // Exactly what the poster needs: stored messages under raw/, and its one key.
    this.poster.addToRolePolicy(
      new PolicyStatement({ actions: ["s3:GetObject"], resources: [this.bucket.arnForObjects(`${RAW_PREFIX}*`)] }),
    );
    this.poster.addToRolePolicy(
      new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [this.key.secretArn] }),
    );

    this.ruleSet = new ReceiptRuleSet(this, "RuleSet", { receiptRuleSetName: INBOUND_RULE_SET_NAME });
    this.ruleSet.addRule("Inbound", {
      recipients: [settings.domain],
      actions: [
        new S3Action({ bucket: this.bucket, objectKeyPrefix: RAW_PREFIX }),
        new LambdaAction({ function: this.poster, invocationType: LambdaInvocationType.EVENT }),
      ],
      scanEnabled: true,
      tlsPolicy: TlsPolicy.OPTIONAL,
      enabled: true,
    });

    new CfnOutput(this, "RuleSetName", { value: INBOUND_RULE_SET_NAME });
    new CfnOutput(this, "PosterName", { value: this.poster.functionName });
    new CfnOutput(this, "MailBucket", { value: this.bucket.bucketName });
  }
}
