"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { signIn } from "@/lib/auth/cognito";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";
import { isJudge, readRole, type Role } from "@/lib/auth/role";
import { verifyIdToken } from "@/lib/auth/verify";
import { withSessionTenant } from "@/lib/tenant/context";

// The page shows a fixed message per code; nothing the user typed or the upstream said is echoed.
export async function signInAction(formData: FormData): Promise<void> {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string") redirect("/sign-in?error=invalid");
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254 || !password || password.length > 256) {
    redirect("/sign-in?error=invalid");
  }

  const result = await signIn(trimmed, password);
  if (!result.ok) {
    redirect(
      result.reason === "invalid_credentials" ? "/sign-in?error=invalid" : "/sign-in?error=unavailable",
    );
  }

  // Only a token the next request will accept (signature, audience, tenant claim) becomes a session.
  const session = await verifyIdToken(result.idToken);
  if (!session) redirect("/sign-in?error=unavailable");

  // Judge access off: a judge login gets no session. The same "wrong" message as a bad password,
  // so the page never says the login exists; a role that cannot be read sets no cookie either.
  if (!flags.judgeAccess.enabled) {
    const role = await roleOf(session);
    if (role === null) redirect("/sign-in?error=unavailable");
    if (isJudge(role)) redirect("/sign-in?error=invalid");
  }

  (await cookies()).set(SESSION_COOKIE, result.idToken, sessionCookieOptions());
  redirect("/");
}

// The login's one role in the token's tenant, read in the same scoped, membership-checked
// transaction every request uses. null when refused or failed: unknown, so the caller fails
// closed. Only the error's name reaches the log.
async function roleOf(session: Session): Promise<Role | null> {
  try {
    return await withSessionTenant(session, (q) => readRole(q, session));
  } catch (err) {
    console.error("sign-in: role check failed:", err instanceof Error ? err.name : "unknown");
    return null;
  }
}
