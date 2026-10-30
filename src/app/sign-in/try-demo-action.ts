"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { flags } from "@/config/flags";
import { signIn } from "@/lib/auth/cognito";
import { DEMO_COOKIE, SESSION_COOKIE, visitCookieOptions } from "@/lib/auth/cookie";
import { ipHashOf, startVisit, type StartedVisit } from "@/lib/auth/demo-visit";
import { forgetJudgeLogin, judgeLogin } from "@/lib/auth/judge-login";
import { readRole } from "@/lib/auth/role";
import { verifyIdToken } from "@/lib/auth/verify";
import { getDb } from "@/lib/db";

// "Try the demo carrier" (the sign-in page's second card, shown only while flags.judgeAccess is
// on). A POST from the page, so Next's origin check applies. The server signs the visitor in as
// the demo carrier's one judge login (src/lib/auth/judge-login.ts, read from Secrets Manager; no
// credential is in any tracked file) through the normal password sign-in, then checks, in the
// token's tenant, that the login really is a judge (anything else, a missing membership or a role
// this code does not know is refused, so a wrong secret never hands strangers an admin) and starts
// or reuses the visit (src/lib/auth/demo-visit.ts: the day's spend, a live pc_demo visit, then the
// new-visit limits per address and per day). Only then are pc_session and pc_demo set, both for
// flags.judgeAccess.cookieHours. Every refusal goes back to the sign-in page with one friendly
// line; the log gets the category, never the login, the token or the upstream's words.

type Category =
  | "disabled"
  | "secret"
  | "credentials"
  | "cognito"
  | "token"
  | "role"
  | "unavailable"
  | "day_cap"
  | "ip_limit"
  | "day_limit";

const REFUSED = "/sign-in?demo=unavailable";

function refused(category: Category): string {
  console.info(`demo sign-in: refused (${category})`);
  return REFUSED;
}

async function visit(): Promise<string> {
  if (!flags.judgeAccess.enabled) return refused("disabled");
  const options = visitCookieOptions(flags.judgeAccess.cookieHours);
  if (options.maxAge <= 0) return refused("disabled");

  const login = await judgeLogin();
  if (!login) return refused("secret");
  const result = await signIn(login.email, login.password);
  if (!result.ok) {
    if (result.reason === "invalid_credentials") {
      // A reset password is picked up on the next click, without a redeploy.
      forgetJudgeLogin();
      return refused("credentials");
    }
    return refused("cognito");
  }
  const session = await verifyIdToken(result.idToken);
  if (!session) return refused("token");

  const jar = await cookies();
  const reuseId = jar.get(DEMO_COOKIE)?.value ?? null;
  const ipHash = ipHashOf((await headers()).get("x-forwarded-for"));
  let started: StartedVisit | "not_judge";
  try {
    started = await getDb().withTenant(session.tenantId, async (q) => {
      const role = await readRole(q, session);
      if (role !== "judge") return "not_judge" as const;
      return startVisit(q, { sub: session.sub, ipHash, reuseId, limits: flags.judgeAccess });
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refused("role");
    console.error(`demo sign-in: the visit could not start (${err instanceof Error ? err.name : "non-error"})`);
    return refused("unavailable");
  }
  if (started === "not_judge") return refused("role");
  if (!started.ok) return refused(started.reason);

  jar.set(SESSION_COOKIE, result.idToken, options);
  jar.set(DEMO_COOKIE, started.id, options);
  console.info(`demo sign-in: ${started.reused ? "visit kept" : "visit started"}`);
  return "/";
}

export async function tryDemoAction(): Promise<void> {
  redirect(await visit());
}
