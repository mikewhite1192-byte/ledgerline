import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Session } from "@/lib/auth/claims";
import { isRole, type Role } from "@/lib/auth/role";
import { DbError, type Queryable } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";

// What every signed-in page's shell needs besides the navigation (src/components/app/app-nav):
// the sign-out form and the carrier's name, time zone and the member's email.

export type ShellInfo = { name: string; timezone: string; email: string; role: Role };

export function SignOutForm() {
  return (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );
}

// Inside withRequestTenant: the carrier and the signed-in member, each read naming its tenant.
export async function readShell(q: Queryable, session: Session): Promise<ShellInfo> {
  const tenants = await q.query<{ name: string; timezone: string }>(
    "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
  );
  const members = await q.query<{ email: string; role: unknown }>(
    "SELECT email, role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
  const role = members[0].role;
  if (!isRole(role)) throw new ForbiddenError();
  return { name: tenants[0].name, timezone: tenants[0].timezone, email: members[0].email, role };
}

export type ShellProblem = "forbidden" | "unreadable";

// A read that failed is not an empty page: forbidden or unreadable, and anything else (the
// redirect to /sign-in among them) goes on to Next.
export function shellProblemOf(err: unknown): ShellProblem {
  if (err instanceof ForbiddenError) return "forbidden";
  if (err instanceof DbError) return "unreadable";
  throw err;
}

// The page when the carrier itself could not be read: no shell, just the reason and sign out.
export function ShellProblemPage({ problem }: { problem: ShellProblem }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <h1 className="sr-only">LedgerLine</h1>
        <Wordmark size="lg" className="justify-self-center" />
        <Card>
          <ErrorState category={problem} />
          <div className="border-t border-border p-3">
            <SignOutForm />
          </div>
        </Card>
      </div>
    </main>
  );
}
