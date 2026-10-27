import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { flags } from "@/config/flags";
import { isAdvanceStatus, readAdvanceList, readShell, type AdvanceListRow, type Shell } from "@/lib/advances/read";
import { sourceWords } from "@/lib/advances/request";
import { advancesOn } from "@/lib/advances/switches";
import { cn } from "@/lib/cn";
import { formatLocalDate } from "@/lib/format/dates";
import { statusLabel } from "@/lib/format/labels";
import { SUBJECT_STATUSES } from "@/lib/money/types";
import { withRequestTenant } from "@/lib/tenant/context";
import { AdvanceFrame, problemOf, ReadFailed, type ReadProblem } from "./frame";

export const dynamic = "force-dynamic";

// Every advance on file, newest first, with the latest payout's state. A row opens the advance's
// record. Dark while the advances switch is off.
export default async function AdvancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!advancesOn()) notFound();
  const raw = (await searchParams).status;
  const status = isAdvanceStatus(raw) ? raw : null;

  let page: { shell: Shell; rows: AdvanceListRow[] } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      rows: await readAdvanceList(q, status),
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;

  const canRequest = flags.agentEnabled && flags.aiEnabled;
  return (
    <AdvanceFrame shell={page.shell} title="Advances">
      <PageHeader
        title="Advances"
        description="Money a driver draws against pay already earned. The agent checks the pay rules and proposes; a person approves every payout."
        actions={
          canRequest ? (
            <Link href="/advances/new" className={buttonVariants({ variant: "primary" })}>
              New request
            </Link>
          ) : null
        }
      />
      <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
        {[null, ...SUBJECT_STATUSES.advances].map((s) => {
          const current = s === status;
          return (
            <Link
              key={s ?? "all"}
              href={s ? `/advances?status=${s}` : "/advances"}
              aria-current={current ? "page" : undefined}
              className={cn(
                buttonVariants({ variant: current ? "secondary" : "ghost", size: "sm" }),
                current && "font-semibold",
              )}
            >
              {s ? statusLabel(s) : "All"}
            </Link>
          );
        })}
      </nav>
      <DataTable<AdvanceListRow>
        caption={status ? `${statusLabel(status)} advances` : "All advances"}
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={{
          title: "No advances yet",
          body: canRequest ? "Ask the agent or start a request." : "Ask the agent once it is switched on.",
        }}
        columns={[
          {
            key: "ref",
            header: "Reference",
            cell: (r) => (
              <Link href={`/records/advances/${r.id}`} className="font-medium text-link underline-offset-4 hover:underline">
                {r.requestRef}
              </Link>
            ),
          },
          {
            key: "driver",
            header: "Driver",
            cell: (r) => (
              <span className="whitespace-nowrap">
                {r.driverName}
                <span className="block text-small text-muted-foreground">{r.driverCode}</span>
              </span>
            ),
          },
          { key: "requested", header: "Requested", cell: (r) => <span className="whitespace-nowrap">{formatLocalDate(r.requestedOn)}</span> },
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} /> },
          { key: "fee", header: "Fee", align: "right", cell: (r) => <Money cents={r.feeCents} /> },
          { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: "payout",
            header: "Payout",
            cell: (r) => (
              <span className="whitespace-nowrap">
                {r.payoutState ? (
                  <StatusBadge status={r.payoutState} />
                ) : (
                  <span className="text-muted-foreground">{r.fromFlow ? "Not sent" : "On file"}</span>
                )}
                {r.cardLine ? (
                  <span className="block text-small text-muted-foreground">
                    {r.cardLine.label} ···· {r.cardLine.card.last4}
                    {r.cardLine.card.status === "closed" ? ", closed" : ""}
                  </span>
                ) : null}
              </span>
            ),
          },
          { key: "source", header: "Source", cell: (r) => sourceWords(r.source) },
        ]}
      />
    </AdvanceFrame>
  );
}
