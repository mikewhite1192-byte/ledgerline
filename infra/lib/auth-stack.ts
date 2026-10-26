import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AccountRecovery,
  ClientAttributes,
  FeaturePlan,
  Mfa,
  StringAttribute,
  UserPool,
  UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";

// The login pool. Users are created only by the demo script; nothing here sends mail (no
// self sign-up, no password reset, no MFA, no hosted UI). The tenant is an immutable custom
// attribute the app client can read but never write, so a user cannot move themselves to
// another carrier.
export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.userPool = new UserPool(this, "UserPool", {
      userPoolName: "payday-copilot",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // Users are created with a verified email; no attribute change ever triggers a code by mail.
      autoVerify: { email: false },
      // Cognito rejects a required attribute the client cannot write, so email stays writable.
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        tenant_id: new StringAttribute({ minLen: 36, maxLen: 36, mutable: false }),
      },
      passwordPolicy: { minLength: 12 },
      mfa: Mfa.OFF,
      accountRecovery: AccountRecovery.NONE,
      featurePlan: FeaturePlan.LITE,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.client = this.userPool.addClient("Web", {
      generateSecret: false,
      // The app has its own sign-in page: no OAuth flows, scopes or callback URLs at all.
      disableOAuth: true,
      // ALLOW_USER_PASSWORD_AUTH plus the implicit refresh flow; no admin flow, no SRP.
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(12),
      accessTokenValidity: Duration.hours(12),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
      // A claim appears on the ID token only if the client can read it.
      readAttributes: new ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes("tenant_id"),
      writeAttributes: new ClientAttributes().withStandardAttributes({ email: true }),
    });

    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "ClientId", { value: this.client.userPoolClientId });
  }
}
