import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  DatabaseSecret,
} from "aws-cdk-lib/aws-rds";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export const DB_NAME = "payday";
export const DB_ADMIN_SECRET_NAME = "payday-copilot/db-admin";
export const DB_APP_SECRET_NAME = "payday-copilot/db-app";

// Aurora PostgreSQL Serverless v2, reached only through the Data API. The cluster sits in
// isolated subnets with no NAT, no internet gateway and no inbound rule: nothing connects to it
// over the network. It pauses after 10 idle minutes (0 ACU) and wakes on the next Data API call.
export class DataStack extends Stack {
  readonly cluster: DatabaseCluster;
  readonly appSecret: ISecret;
  readonly adminSecret: ISecret;
  readonly dbName = DB_NAME;

  // Two fixed zones instead of a lookup. A lookup needs AWS credentials at synth and writes the
  // account id into cdk.context.json, which must never reach this public repo.
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Aurora needs a subnet group across two AZs.
    const vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      createInternetGateway: false,
      subnetConfiguration: [{ name: "db", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });

    // 16.x to match CI's Postgres 16, so a migration that passes CI runs the same here. 16.13 is
    // above the 16.3 floor for auto-pause.
    this.cluster = new DatabaseCluster(this, "Cluster", {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_13,
      }),
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      writer: ClusterInstance.serverlessV2("Writer", { publiclyAccessible: false }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: Duration.minutes(10),
      enableDataApi: true,
      defaultDatabaseName: DB_NAME,
      // The migrator. Owns the tables; the app never reads this secret.
      credentials: Credentials.fromGeneratedSecret("payday_admin", {
        secretName: DB_ADMIN_SECRET_NAME,
      }),
      storageEncrypted: true,
      backup: { retention: Duration.days(1) },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    if (!this.cluster.secret) throw new Error("cluster has no admin secret");
    this.adminSecret = this.cluster.secret;

    // The app's login (payday_app). Not attached to the cluster and never rotated; the migration
    // runner sets the role's password from it. The default excluded characters keep quotes and
    // backslashes out of the password.
    this.appSecret = new DatabaseSecret(this, "AppSecret", {
      username: "payday_app",
      secretName: DB_APP_SECRET_NAME,
      dbname: DB_NAME,
    });

    new CfnOutput(this, "ClusterArn", { value: this.cluster.clusterArn });
    new CfnOutput(this, "AppSecretArn", { value: this.appSecret.secretArn });
    new CfnOutput(this, "AdminSecretArn", { value: this.adminSecret.secretArn });
    new CfnOutput(this, "DbName", { value: DB_NAME });
  }
}
