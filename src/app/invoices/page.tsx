import Link from "next/link";
import { FileText } from "lucide-react";
import { flags } from "@/config/flags";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Day, RecordLink } from "@/components/invoices/cells";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { RefreshButton } from "@/components/invoices/refresh-button";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import { cn } from "@/lib/cn";
import { DbError } from "@/lib/db";
import { accountingLine, QUEUE_REASON_LABELS, REVIEW_STATUS_LABELS } from "@/lib/invoices/labels";
import { readReviewQueue, type ReviewQueue } from "@/lib/invoices/review-read";
import { readInvoiceList, readQueueView, type InvoiceListRow, type QueueItemRow } from "@/lib/invoices/views";
import { formatLocalDate } from "@/lib/format/dates";
import { INVOICE_REVIEW_STATUSES, type InvoiceReviewStatus } from "@/lib/rules-engine";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "review", label: "Review" },
  { key: "to-invoice", label: "To invoice" },
  { key: "exceptions", label: "Exceptions" },
  { key: "invoices", label: "Invoices" },
] as const;
type Tab = (typeof TABS)[number]["key"];

// The Review tab shows, and is the first tab, only while the review switch is on.
const reviewOn = () => flags.invoicesEnabled && flags.invoiceReviewEnabled;
const tabsShown = () => TABS.filter((t) => t.key !== "review" || reviewOn());
const isReviewStatus = (v: unknown): v is InvoiceReviewStatus =>
  typeof v === "string" && (INVOICE_REVIEW_STATUSES as readonly string[]).includes(v);

type View = {
  shell: ShellTenant;
  open:
    | {
        cards: InvoiceCard[];
        waiting: QueueItemRow[];
        exceptions: QueueItemRow[];
        invoices: InvoiceListRow[];
        review: ReviewQueue | null;
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
  const params = await searchParams;
  const asked = params.tab;
  const shown = tabsShown();
  const tab: Tab = shown.some((t) => t.key === asked) ? (asked as Tab) : shown[0].key;
  const filter = isReviewStatus(params.status) ? params.status : undefined;
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
          // The review is read only on its own tab and only while its switch is on.
          review: tab === "review" && reviewOn() ? await readReviewQueue(q, filter) : null,
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
            {shown.map((t) => (
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
          {tab === "review" && view.open.review ? <Review queue={view.open.review} filter={filter} /> : null}
          {tab === "to-invoice" ? <ToInvoice cards={view.open.cards} waiting={view.open.waiting} /> : null}
          {tab === "exceptions" ? <Exceptions rows={view.open.exceptions} /> : null}
          {tab === "invoices" ? <AllInvoices rows={view.open.invoices} /> : null}
        </>
      ) : (
        <EmptyState
          icon={<FileText aria-hidden />}
          title="Invoicing is off in this environment"
          body="Nothing here is read or written until it is switched on."
        />
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

function Review({ queue, filter }: { queue: ReviewQueue; filter: InvoiceReviewStatus | undefined }) {
  const total = INVOICE_REVIEW_STATUSES.reduce((n, st) => n + queue.counts[st], 0);
  const chip = (active: boolean) =>
    cn(
      "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-small whitespace-nowrap",
      active ? "border-primary bg-accent text-foreground" : "border-border text-foreground-2 hover:text-foreground",
    );
  return (
    <div className="grid gap-4">
      <nav aria-label="Review statuses" className="flex flex-wrap gap-2">
        <Link href="/invoices?tab=review" aria-current={filter === undefined ? "page" : undefined} className={chip(filter === undefined)}>
          All <span className="tabular-nums">{total}</span>
        </Link>
        {INVOICE_REVIEW_STATUSES.map((st) => (
          <Link
            key={st}
            href={`/invoices?tab=review&status=${st}`}
            aria-current={filter === st ? "page" : undefined}
            className={chip(filter === st)}
          >
            <StatusBadge status={st} label={REVIEW_STATUS_LABELS[st]} />
            <span className="tabular-nums">{queue.counts[st]}</span>
          </Link>
        ))}
      </nav>
      <DataTable
        caption={
          filter === undefined
            ? "Invoices to review before they go out, worst first"
            : `${REVIEW_STATUS_LABELS[filter]}, newest first`
        }
        rows={queue.rows}
        rowKey={(r) => r.id}
        empty={{
          title: filter === undefined ? "Nothing to review" : "None with this status",
          body: "Every live invoice is ready and recorded as sent.",
        }}
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
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
          { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} label={r.statusLabel} /> },
          { key: "why", header: "First reason", wrap: true, cell: (r) => r.firstReasonLabel ?? "" },
          {
            key: "accounting",
            header: "Accounting",
            wrap: true,
            cell: (r) =>
              accountingLine({
                posted: r.posted,
                madeByQueue: r.madeByQueue,
                emailStatus: r.emailStatus,
                sentOn: r.sentOn === null ? null : formatLocalDate(r.sentOn),
                sentBy: null,
              }),
          },
        ]}
      />
    </div>
  );
}
