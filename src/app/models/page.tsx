import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { ModelWeekView, type DemoBudget } from "@/components/trace/model-week";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { readAgentModelWeek } from "@/lib/agent/gateway/store";
import type { ModelWeek } from "@/lib/trace/week";
import { capNanocents } from "@/lib/ai/prices";
import { readSpend } from "@/lib/ai/spend";
import type { Session } from "@/lib/auth/claims";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// The Meta models page: this carrier's model calls for the pay week, per model, with the gateway
// and screening totals. Read-only, from the call log; row security limits every read to the
// carrier on the verified token. Signed out: withRequestTenant redirects to /sign-in.
export const dynamic = "force-dynamic";

type Carrier = { name: string; timezone: string; email: string; session: Session };

export default async function ModelsPage() {
  let carrier: Carrier | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    carrier = await withRequestTenant(async (q, session) => {
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
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  const signOut = (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );

  if (!carrier) {
    return (
      <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
        <div className="grid w-full max-w-[440px] gap-6">
          <h1 className="sr-only">LedgerLine</h1>
          <Wordmark size="lg" className="justify-self-center" />
          <Card>
            <ErrorState category={problem === "forbidden" ? "forbidden" : "unreadable"} />
            <div className="border-t border-border p-3">{signOut}</div>
          </Card>
        </div>
      </main>
    );
  }

  // Unknown is not zero: a week that cannot be read shows the error, never an empty week.
  let week: ModelWeek | null = null;
  let weekProblem: "forbidden" | "unreadable" | null = null;
  try {
    week = await readAgentModelWeek(carrier.session);
  } catch (err) {
    weekProblem = err instanceof Error && err.name === "ForbiddenError" ? "forbidden" : "unreadable";
    console.error("model week read failed:", err instanceof Error ? err.name : "unknown");
  }

  // The demo budget line reads the shared spend counter; when it cannot be read it is left out.
  let budget: DemoBudget | null = null;
  if (week) {
    try {
      const spend = await withRequestTenant((q) => readSpend(q));
      budget = { spentNanocents: spend.spentNanocents, capNanocents: capNanocents(process.env.AI_SPEND_CAP_CENTS) };
    } catch (err) {
      if (!(err instanceof DbError)) throw err;
    }
  }

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/models")}
      title="Meta models"
      signOut={signOut}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader
          title="Meta models"
          description="Which Meta model did what for this carrier, how long it took and what it cost. Open How this was worked out under any answer to see one turn's calls."
        />
        {week ? (
          <ModelWeekView week={week} budget={budget} />
        ) : (
          <Card>
            <ErrorState
              category={weekProblem ?? "unreadable"}
              retry={
                <a href="/models" className="text-small font-medium text-primary underline-offset-2 hover:underline">
                  Try again
                </a>
              }
            />
          </Card>
        )}
      </div>
    </AppShell>
  );
}
