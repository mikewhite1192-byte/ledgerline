import { ImageIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState, FeatureOff } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { CardsBoard, type BoardRow } from "@/components/pay-cards/cards-board";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { formatPeriod } from "@/lib/format/dates";
import { readPeriodCards, type PeriodCards } from "@/lib/pay-cards/read";
import { withRequestTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import {
  readShell,
  shellProblemOf,
  ShellProblemPage,
  SignOutForm,
  type ShellInfo,
  type ShellProblem,
} from "../../../shell";

export const dynamic = "force-dynamic";

// One pay week's pay cards: a picture of each driver's approved pay for the clerk to save and send
// from their own phone. Each card is drawn in the browser from the server's figures and kept only
// after a second model read every figure back as the paystub's own. The app sends nothing.
export default async function PayCardsPage({ params }: { params: Promise<{ periodId: string }> }) {
  const { periodId } = await params;
  if (!isUuid(periodId)) notFound();

  let data: { shell: ShellInfo; cards: PeriodCards | null } | null = null;
  let problem: ShellProblem | null = null;
  try {
    data = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      cards: flags.payCardsEnabled ? await readPeriodCards(q, periodId) : null,
    }));
  } catch (err) {
    problem = shellProblemOf(err);
  }
  if (!data) return <ShellProblemPage problem={problem ?? "unreadable"} />;
  const { shell, cards } = data;

  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone, role: shell.role }}
      nav={appNav("/driver-notes")}
      title="Pay cards"
      signOut={<SignOutForm />}
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6">
        <Link href="/driver-notes" className="w-fit text-small text-link underline-offset-4 hover:underline">
          All pay periods
        </Link>
        {!flags.payCardsEnabled ? (
          <>
            <PageHeader title="Pay cards" />
            <Card>
              <FeatureOff name="Pay cards" plural />
            </Card>
          </>
        ) : !cards ? (
          <>
            <PageHeader title="Pay cards" />
            <Card>
              <ErrorState category="not_found" />
            </Card>
          </>
        ) : (
          <>
            <Link
              href={`/pay/${cards.period.id}/notes`}
              className="w-fit text-small text-link underline-offset-4 hover:underline"
            >
              Back to this week&apos;s notes
            </Link>
            <PageHeader
              title={`Pay cards for the week of ${formatPeriod(cards.period.periodStart, cards.period.periodEnd)}`}
              description="A picture of each driver's pay to save and send from your phone. A second model reads every card back against the paystub before it can be saved."
            />
            <p className="text-small text-foreground-2">
              Each card shows the driver&apos;s <Term id="take-home-pay">take-home pay</Term> and is marked{" "}
              <Term id="test-payout">Test mode</Term>, because no real money moves in this demo.
            </p>
            {cards.rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<ImageIcon aria-hidden />}
                  title="Pay cards appear here once the week is approved"
                  body="Approve the pay run first."
                />
              </Card>
            ) : (
              <CardsBoard
                rows={cards.rows.map(
                  (r): BoardRow => ({
                    settlementId: r.settlementId,
                    driverName: r.driverName,
                    spec: r.spec,
                    pill: r.pill,
                    reason: r.reason,
                    checkedId: r.checkedId,
                    attemptsUsed: r.attemptsUsed,
                  }),
                )}
                offReason={flags.aiEnabled ? undefined : "The models are switched off, so no card can be checked right now."}
                maxPngBytes={flags.payCardLimits.maxPngBytes}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
