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

// A demo visit (src/app/sign-in/try-demo-action.ts): the judge's pc_session and the pc_demo cookie
// that names the visit's demo_sessions row both last flags.judgeAccess.cookieHours, never longer
// than a normal session. The token inside still verifies for 12 hours; the visit row's expiry is
// what the per-visit limits hang on.
export const DEMO_COOKIE = "pc_demo";

export function visitCookieOptions(
  cookieHours: number,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SessionCookieOptions {
  const hours = Number.isFinite(cookieHours) && cookieHours > 0 ? cookieHours : 0;
  return {
    ...sessionCookieOptions(nodeEnv),
    maxAge: Math.min(Math.floor(hours * 60 * 60), SESSION_MAX_AGE_SECONDS),
  };
}
