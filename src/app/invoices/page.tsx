import Link from "next/link";
import { FileText } from "lucide-react";
import { flags } from "@/config/flags";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Day, RecordLink } from "@/components/invoices/cells";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { RefreshButton } from "@/components/invoices/refresh-button";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import { cn } from "@/lib/cn";
import { DbError } from "@/lib/db";
import { QUEUE_REASON_LABELS } from "@/lib/invoices/labels";
import { readInvoiceList, readQueueView, type InvoiceListRow, type QueueItemRow } from "@/lib/invoices/views";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "to-invoice", label: "To invoice" },
  { key: "exceptions", label: "Exceptions" },
  { key: "invoices", label: "Invoices" },
] as const;
type Tab = (typeof TABS)[number]["key"];

type View = {
  shell: ShellTenant;
  open:
    | {
        cards: InvoiceCard[];
        waiting: QueueItemRow[];
        exceptions: QueueItemRow[];
        invoices: InvoiceListRow[];
      }
    | null;
};

// The invoice queue: delivered loads the engine can invoice (one card each after Refresh), loads it
// refuses with the reason, and every invoice with what it still owes. Read in the request's tenant
// transaction; the switch off shows the off state and reads nothing else.
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const asked = (await searchParams).tab;
  const tab: Tab = TABS.some((t) => t.key === asked) ? (asked as Tab) : "to-invoice";
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.invoicesEnabled) return { shell, open: null };
      const queue = await readQueueView(q);
      const proposals = await readEngineProposalViews(q, "invoice_post");
      // The same gate as an agent's card: the auditor's line, its second confirm and override.
      const audit = { on: flags.auditorEnabled, checking: false };
      const cards: InvoiceCard[] = proposals.map((p) => ({
        card: proposalCardFrom(p, audit),
        verdict: p.auditorVerdict,
        checkedAt: p.auditorCheckedAt,
        flagged: p.flagged,
      }));
      const carded = new Set(proposals.map((p) => p.subjectId));
      return {
        shell,
        open: {
          cards,
          waiting: queue.invoiceable.filter((i) => !carded.has(i.loadId)),
          exceptions: queue.exceptions,
          invoices: await readInvoiceList(q, carrierToday(shell.timezone, new Date())),
        },
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;

  return (
    <SignedInPage tenant={view.shell} current="/invoices" title="Invoices">
      <PageHeader
        title="Invoices"
        description="The rules engine prices each delivered load. Approve a card to invoice it."
        actions={view.open ? <RefreshButton /> : undefined}
      />
      {view.open ? (
        <>
          <nav aria-label="Invoice lists" className="flex gap-1 overflow-x-auto border-b border-border">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={`/invoices?tab=${t.key}`}
                aria-current={t.key === tab ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-body whitespace-nowrap",
                  t.key === tab
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-foreground-2 hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {tab === "to-invoice" ? <ToInvoice cards={view.open.cards} waiting={view.open.waiting} /> : null}
          {tab === "exceptions" ? <Exceptions rows={view.open.exceptions} /> : null}
          {tab === "invoices" ? <AllInvoices rows={view.open.invoices} /> : null}
        </>
      ) : (
        <FeatureOff name="Invoices" plural />
      )}
    </SignedInPage>
  );
}

function ToInvoice({ cards, waiting }: { cards: InvoiceCard[]; waiting: QueueItemRow[] }) {
  if (cards.length === 0 && waiting.length === 0) {
    return (
      <EmptyState
        icon={<FileText aria-hidden />}
        title="Nothing to invoice"
        body="Every delivered load is invoiced or waiting on something. Check Exceptions for loads the engine refused."
      />
    );
  }
  return (
    <div className="grid gap-6">
      {cards.length > 0 ? <InvoiceCards cards={cards} auditorOn={flags.auditorEnabled} /> : null}
      {waiting.length > 0 ? (
        <DataTable
          caption="Ready to invoice. Refresh to make a card for each."
          rows={waiting}
          rowKey={(r) => r.loadId}
          columns={[
            { key: "load", header: "Load", cell: (r) => <RecordLink table="loads" id={r.loadId}>{r.loadNumber}</RecordLink> },
            { key: "customer", header: "Customer", wrap: true, cell: (r) => r.customerName },
            { key: "delivered", header: "Delivered", cell: (r) => <Day value={r.deliveredOn} /> },
            {
              key: "total",
              header: "Engine total",
              align: "right",
              cell: (r) => (r.amountCents === null ? "" : <Money cents={r.amountCents} tone="plain" />),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

function Exceptions({ rows }: { rows: QueueItemRow[] }) {
  return (
    <DataTable
      caption="Delivered loads the engine cannot invoice yet"
      rows={rows}
      rowKey={(r) => r.loadId}
      empty={{ title: "No exceptions", body: "Every delivered load has what the engine needs to invoice it." }}
      columns={[
        { key: "load", header: "Load", cell: (r) => <RecordLink table="loads" id={r.loadId}>{r.loadNumber}</RecordLink> },
        { key: "customer", header: "Customer", wrap: true, cell: (r) => r.customerName },
        { key: "delivered", header: "Delivered", cell: (r) => <Day value={r.deliveredOn} /> },
        { key: "why", header: "Why", wrap: true, cell: (r) => (r.reason ? QUEUE_REASON_LABELS[r.reason] : "") },
      ]}
    />
  );
}

function AllInvoices({ rows }: { rows: InvoiceListRow[] }) {
  return (
    <DataTable
      caption="Every invoice, newest first"
      rows={rows}
      rowKey={(r) => r.id}
      empty={{ title: "No invoices yet", body: "Approve a card on To invoice to make the first one." }}
      columns={[
        {
          key: "number",
          header: "Invoice",
          cell: (r) => <RecordLink table="invoices" id={r.id}>{r.invoiceNumber}</RecordLink>,
        },
        {
          key: "customer",
          header: "Customer",
          wrap: true,
          cell: (r) => <RecordLink table="customers" id={r.customerId}>{r.customerName}</RecordLink>,
        },
        { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
        { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
        { key: "balance", header: "Balance", align: "right", cell: (r) => <Money cents={r.balanceCents} tone="plain" /> },
        { key: "due", header: "Due", cell: (r) => <Day value={r.dueOn} /> },
        { key: "qbo", header: "QuickBooks", cell: (r) => (r.posted ? "Posted" : "Not posted") },
      ]}
    />
  );
}
