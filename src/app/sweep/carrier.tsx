import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState, FeatureOff } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Session } from "@/lib/auth/claims";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// What the sweep pages share: the signed-in carrier (row security limits every read to the one on
// the verified token; signed out, withRequestTenant redirects to /sign-in), the sign-out form, and
// the page shown when the carrier cannot be read.

export type SweepCarrier = { name: string; timezone: string; email: string; session: Session };

export async function readCarrier(): Promise<{ carrier: SweepCarrier } | { problem: "forbidden" | "unreadable" }> {
  try {
    const carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string }>(
        "SELECT email FROM memberships WHERE cognito_sub = $1 AND tenant_id = current_tenant_id()",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      return { name: tenants[0].name, timezone: tenants[0].timezone, email: members[0].email, session };
    });
    return { carrier };
  } catch (err) {
    // Anything else (the redirect to /sign-in among them) goes on to Next.
    if (err instanceof ForbiddenError) return { problem: "forbidden" };
    if (err instanceof DbError) return { problem: "unreadable" };
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

// A sweep page while the sweep switch is off: the shell, the page's title, and the off state. It
// reads only the carrier chip, never a sweep.
export async function SweepOffPage({ title, description }: { title: string; description?: string }) {
  const read = await readCarrier();
  if ("problem" in read) return <NoCarrier problem={read.problem} />;
  const { carrier } = read;
  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/sweep")}
      title={title}
      signOut={<SignOut />}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader title={title} description={description} />
        <FeatureOff name="The pay sweep" />
      </div>
    </AppShell>
  );
}
