"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth/cognito";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";
import { verifyIdToken } from "@/lib/auth/verify";

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
  if (!(await verifyIdToken(result.idToken))) redirect("/sign-in?error=unavailable");

  (await cookies()).set(SESSION_COOKIE, result.idToken, sessionCookieOptions());
  redirect("/");
}
