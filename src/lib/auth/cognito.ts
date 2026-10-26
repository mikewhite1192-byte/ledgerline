import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export type SignInResult =
  | { ok: true; idToken: string }
  | { ok: false; reason: "invalid_credentials" | "unavailable" };

let client: CognitoIdentityProviderClient | undefined;

// Email and password against the user pool. InitiateAuth is an unauthenticated API, so the
// server needs no IAM permission for it. No password, email or token is ever logged.
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!clientId) {
    console.error("auth: not configured");
    return { ok: false, reason: "unavailable" };
  }
  client ??= new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  try {
    const out = await client.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
    // Demo passwords are set permanent, so no challenge is expected. If one arrives anyway
    // (NEW_PASSWORD_REQUIRED), the app has no screen for it: treat it as a failed sign-in.
    const idToken = out.AuthenticationResult?.IdToken;
    if (!idToken) {
      console.error(`auth: sign-in returned no token (${out.ChallengeName ?? "no challenge"})`);
      return { ok: false, reason: "invalid_credentials" };
    }
    return { ok: true, idToken };
  } catch (err) {
    const name = err instanceof Error ? err.name : "non-error";
    if (name === "NotAuthorizedException" || name === "UserNotFoundException") {
      return { ok: false, reason: "invalid_credentials" };
    }
    console.error(`auth: sign-in unavailable (${name})`);
    return { ok: false, reason: "unavailable" };
  }
}
