import Link from "next/link";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage } from "@/components/app/signed-in-page";
import { Term } from "@/components/app/term";
import { RequestStatus, TestModeBadge } from "@/components/factoring/request-status";
import { Card, CardBody } from "@/components/ui/card";
import { listRequests, type RequestSummary } from "@/lib/factoring/read";
import { factoringOn } from "@/lib/factoring/switches";
import { TEST_MODE_HELP, dayOf } from "@/lib/factoring/words";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { DESCRIPTION, FactoringFrame, FactoringOffPage, problemOf, type ReadProblem } from "./frame";

export const dynamic = "force-dynamic";

// Every factoring request, newest first: what was sold, what came in now, the fee, what is held
// back and where it stands. A row opens the request. No main button: the factoring card is on the
// Cash page and in the chat, and a person approves it there. Every number is a stored row's.
export default async function FactoringPage() {
  if (!factoringOn()) return <FactoringOffPage title="Factoring" />;
  let page: { shell: ShellTenant; rows: RequestSummary[] } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      rows: await listRequests(q, 50),
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const zone = page.shell.timezone;

  return (
    <FactoringFrame shell={page.shell} title="Factoring">
      <PageHeader title="Factoring" description={DESCRIPTION} actions={<TestModeBadge />} />
      <Card>
        <CardBody>
          <p className="text-small text-foreground-2">{TEST_MODE_HELP}</p>
        </CardBody>
      </Card>
      <DataTable<RequestSummary>
        caption="Factoring requests, newest first"
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={{
          title: "No invoices factored yet",
          body: "The Cash page offers factoring when a pay run is short.",
        }}
        columns={[
          {
            key: "date",
            header: "Date",
            cell: (r) => (
              <Link href={`/factoring/${r.id}`} className="font-medium whitespace-nowrap text-link underline-offset-4 hover:underline">
                {dayOf(r.createdAt, zone)}
              </Link>
            ),
          },
          { key: "invoices", header: "Invoices", align: "right", cell: (r) => <span className="tabular-nums">{r.invoiceCount}</span> },
          { key: "advance", header: <Term id="advance-rate">Advance</Term>, align: "right", cell: (r) => <Money cents={r.advanceCents} tone="plain" /> },
          { key: "fee", header: <Term id="factoring-fee">Fee</Term>, align: "right", cell: (r) => <Money cents={r.feeCents} tone="plain" /> },
          { key: "net", header: "You receive", align: "right", cell: (r) => <Money cents={r.netCents} tone="plain" /> },
          { key: "reserve", header: <Term id="held-back">Held back</Term>, align: "right", cell: (r) => <Money cents={r.reserveCents} tone="plain" /> },
          { key: "status", header: "Status", cell: (r) => <RequestStatus status={r.status} /> },
        ]}
      />
    </FactoringFrame>
  );
}
