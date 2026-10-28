import Link from "next/link";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { percentOf } from "@/components/agent/proposal-card-from";
import { CheckPendingButton } from "@/components/factoring/check-pending-button";
import { RequestStatus, TestModeBadge } from "@/components/factoring/request-status";
import { Facts, RecordLink } from "@/components/invoices/cells";
import { Card, CardBody } from "@/components/ui/card";
import { readRequest, type RequestDetail, type RequestLine } from "@/lib/factoring/read";
import { factoringOn } from "@/lib/factoring/switches";
import { TEST_MODE_HELP, dayOf, packetLine, receiveLine } from "@/lib/factoring/words";
import { formatCents } from "@/lib/format/money";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { isUuid } from "@/lib/uuid";
import { FactoringFrame, FactoringOffPage, problemOf, type ReadProblem } from "../frame";

export const dynamic = "force-dynamic";

const WAITING = new Set(["submitted", "unknown"]);

// One invoice's papers, each on-file paper a link to where it is kept.
function Papers({ line }: { line: RequestLine }) {
  const p = line.packet;
  const links: { href: string; label: string }[] = [];
  if (p.rateConfirmation.documentId) links.push({ href: `/documents/${p.rateConfirmation.documentId}`, label: "Rate confirmation" });
  if (p.billOfLading.documentId) links.push({ href: `/documents/${p.billOfLading.documentId}`, label: "Bill of lading" });
  if (p.pod.portalRunId) links.push({ href: `/portal-runs/${p.pod.portalRunId}`, label: "POD" });
  return (
    <span className="grid gap-0.5">
      <span>{packetLine(p)}</span>
      {links.length > 0 ? (
        <span className="flex flex-wrap gap-x-3 text-small">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="text-link underline-offset-4 hover:underline">
              {l.label}
            </Link>
          ))}
        </span>
      ) : null}
    </span>
  );
}

// One factoring request: each invoice sold, what came in for it now, the fee, what is held back,
// where it stands and the papers sent with it. "Check pending" shows while any invoice was sent
// but not confirmed yet; it reads back and never sends again. Every number is a stored row's.
export default async function FactoringRequestPage({ params }: { params: Promise<{ id: string }> }) {
  if (!factoringOn()) return <FactoringOffPage title="Factoring request" />;
  const { id } = await params;
  let page: { shell: ShellTenant; request: RequestDetail | null } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => {
      const shell = await readShell(q, session);
      return { shell, request: isUuid(id) ? await readRequest(q, id.toLowerCase()) : null };
    });
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const r = page.request;
  if (!r) {
    return (
      <FactoringFrame shell={page.shell} title="Factoring request">
        <PageHeader title="Factoring request" />
        <ErrorState category="not_found" />
      </FactoringFrame>
    );
  }
  const zone = page.shell.timezone;
  const waiting = r.lines.some((l) => WAITING.has(l.status));
  const refs = r.lines.filter((l) => l.providerRef !== null);

  return (
    <FactoringFrame shell={page.shell} title="Factoring request">
      <PageHeader
        title={`Factoring request, ${dayOf(r.createdAt, zone)}`}
        description={receiveLine(formatCents(r.netCents), formatCents(r.reserveCents), formatCents(r.feeCents))}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <TestModeBadge />
            <RequestStatus status={r.status} />
          </span>
        }
      />
      <Card>
        <CardBody className="grid gap-4">
          <Facts
            items={[
              { label: "Invoices", value: <span className="tabular-nums">{r.invoiceCount}</span> },
              { label: "Owed on them", value: <Money cents={r.balanceCents} tone="plain" /> },
              { label: "Advance", value: <Money cents={r.advanceCents} tone="plain" />, term: "advance-rate" },
              { label: "Fee", value: <Money cents={r.feeCents} tone="plain" />, term: "factoring-fee" },
              { label: "You receive", value: <Money cents={r.netCents} tone="plain" /> },
              { label: "Held back", value: <Money cents={r.reserveCents} tone="plain" />, term: "held-back" },
              { label: "Rates", value: `${percentOf(r.advanceBps)} paid now, fee ${percentOf(r.feeBps)}` },
              { label: "Funded", value: r.fundedAt ? dayOf(r.fundedAt, zone) : "Not yet" },
            ]}
          />
          <p className="text-small text-foreground-2">{TEST_MODE_HELP}</p>
        </CardBody>
      </Card>
      {waiting ? <CheckPendingButton url={`/api/factoring/${encodeURIComponent(r.id)}/check`} /> : null}
      <DataTable<RequestLine>
        caption="Invoices in this request"
        rows={r.lines}
        rowKey={(l) => l.id}
        empty={{ title: "No invoices on this request" }}
        columns={[
          {
            key: "invoice",
            header: "Invoice",
            cell: (l) => <RecordLink table="invoices" id={l.invoiceId}>{l.invoiceNumber}</RecordLink>,
          },
          {
            key: "customer",
            header: "Customer",
            wrap: true,
            cell: (l) => <RecordLink table="customers" id={l.customerId}>{l.customerName}</RecordLink>,
          },
          { key: "balance", header: "Owed", align: "right", cell: (l) => <Money cents={l.balanceCents} tone="plain" /> },
          { key: "advance", header: "Advance", align: "right", cell: (l) => <Money cents={l.advanceCents} tone="plain" /> },
          { key: "fee", header: "Fee", align: "right", cell: (l) => <Money cents={l.feeCents} tone="plain" /> },
          { key: "net", header: "You receive", align: "right", cell: (l) => <Money cents={l.netCents} tone="plain" /> },
          { key: "reserve", header: "Held back", align: "right", cell: (l) => <Money cents={l.reserveCents} tone="plain" /> },
          { key: "status", header: "Status", cell: (l) => <RequestStatus status={l.status} /> },
          { key: "papers", header: "Papers sent", wrap: true, cell: (l) => <Papers line={l} /> },
        ]}
      />
      {refs.length > 0 ? (
        <details className="text-small">
          <summary className="cursor-pointer text-link">Details</summary>
          <ul className="mt-2 grid gap-1 text-muted-foreground">
            {refs.map((l) => (
              <li key={l.id}>
                {l.invoiceNumber}: <Term id="factoring">factoring</Term> partner reference {l.providerRef}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </FactoringFrame>
  );
}
