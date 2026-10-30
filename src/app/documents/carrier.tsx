import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Session } from "@/lib/auth/claims";
import { isRole, type Role } from "@/lib/auth/role";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// The documents pages' shell data: the carrier on the verified token and the signed-in member.
// Signed out: withRequestTenant redirects to /sign-in.

export type Carrier = { name: string; timezone: string; email: string; role: Role; session: Session };

export async function readCarrier(): Promise<
  { carrier: Carrier; problem: null } | { carrier: null; problem: "forbidden" | "unreadable" }
> {
  try {
    const carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string; role: unknown }>(
        "SELECT email, role FROM memberships WHERE cognito_sub = $1 AND tenant_id = current_tenant_id()",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      // A role this code does not know is refused, never shown as staff.
      const role = members[0].role;
      if (!isRole(role)) throw new ForbiddenError();
      return { name: tenants[0].name, timezone: tenants[0].timezone, email: members[0].email, role, session };
    });
    return { carrier, problem: null };
  } catch (err) {
    if (err instanceof ForbiddenError) return { carrier: null, problem: "forbidden" };
    if (err instanceof DbError) return { carrier: null, problem: "unreadable" };
    throw err;
  }
}

export function SignOut() {
  return (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );
}

export function NoCarrier({ problem }: { problem: "forbidden" | "unreadable" }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <h1 className="sr-only">LedgerLine</h1>
        <Wordmark size="lg" className="justify-self-center" />
        <Card>
          <ErrorState category={problem} />
          <div className="border-t border-border p-3">
            <SignOut />
          </div>
        </Card>
      </div>
    </main>
  );
}

// A failed read of the documents themselves, as an error category the page can show.
export function problemOf(err: unknown): "forbidden" | "unreadable" {
  const category = err instanceof Error && err.name === "ForbiddenError" ? "forbidden" : "unreadable";
  console.error("documents: page read failed:", err instanceof Error ? err.name : "unknown");
  return category;
}
