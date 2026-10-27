import Link from "next/link";
import { Banknote } from "lucide-react";
import { flags } from "@/config/flags";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { RecordLink } from "@/components/invoices/cells";
import { SettlementAction } from "@/components/settlements/action-button";
import { ApproveAll } from "@/components/settlements/approve-all";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { DbError } from "@/lib/db";
import { formatPeriod } from "@/lib/format/dates";
import { readSettlementsView, type SettlementListRow, type SettlementsView } from "@/lib/settlements/views";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; open: SettlementsView | null };

const AUDITOR_WORDS: Readonly<Record<string, string>> = {
  agree: "Agrees",
  disagree: "Disagrees",
  unknown: "Could not tell",
};

// The pay week: "Run the week" drafts every driver's paystub from the rules engine and makes one
// card each; nothing is sent. Each row opens its paystub; "Approve all clean" approves every clean
// one in one confirm. The switch off shows the off state and reads nothing else.
export default async function SettlementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const asked = (await searchParams).period;
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.settlementsEnabled) return { shell, open: null };
      return { shell, open: await readSettlementsView(q, typeof asked === "string" ? asked : null) };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const open = view.open;
  const period = open?.period ?? null;
  const isOpen = period?.status === "open";

  return (
    <SignedInPage tenant={view.shell} current="/settlements" title="Settlements">
      <PageHeader
        title="Settlements"
        description="Your pay rules work out every paystub. Run the week to draft them, then approve."
        actions={
          period && isOpen ? (
            <SettlementAction
              url="/api/settlements/run"
              label="Run the week"
              kind="run"
              variant="outline"
              body={{ periodId: period.id }}
            />
          ) : undefined
        }
      />
      {!open ? (
        <EmptyState
          icon={<Banknote aria-hidden />}
          title="Settlements are off in this environment"
          body="Nothing here is read or written until it is switched on."
        />
      ) : !period ? (
        <EmptyState icon={<Banknote aria-hidden />} title="No pay weeks yet" body="A pay week shows here once it opens." />
      ) : (
        <>
          <nav aria-label="Pay weeks" className="flex gap-1 overflow-x-auto border-b border-border">
            {open.periods.map((p) => (
              <Link
                key={p.id}
                href={`/settlements?period=${encodeURIComponent(p.id)}`}
                aria-current={p.id === period.id ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-body whitespace-nowrap",
                  p.id === period.id
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-foreground-2 hover:text-foreground",
                )}
              >
                {formatPeriod(p.start, p.end)}
                {p.status === "paid" ? " (paid)" : ""}
              </Link>
            ))}
          </nav>
          {open.exemptDrivers.length > 0 ? (
            <details className="text-small">
              <summary className="w-fit cursor-pointer text-link underline-offset-4 hover:underline">
                Insurance exemptions ({open.exemptDrivers.length})
              </summary>
              <ul className="mt-2 grid gap-1">
                {open.exemptDrivers.map((d) => (
                  <li key={d.id}>
                    <RecordLink table="drivers" id={d.id}>
                      {d.name}
                    </RecordLink>{" "}
                    <span className="text-foreground-2">{d.code}, carries own insurance</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {isOpen && flags.batchApproveEnabled ? (
            open.clean.items.length > 0 ? (
              <ApproveAll periodId={period.id} items={open.clean.items} totalCents={open.clean.totalCents} />
            ) : open.rows.length > 0 ? (
              <p className="text-small text-foreground-2">
                Nothing clean yet.{" "}
                {open.awaitingAuditor > 0
                  ? `${open.awaitingAuditor} ${open.awaitingAuditor === 1 ? "paystub waits" : "paystubs wait"} for the second check.`
                  : "Every paystub has an exception, is parked, or pays $0. Open one to approve it on its own."}
              </p>
            ) : null
          ) : null}
          <SettlementTable rows={open.rows} isOpen={isOpen} />
        </>
      )}
    </SignedInPage>
  );
}

function SettlementTable({ rows, isOpen }: { rows: SettlementListRow[]; isOpen: boolean }) {
  return (
    <DataTable
      caption="Paystubs this week, by driver"
      rows={rows}
      rowKey={(r) => r.id}
      empty={{
        title: "No paystubs yet",
        body: isOpen ? "Run the week to draft one for every driver with activity." : "Nothing was paid this week.",
      }}
      columns={[
        {
          key: "driver",
          header: "Driver",
          wrap: true,
          cell: (r) => (
            <RecordLink table="settlements" id={r.id}>
              {r.driverName} <span className="text-foreground-2">{r.driverCode}</span>
            </RecordLink>
          ),
        },
        { key: "gross", header: "Gross", align: "right", cell: (r) => <Money cents={r.grossCents} tone="plain" /> },
        { key: "deductions", header: "Deductions", align: "right", cell: (r) => <Money cents={r.deductionsCents} tone="plain" /> },
        { key: "net", header: "Net", align: "right", cell: (r) => <Money cents={r.netCents} tone="plain" /> },
        { key: "exceptions", header: "Exceptions", align: "right", cell: (r) => String(r.exceptionCount) },
        { key: "auditor", header: "Second check", cell: (r) => (r.auditor ? (AUDITOR_WORDS[r.auditor] ?? "") : "Not checked") },
        {
          key: "status",
          header: "Status",
          wrap: true,
          cell: (r) => (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={r.status} />
              {r.parkedReason ? (
                <>
                  <Badge tone="warning">Parked</Badge>
                  <span className="text-small text-foreground-2">{r.parkedLabel}</span>
                </>
              ) : null}
              {r.clean ? <Badge tone="success">Clean</Badge> : null}
            </span>
          ),
        },
      ]}
    />
  );
}
