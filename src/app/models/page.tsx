import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { ModelWeekView } from "@/components/trace/model-week";
import { jobWords, SpendCard, type SpendCardProps } from "@/components/trace/spend-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { readAgentModelWeek } from "@/lib/agent/gateway/store";
import type { ModelWeek } from "@/lib/trace/week";
import { capNanocents, wonderCapNanocents } from "@/lib/ai/prices";
import { readSpend } from "@/lib/ai/spend";
import { jobCapNanocents, readDaySpend, readSpendAlerts } from "@/lib/ai/watch";
import type { Session } from "@/lib/auth/claims";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { ClearAlertForm } from "./clear-alert-form";

// The Meta models page: the Spend card (budgets, this carrier's last day, and the jobs the spend
// watch stopped, which an admin can clear), then this carrier's model calls for the pay week, per
// model, with the gateway and screening totals. Row security limits every read to the carrier on
// the verified token; the only write is an admin's Clear (./clear-alert-action.ts). Signed out:
// withRequestTenant redirects to /sign-in.
export const dynamic = "force-dynamic";

type Carrier = { name: string; timezone: string; email: string; admin: boolean; session: Session };

type Spend = Omit<SpendCardProps, "timeZone" | "clear">;

// How many alerts the card lists: every open one first, then the newest cleared ones.
const ALERT_ROWS = 20;

export default async function ModelsPage() {
  let carrier: Carrier | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string; role: string }>(
        "SELECT email, role FROM memberships WHERE cognito_sub = $1 AND tenant_id = current_tenant_id()",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      return {
        name: tenants[0].name,
        timezone: tenants[0].timezone,
        email: members[0].email,
        admin: members[0].role === "admin",
        session,
      };
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

  // The Spend card: the shared counter, this carrier's last 24 hours and its alerts, in one read.
  // Unknown is not zero: when any of it cannot be read the card shows the error, never zeros.
  let spend: Spend | null = null;
  try {
    spend = await withRequestTenant(async (q) => {
      const counter = await readSpend(q);
      const day = await readDaySpend(q, null);
      const alerts = await readSpendAlerts(q, ALERT_ROWS);
      const cap = capNanocents(process.env.AI_SPEND_CAP_CENTS);
      return {
        demo: { spentNanocents: counter.spentNanocents, capNanocents: cap },
        wonder: {
          spentNanocents: counter.wonderSpentNanocents,
          capNanocents: wonderCapNanocents(process.env.AI_WONDER_CAP_CENTS, cap),
        },
        day,
        jobCapNanocents: jobCapNanocents(flags.aiJobHourlyCapCents),
        alerts,
      };
    });
  } catch (err) {
    if (!(err instanceof DbError) && !(err instanceof ForbiddenError)) throw err;
    console.error("spend read failed:", err.name);
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
        {spend ? (
          <SpendCard
            {...spend}
            timeZone={carrier.timezone}
            clear={carrier.admin ? (a) => <ClearAlertForm alertId={a.id} job={jobWords(a.purpose)} /> : undefined}
          />
        ) : (
          <Card>
            <ErrorState
              category="unreadable"
              title="Could not read the spend figures"
              retry={
                <a href="/models" className="text-small font-medium text-primary underline-offset-2 hover:underline">
                  Try again
                </a>
              }
            />
          </Card>
        )}
        {week ? (
          <ModelWeekView week={week} />
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
