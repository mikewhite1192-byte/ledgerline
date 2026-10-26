import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Session } from "./claims";
import { SESSION_COOKIE } from "./cookie";
import { verifyIdToken } from "./verify";

// The verified session for this request, or null. The token is checked on every request.
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyIdToken(token);
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}
