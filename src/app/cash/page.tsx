import Link from "next/link";
import { notFound } from "next/navigation";
import { Banknote } from "lucide-react";
import type { ReactNode } from "react";
import { flags } from "@/config/flags";
import { percentOf, proposalCardFrom } from "@/components/agent/proposal-card-from";
import { CashVerdict } from "@/components/cash/cash-verdict";
import { CheckCashButton } from "@/components/cash/check-cash-button";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState } from "@/components/app/states";
import { Day, RecordLink } from "@/components/invoices/cells";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { Card } from "@/components/ui/card";
import { dayWords, engineSentence } from "@/lib/cash/explain";
import {
  BILL_CATEGORY_WORDS,
  BILL_STATUS_WORDS,
  CASH_CARD_NOTICES,
  explainMissing,
  PAYER_WORDS,
  RECEIPT_STATUS_WORDS,
} from "@/lib/cash/labels";
import { readCashView, type CashCheckView, type CashView, type VendorBillView } from "@/lib/cash/view";
import { DbError } from "@/lib/db";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

// Cash Friday: can the bank cover this Friday's driver pay? The latest saved check's figures, the
// moves the engine found as cards a person approves, the customer payments it counted and the
// vendor bills. Every number is from a stored row; the page computes no money. Switched off, the
// page does not exist.

type View = { shell: ShellTenant; cash: CashView; today: string };

// A trucking or pay word a new office clerk may not know, with its meaning on hover.
function Term({ help, children }: { help: string; children: ReactNode }) {
  return (
    <span title={help} className="cursor-help underline decoration-dotted underline-offset-4">
      {children}
    </span>
  );
}

function when(iso: string, timezone: string): string {
  try {
    return formatInstant(iso, timezone);
  } catch {
    return iso;
  }
}

function billStatus(b: VendorBillView): string {
  if (b.status === "deferred" && b.deferredTo) return `Moved to ${formatLocalDate(b.deferredTo)}`;
  if (b.status === "paid" && b.paidOn) return `Paid ${formatLocalDate(b.paidOn)}`;
  return BILL_STATUS_WORDS[b.status];
}

export default async function CashPage() {
  if (!flags.cashFridayEnabled) notFound();
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      return { shell, cash: await readCashView(q), today: carrierToday(shell.timezone, new Date()) };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const { check, bills } = view.cash;
  // The same gate as every other card: the auditor's line, its second confirm and override.
  const audit = { on: flags.auditorEnabled, checking: false };
  const cards: InvoiceCard[] = view.cash.cards.map((p) => ({
    card: proposalCardFrom(p, audit),
    verdict: p.auditorVerdict,
    checkedAt: p.auditorCheckedAt,
    flagged: p.flagged,
  }));

  return (
    <SignedInPage tenant={view.shell} current="/cash" title="Cash">
      <PageHeader
        title="Can we make Friday's pay run?"
        description="LedgerLine adds the cash on hand to the customer payments expected by pay day, then takes out driver pay, fuel card loads and bills due. When it comes up short, it lists ways to cover the gap. Nothing is paid, moved or sent until you approve."
        actions={<CheckCashButton />}
      />
      {check ? (
        <Position check={check} timezone={view.shell.timezone} today={view.today} />
      ) : (
        <Card>
          <EmptyState
            icon={<Banknote aria-hidden />}
            title="No check yet"
            body="Press Check Friday's cash to see whether the bank covers this week's driver pay, and what you can do if it does not."
          />
        </Card>
      )}
      {cards.length > 0 ? (
        <section aria-labelledby="cash-ways" className="grid gap-3">
          <div className="grid gap-1">
            <h3 id="cash-ways" className="text-h2 text-foreground">
              Ways to cover Friday
            </h3>
            <p className="text-body text-foreground-2">
              Each card is one move. Approve the ones you want; a card that says it covers Friday&apos;s short is
              enough on its own.
            </p>
          </div>
          <InvoiceCards
            cards={cards}
            auditorOn={flags.auditorEnabled}
            label="Ways to cover Friday"
            notices={CASH_CARD_NOTICES}
          />
        </section>
      ) : null}
      {check ? <Expected check={check} /> : null}
      <section id="bills" aria-label="Bills" className="scroll-mt-20">
        <DataTable
          caption="Bills"
          rows={bills}
          rowKey={(b) => b.id}
          empty={{
            title: "No bills on file",
            body: "Bills you owe vendors show here, with the ones due by Friday counted in the check.",
          }}
          columns={[
            {
              key: "bill",
              header: "Bill",
              cell: (b) => (
                <RecordLink table="vendor_bills" id={b.id}>
                  {b.billRef}
                </RecordLink>
              ),
            },
            { key: "vendor", header: "Vendor", wrap: true, cell: (b) => b.vendorName },
            { key: "category", header: "For", cell: (b) => BILL_CATEGORY_WORDS[b.category] },
            { key: "amount", header: "Amount", align: "right", cell: (b) => <Money cents={b.amountCents} tone="plain" /> },
            { key: "due", header: "Due", cell: (b) => <Day value={b.dueOn} /> },
            {
              key: "moves",
              header: <Term help="Whether the vendor takes payment after the due date.">Can move</Term>,
              cell: (b) => (b.urgency === "flexible" ? "Yes" : "No"),
            },
            { key: "status", header: "Status", cell: (b) => billStatus(b) },
          ]}
        />
      </section>
    </SignedInPage>
  );
}

