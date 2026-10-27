import Link from "next/link";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { flags } from "@/config/flags";
import { isAdvanceStatus, readAdvanceList, readShell, type AdvanceListRow, type ListCardLine, type Shell } from "@/lib/advances/read";
import { advancesOn } from "@/lib/advances/switches";
import { cn } from "@/lib/cn";
import { formatLocalDate } from "@/lib/format/dates";
import { statusLabel } from "@/lib/format/labels";
import { SUBJECT_STATUSES } from "@/lib/money/types";
import { withRequestTenant } from "@/lib/tenant/context";
import { AdvanceFrame, AdvancesOffPage, problemOf, ReadFailed, type ReadProblem } from "./frame";

export const dynamic = "force-dynamic";

const DESCRIPTION =
  "Pay a driver draws early, against work already done. The agent checks each request against your pay rules, and nothing is paid until a person approves it.";

// Where an advance went, in the Paid to column: the card by its last four, in the words the record
// page uses for it ("Card on file" is the driver's card now, not one the advance recorded).
function cardWords(line: ListCardLine): string {
  const card = `card ending ${line.card.last4}${line.card.status === "closed" ? ", closed" : ""}`;
  if (line.label === "Card on file") return `On file: ${card}`;
  return `${card[0].toUpperCase()}${card.slice(1)}`;
}

// Every advance on file, newest first: who, when, how much, its status and where it was paid. The
// driver's name opens the advance's record, where the reference, the load and the pay rules check
// are. "Not armed" narrows the list to drivers no one has armed to receive money. Dark while the
// advances switch is off.
export default async function AdvancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!advancesOn()) return <AdvancesOffPage title="Advances" description={DESCRIPTION} />;
  const params = await searchParams;
  const raw = params.status;
  const status = isAdvanceStatus(raw) ? raw : null;
  const notArmed = params.armed === "no";
  const hrefFor = (s: string | null, na: boolean) => {
    const query = [s ? `status=${s}` : null, na ? "armed=no" : null].filter(Boolean).join("&");
    return query ? `/advances?${query}` : "/advances";
  };

  let page: { shell: Shell; rows: AdvanceListRow[] } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      rows: await readAdvanceList(q, status, notArmed),
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
        description={DESCRIPTION}
        actions={
          canRequest ? (
            <Link href="/advances/new" className={buttonVariants({ variant: "primary" })}>
              Request an advance
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
              href={hrefFor(s, notArmed)}
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
        <span aria-hidden className="mx-1 self-center text-muted-foreground">·</span>
        <Link
          href={hrefFor(status, !notArmed)}
          aria-current={notArmed ? "page" : undefined}
          className={cn(
            buttonVariants({ variant: notArmed ? "secondary" : "ghost", size: "sm" }),
            notArmed && "font-semibold",
          )}
        >
          Not armed
        </Link>
      </nav>
      <DataTable<AdvanceListRow>
        caption={`${status ? `${statusLabel(status)} advances` : "All advances"}${notArmed ? ", drivers not armed" : ""}`}
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={{
          title: `${status ? `${statusLabel(status)} advances` : "Advances"}${notArmed ? " for drivers not armed" : ""} appear here`,
          body: canRequest
            ? "When a driver asks for one, it shows up here with the pay rules check. Use Request an advance to start one."
            : "When a driver asks for one, it shows up here with the pay rules check. Requests start once the agent is switched on.",
        }}
        columns={[
          {
            key: "driver",
            header: "Driver",
            cell: (r) => (
              <span className="whitespace-nowrap">
                <Link
                  href={`/records/advances/${r.id}`}
                  aria-label={`Advance for ${r.driverName}, ${formatLocalDate(r.requestedOn)}`}
                  className="font-medium text-link underline-offset-4 hover:underline"
                >
                  {r.driverName}
                </Link>
                <span className="block text-small text-muted-foreground">
                  {r.driverCode}
                  {r.driverArmed ? null : (
                    <Badge tone="warning" className="ml-2">
                      Not armed
                    </Badge>
                  )}
                </span>
              </span>
            ),
          },
          { key: "requested", header: "Requested", cell: (r) => <span className="whitespace-nowrap">{formatLocalDate(r.requestedOn)}</span> },
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} /> },
          { key: "fee", header: "Fee", align: "right", cell: (r) => <Money cents={r.feeCents} /> },
          { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: "paidTo",
            header: "Paid to",
            cell: (r) => (
              <span className="whitespace-nowrap">
                {r.cardLine ? <span className="block">{cardWords(r.cardLine)}</span> : null}
                {r.payoutState ? (
                  <StatusBadge status={r.payoutState} />
                ) : (
                  <span className="block text-small text-muted-foreground">{r.fromFlow ? "Not sent yet" : "Before this app"}</span>
                )}
              </span>
            ),
          },
        ]}
      />
    </AdvanceFrame>
  );
}
