import { Wordmark } from "@/components/brand/wordmark";
import { ErrorState } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// The signed-in carrier for the portal run pages, read the way the other pages read it, plus the
// page's own reads in the same transaction. Signed out: withRequestTenant redirects to /sign-in.

export type Carrier = { name: string; timezone: string; email: string; session: Session };
export type CarrierRead<T> = { carrier: Carrier; data: T } | { problem: "forbidden" | "unreadable" };

export async function readCarrier<T>(fn: (q: Queryable, session: Session) => Promise<T>): Promise<CarrierRead<T>> {
  try {
    return await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string }>(
        "SELECT email FROM memberships WHERE cognito_sub = $1 AND tenant_id = current_tenant_id()",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      const carrier = { name: tenants[0].name, timezone: tenants[0].timezone, email: members[0].email, session };
      return { carrier, data: await fn(q, session) };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return { problem: "forbidden" };
    if (err instanceof DbError) return { problem: "unreadable" };
    throw err;
  }
}

export const signOut = (
  <form action="/api/auth/sign-out" method="post">
    <Button type="submit" variant="ghost" className="w-full justify-start">
      Sign out
    </Button>
  </form>
);

export function CarrierProblem({ problem }: { problem: "forbidden" | "unreadable" }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <h1 className="sr-only">LedgerLine</h1>
        <Wordmark size="lg" className="justify-self-center" />
        <Card>
          <ErrorState category={problem} />
          <div className="border-t border-border p-3">{signOut}</div>
        </Card>
      </div>
    </main>
  );
}
