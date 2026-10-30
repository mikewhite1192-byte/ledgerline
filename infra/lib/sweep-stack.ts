import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { SWEEP_INTERNAL_KEY_SECRET_NAME } from "./hosting-stack";

// The nightly pay sweep's kicker. Three parts:
// - the shared key (generated here, 48 letters and digits) that the app reads by name
//   (SWEEP_INTERNAL_KEY_SECRET_NAME on the branch) and the kicker reads by ARN;
// - a small Lambda (infra/lambda/sweep-kicker) that asks the app to start and carry on a sweep for
//   each carrier in TENANT_IDS;
// - an EventBridge Scheduler schedule at 10:00 UTC that ships DISABLED. Turning it on is the
//   owner's release, and the app still refuses every call unless sweepScheduleEnabled is on.
// APP_URL and TENANT_IDS come from the deploying shell (SWEEP_APP_URL, SWEEP_TENANT_IDS); unset,
// the kicker logs "not configured" and calls nothing.
// A second schedule, every 15 minutes, wakes the carriers' desk loops through the same Lambda and
// key (input {"job":"desk"}). Its state comes from the deploying shell (DESK_SCHEDULE_STATE,
// ENABLED or DISABLED, default DISABLED), so it ships off and turning it on is a deploy the owner
// runs; the app still refuses every wake unless deskLoop is enabled. 96 wakes a day at 128 MB stay
// inside the Lambda free tier.

export const SWEEP_SCHEDULE_EXPRESSION = "cron(0 10 * * ? *)";
export const DESK_SCHEDULE_EXPRESSION = "rate(15 minutes)";
const KICKER_DIR = join(__dirname, "..", "lambda", "sweep-kicker");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TENANTS = 20;

export type ScheduleState = "ENABLED" | "DISABLED";
export type SweepSettings = { appUrl?: string; tenantIds?: readonly string[]; deskScheduleState?: ScheduleState };

// A bare https origin (no path, query, hash or login), or a refusal naming the setting. Shared with
// the inbound stack's app URL.
export function httpsOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an https origin`);
  }
  const bare = url.pathname === "/" && url.search === "" && url.hash === "";
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || !bare) {
    throw new Error(`${name} must be an https origin`);
  }
  return url.origin;
}

// The deploying shell's sweep settings, checked whole: an https origin with no path, query or
// login, up to 20 carrier ids, and the desk schedule's state spelled exactly. Anything else refuses
// the synth rather than ship a kicker that calls the wrong place or a schedule in a state nobody
// chose.
export function sweepSettingsFromEnv(env: Record<string, string | undefined>): SweepSettings {
  const out: { appUrl?: string; tenantIds?: string[]; deskScheduleState?: ScheduleState } = {};
  const appUrl = env.SWEEP_APP_URL?.trim();
  if (appUrl) out.appUrl = httpsOrigin(appUrl, "SWEEP_APP_URL");
  const ids = env.SWEEP_TENANT_IDS?.trim();
  if (ids) {
    const list = [...new Set(ids.split(",").map((s) => s.trim().toLowerCase()))];
    if (list.length > MAX_TENANTS || !list.every((id) => UUID.test(id))) {
      throw new Error(`SWEEP_TENANT_IDS must be up to ${MAX_TENANTS} comma-separated carrier ids`);
    }
    out.tenantIds = list;
  }
  const desk = env.DESK_SCHEDULE_STATE;
  if (desk !== undefined && desk !== "") {
    if (desk !== "ENABLED" && desk !== "DISABLED") throw new Error("DESK_SCHEDULE_STATE must be ENABLED or DISABLED");
    out.deskScheduleState = desk;
  }
  return out;
}

export type SweepStackProps = StackProps & { settings?: SweepSettings };

export class SweepStack extends Stack {
  readonly key: Secret;
  readonly kicker: LambdaFunction;
  readonly schedule: CfnSchedule;
  readonly deskSchedule: CfnSchedule;

  constructor(scope: Construct, id: string, props: SweepStackProps) {
    super(scope, id, props);
    const settings = props.settings ?? {};

    this.key = new Secret(this, "InternalKey", {
      secretName: SWEEP_INTERNAL_KEY_SECRET_NAME,
      description: "Shared key between the nightly sweep kicker and the app's internal sweep route",
      generateSecretString: { passwordLength: 48, excludePunctuation: true, includeSpace: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const environment: Record<string, string> = { SECRET_ARN: this.key.secretArn };
    if (settings.appUrl) environment.APP_URL = settings.appUrl;
    if (settings.tenantIds && settings.tenantIds.length > 0) environment.TENANT_IDS = settings.tenantIds.join(",");

    const logGroup = new LogGroup(this, "KickerLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.kicker = new LambdaFunction(this, "Kicker", {
      description: "Starts and carries on the nightly pay sweep, and wakes the desk loop, for each listed carrier",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromAsset(KICKER_DIR),
      memorySize: 128,
      timeout: Duration.seconds(300),
      environment,
      logGroup,
    });
    // One attempt per night: a failed kick is read in the logs, never retried on its own.
    this.kicker.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.hours(1) });
    this.key.grantRead(this.kicker);

    // The scheduler's role may invoke this one function, and only for this account.
    const invoker = new Role(this, "ScheduleRole", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    });
    this.kicker.grantInvoke(invoker);

    this.schedule = new CfnSchedule(this, "Nightly", {
      description: "Nightly pay sweep kick, 10:00 UTC. Ships disabled; enabling it is the owner's release.",
      scheduleExpression: SWEEP_SCHEDULE_EXPRESSION,
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      state: "DISABLED",
      target: {
        arn: this.kicker.functionArn,
        roleArn: invoker.roleArn,
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 3_600 },
      },
    });

    // The desk loop's wake, every 15 minutes, through the same function. Off unless the deploying
    // shell says ENABLED. One attempt per tick: the next tick is 15 minutes away.
    const deskState: ScheduleState = settings.deskScheduleState ?? "DISABLED";
    this.deskSchedule = new CfnSchedule(this, "DeskLoop", {
      description: "Desk loop wake, every 15 minutes. Ships disabled; enabling it is the owner's release.",
      scheduleExpression: DESK_SCHEDULE_EXPRESSION,
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      state: deskState,
      target: {
        arn: this.kicker.functionArn,
        roleArn: invoker.roleArn,
        input: JSON.stringify({ job: "desk" }),
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 900 },
      },
    });

    new CfnOutput(this, "KickerName", { value: this.kicker.functionName });
    new CfnOutput(this, "ScheduleState", { value: "DISABLED" });
    new CfnOutput(this, "DeskScheduleState", { value: deskState });
  }
}
