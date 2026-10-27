import Link from "next/link";
import { flags } from "@/config/flags";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { Paystub } from "@/components/app/paystub";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { RecordLink } from "@/components/invoices/cells";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { SettlementAction } from "@/components/settlements/action-button";
import { Badge } from "@/components/ui/badge";
import { InlineAlert } from "@/components/ui/inline-alert";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import type { Queryable } from "@/lib/db";
import { formatInstant } from "@/lib/format/dates";
import { codeToWords } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { LEG_LABELS, settlementOutcome } from "@/lib/settlements/labels";
import { readSettlementRecord, type SettlementRecordView } from "@/lib/settlements/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

type PageData = { view: SettlementRecordView; cards: InvoiceCard[] };

async function readPage(q: Queryable, id: string): Promise<PageData | null> {
  const view = await readSettlementRecord(q, id);
  if (!view) return null;
  // The waiting card, through the same gate as any card. A parked draft shows no Approve.
  if (view.settlement.parkedReason !== null) return { view, cards: [] };
  const audit = { on: flags.auditorEnabled, checking: false };
  const proposals = await readEngineProposalViews(q, "settlement_approve", 5, id);
  const zero = view.settlement.netCents === 0;
  const cards = proposals.map((p) => {
    const card = proposalCardFrom(p, audit);
    return {
      // A $0 week sends nothing: the confirm says so in words.
      card: zero ? { ...card, confirmQuestion: "Approve and carry forward (no payout)?" } : card,
      verdict: p.auditorVerdict,
      checkedAt: p.auditorCheckedAt,
      flagged: p.flagged,
    };
  });
  return { view, cards };
}

// One driver's paystub for one week: the engine's lines and totals, why it was flagged, the card to
// approve it, and the three money legs (payout, bill, bill payment) with their states.
export default async function SettlementRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, readPage);
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/settlements" title="Paystub">
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const { view, cards } = page.record;
  const s = view.settlement;
  const tz = page.shell.timezone;
  const payout = view.latest.settlement_payout;
  const bill = view.latest.settlement_bill;
  const billPayment = view.latest.settlement_bill_payment;
  const canPost =
    flags.settlementsEnabled && s.status === "paid" && s.netCents > 0 && !(bill === "confirmed" && billPayment === "confirmed");
  const canRetry =
    flags.settlementsEnabled && s.status === "approved" && s.netCents > 0 && (payout === null || payout === "failed" || payout === "reserved");
  const ask = `/?paystub=${encodeURIComponent(s.id)}`;
  return (
    <SignedInPage tenant={page.shell} current="/settlements" title={`Paystub ${view.driver.name}`}>
      <PageHeader
        title={view.driver.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <RecordLink table="drivers" id={view.driver.id}>
              {view.driver.code}
            </RecordLink>
            {view.driver.ownInsurance ? <Badge tone="info">Carries own insurance</Badge> : null}
            <Link href={`/settlements?period=${encodeURIComponent(view.period.id)}`} className="text-link underline-offset-4 hover:underline">
              Back to the week
            </Link>
          </span>
        }
        actions={<StatusBadge status={s.status} />}
      />
      {s.parkedReason && s.parkedAt ? (
        <InlineAlert tone="warning">
          Parked on {formatInstant(s.parkedAt, tz)}: {view.parkedLabel}. Run the week to recompute.
        </InlineAlert>
      ) : null}
      {s.netCents === 0 && s.carryForwardCents > 0 ? (
        <InlineAlert tone="info">
          Net pay is $0 this week. {formatCents(s.carryForwardCents)} carries to next week as its own line.
        </InlineAlert>
      ) : null}
      {view.proposal?.note && view.proposal.status !== "proposed" ? (
        <p className="text-small text-foreground-2">{settlementOutcome(view.proposal.note)}</p>
      ) : null}
      <Paystub
        driver={{ name: view.driver.name, code: view.driver.code, workerType: view.driver.workerType }}
        period={{ start: view.period.start, end: view.period.end }}
        status={s.status}
        lines={view.lines}
        grossCents={s.grossCents}
        deductionsCents={s.deductionsCents}
        netCents={s.netCents}
        carryForwardCents={s.carryForwardCents}
        exceptions={(view.proposal?.exceptions ?? []).map((e) => ({ ...e, sources: [] }))}
      />
      <p className="text-small">
        <Link href={ask} className="text-link underline-offset-4 hover:underline">
          Ask about this paystub
        </Link>
      </p>
      {cards.length > 0 ? <InvoiceCards cards={cards} auditorOn={flags.auditorEnabled} /> : null}
      {canRetry ? (
        <SettlementAction url={`/api/settlements/${encodeURIComponent(s.id)}/retry-payout`} label="Retry payout" kind="retry" />
      ) : null}
      {canPost ? (
        <SettlementAction
          url={`/api/settlements/${encodeURIComponent(s.id)}/post`}
          label="Post to QuickBooks"
          kind="post"
          variant="outline"
        />
      ) : null}
      <DataTable
        caption="Money legs"
        rows={view.legs}
        rowKey={(r) => r.id}
        empty={{ title: "Nothing sent yet", body: "The payout, the bill and its payment show here once approved." }}
        columns={[
          { key: "leg", header: "Leg", cell: (r) => LEG_LABELS[r.kind] },
          { key: "attempt", header: "Attempt", cell: (r) => `#${r.attempt}` },
          { key: "state", header: "State", cell: (r) => <StatusBadge status={r.state} /> },
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
          { key: "why", header: "Why", cell: (r) => (r.failureCategory ? codeToWords(r.failureCategory) : "") },
          { key: "at", header: "Reserved", cell: (r) => formatInstant(r.createdAt, tz) },
        ]}
      />
    </SignedInPage>
  );
}