// The verdict, the six figures that make it up, and the explanation.
function Position({ check, timezone, today }: { check: CashCheckView; timezone: string; today: string }) {
  const f = check.figures;
  const short = f.gapCents < 0;
  const missing = explainMissing(check.explainCategory);
  return (
    <>
      <CashVerdict gapCents={f.gapCents} day={dayWords(check.payDay)}>
        Checked {when(check.createdAt, timezone)}.{" "}
        {check.asOf < today
          ? "That was before today, so press Check Friday's cash for today's figures."
          : "After you approve a card or a payment comes in, press Check Friday's cash again."}
      </CashVerdict>
      <section aria-label="What makes up Friday" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Cash on hand"
          value={<Money cents={f.cashOnHandCents} tone="plain" />}
          hint={`From the bank balance on ${formatLocalDate(f.balanceAsOf)}`}
        />
        <StatCard
          label="Expected by Friday"
          value={<Money cents={f.expectedReceiptsCents} tone="plain" />}
          hint="Customer payments, by how each customer pays"
          href="#expected"
        />
        <StatCard
          label={<Term help="Every driver's pay for the week, paid on pay day.">Pay run</Term>}
          value={<Money cents={f.payRunCents} tone="plain" />}
          hint={check.payRunSource === "stored" ? "This week's saved pay" : "A preview of this week's pay"}
        />
        <StatCard
          label={<Term help="Money drivers asked to have put on their fuel card before pay day.">Fuel card loads</Term>}
          value={<Money cents={f.fuelLoadsCents} tone="plain" />}
          hint="Asked for and not paid yet"
          href={flags.advancesEnabled ? "/advances" : undefined}
        />
        <StatCard
          label="Bills due"
          value={<Money cents={f.vendorBillsDueCents} tone="plain" />}
          hint="Due by Friday"
          href="#bills"
        />
        <StatCard
          label={short ? "Short" : "To spare"}
          value={<Money cents={Math.abs(f.gapCents)} tone="plain" />}
          hint={short ? "Cash minus what goes out" : "Left after pay day"}
          tone={short ? "destructive" : "neutral"}
        />
      </section>
      <Card className="grid gap-2 px-4 py-4 sm:px-5">
        <p className="text-small font-semibold text-foreground-2">
          {check.explanation ? "Muse Wonder explains" : "LedgerLine says"}
        </p>
        <p className="text-body text-foreground">{check.explanation ?? engineSentence(check.payDay, f)}</p>
        {check.explanation ? (
          <p className="text-small text-muted-foreground">
            Written by Muse Wonder from LedgerLine&apos;s figures; every dollar amount in it was checked against them.{" "}
            <Link href="/models" className="text-link underline-offset-4 hover:underline">
              See the model calls
            </Link>
          </p>
        ) : missing ? (
          <p className="text-small text-muted-foreground">{missing}</p>
        ) : null}
      </Card>
    </>
  );
}

// The open invoices the check looked at, counted ones first.
function Expected({ check }: { check: CashCheckView }) {
  return (
    <section id="expected" aria-label="Expected by Friday" className="scroll-mt-20">
      <DataTable
        caption="Expected by Friday"
        rows={check.lines}
        rowKey={(l) => l.invoiceId}
        empty={{
          title: "No open invoices",
          body: "Nothing is owed by customers right now, so no payment is expected by Friday.",
        }}
        columns={[
          {
            key: "customer",
            header: "Customer",
            wrap: true,
            cell: (l) => (
              <RecordLink table="customers" id={l.customerId}>
                {l.customerName ?? "Customer"}
              </RecordLink>
            ),
          },
          {
            key: "invoice",
            header: "Invoice",
            cell: (l) => (
              <RecordLink table="invoices" id={l.invoiceId}>
                {l.invoiceNumber}
              </RecordLink>
            ),
          },
          { key: "owed", header: "Owed", align: "right", cell: (l) => <Money cents={l.balanceCents} tone="plain" /> },
          { key: "expected", header: "Expected on", cell: (l) => <Day value={l.expectedOn} /> },
          {
            key: "ontime",
            header: <Term help="The share of this customer's past invoices paid by the due date.">On time</Term>,
            align: "right",
            cell: (l) => <span title={PAYER_WORDS[l.label]}>{percentOf(l.onTimeBps)}</span>,
          },
          {
            key: "counted",
            header: "Counted",
            align: "right",
            cell: (l) => <Money cents={l.expectedCents} tone="plain" />,
          },
          { key: "status", header: "For Friday", cell: (l) => RECEIPT_STATUS_WORDS[l.status] },
        ]}
      />
    </section>
  );
}
