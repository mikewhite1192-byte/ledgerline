import { BellRing } from "lucide-react";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { readCollectionsView, type CollectionsView } from "@/lib/collections/view";
import { approvedWords } from "@/lib/collections/words";
import { formatLocalDate, zoneName } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, shellProblemOf, ShellProblemPage, SignOutForm, type ShellInfo, type ShellProblem } from "../shell";
import { CollectionsBoard, type BoardCard, type BoardLate } from "./collections-board";

export const dynamic = "force-dynamic";

// Invoices at least minDaysLate (30) days past due and the reminder drafted for each. A person
// approves or rejects every reminder; approving records it, and with email switched off (Test mode)
// nothing is sent. Every read runs inside withRequestTenant, so only the signed-in carrier's
// invoices appear.
// With collectionsEnabled off nothing is read but the shell, and the page says it is off.
export default async function CollectionsPage() {
  let data: { shell: ShellInfo; view: CollectionsView | null } | null = null;
  let problem: ShellProblem | null = null;
  const now = new Date();
  try {
    data = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      view: flags.collectionsEnabled ? await readCollectionsView(q, now) : null,
    }));
  } catch (err) {
    problem = shellProblemOf(err);
  }
  if (!data) return <ShellProblemPage problem={problem ?? "unreadable"} />;
  const { shell, view } = data;
  // The planner keeps an invoice exactly this many days late, so the words say "or more".
  const minDays = flags.collectionsLimits.minDaysLate;

  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone, role: shell.role }}
      nav={appNav("/collections")}
      title="Collections"
      signOut={<SignOutForm />}
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6">
        <PageHeader
          title="Collections"
          description={`Invoices ${minDays} or more days past due, with a reminder email drafted for each. You approve every reminder; in Test mode nothing is sent.`}
        />
        {!view ? (
          <Card>
            <FeatureOff name="Collections" />
          </Card>
        ) : view.pastDueCount === 0 && view.cards.length === 0 ? (
          <Card>
            <EmptyState
              icon={<BellRing aria-hidden />}
              title={`Nobody is ${minDays} or more days past due`}
              body="Reminders appear here when an invoice is."
            />
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard
                label={`Past due ${minDays}+ days`}
                value={formatCents(view.pastDueCents)}
                hint={`${view.pastDueCount} ${view.pastDueCount === 1 ? "invoice" : "invoices"}`}
              />
              <StatCard label="Reminders waiting for you" value={view.waiting} />
              <StatCard label="Approved in the last 7 days" value={view.approvedLastWeek} />
            </div>
            <p className="text-small text-foreground-2">
              Figures as of {formatLocalDate(view.asOf)}, {zoneName(view.timezone, now)}.
            </p>
            <CollectionsBoard
              toDraft={view.toDraft.map(lateOf)}
              cards={view.cards.map((c) => cardOf(c, view.timezone))}
              draftOffReason={flags.aiEnabled ? undefined : "The models are switched off, so no reminders can be drafted right now."}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}

const customerHref = (id: string) => hrefOrNull(recordHref, { table: "customers", id });
const invoiceHref = (id: string) => hrefOrNull(recordHref, { table: "invoices", id });

function lateOf(l: CollectionsView["toDraft"][number]): BoardLate {
  return {
    key: `${l.invoiceId}:${l.stage}`,
    customerName: l.customerName,
    invoiceNumber: l.invoiceNumber,
    daysLate: l.daysLate,
    balanceText: formatCents(l.balanceCents),
    invoiceHref: invoiceHref(l.invoiceId),
  };
}

function cardOf(c: CollectionsView["cards"][number], timezone: string): BoardCard {
  let afterText: string | null = null;
  if (c.status === "approved") {
    try {
      afterText = approvedWords(c.channel, c.sentAt, timezone);
    } catch {
      afterText = "Approved";
    }
  }
  return {
    id: c.id,
    status: c.status,
    tone: c.tone,
    customerName: c.customerName,
    customerHref: customerHref(c.customerId),
    invoiceNumber: c.invoiceNumber,
    invoiceHref: invoiceHref(c.invoiceId),
    daysLate: c.daysLate,
    balanceText: formatCents(c.balanceCents),
    dueText: formatLocalDate(c.dueOn),
    subject: c.subject,
    body: c.body,
    refusalCategory: c.refusalCategory,
    afterText,
  };
}
