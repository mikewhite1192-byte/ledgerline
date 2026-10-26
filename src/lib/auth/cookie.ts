// The session is the Cognito ID token in an httpOnly cookie, valid as long as the token (12 hours).
// No refresh: after 12 hours the user signs in again.
export const SESSION_COOKIE = "pc_session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

export function sessionCookieOptions(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: nodeEnv === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
