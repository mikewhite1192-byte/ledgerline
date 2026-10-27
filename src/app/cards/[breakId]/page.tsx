import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState, FeatureOff } from "@/components/app/states";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DismissBreak } from "@/components/cards/dismiss-break";
import { Facts, RecordLink } from "@/components/invoices/cells";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import type { BreakView } from "@/lib/data/card-recon";
import { DbError, type Queryable } from "@/lib/db";
import { breakSentence, breakTitle, dayWords, fixOf, gallons, readCardBreak, severityOf, statusOf, whatLine } from "@/lib/recon/view";
import { money, recordWords, systemWords } from "@/lib/recon/words";
import { readShell } from "@/lib/tenant/shell";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readRecordPage } from "@/app/records/read-record";

export const dynamic = "force-dynamic";

const TITLE = "Card check";

// The payment records that have their own page; any other is named in words only.
const LINKED_RECORDS: readonly string[] = ["advances", "settlements", "invoices", "customer_payments"];

type PageData = { brk: BreakView; cards: InvoiceCard[] };

async function readPage(q: Queryable, id: string): Promise<PageData | null> {
  const brk = await readCardBreak(q, id);
  if (!brk) return null;
  // The match waiting for a person, through the same gate as any card. Only an open card
  // difference has one; a closed one shows its outcome.
  if (brk.status !== "open" || brk.fixKind !== "card_match" || !brk.transaction) return { brk, cards: [] };
  const audit = { on: flags.auditorEnabled, checking: false };
  const proposals = await readEngineProposalViews(q, "card_match", 5, brk.transaction.id);
  const cards = proposals.map((p) => ({
    card: proposalCardFrom(p, audit),
    verdict: p.auditorVerdict,
    checkedAt: p.auditorCheckedAt,
    flagged: p.flagged,
  }));
  return { brk, cards };
}

async function readOffShell() {
  try {
    return await withRequestTenant(async (q, session) => ({ shell: await readShell(q, session) }));
  } catch (err) {
    if (err instanceof ForbiddenError) return { problem: "forbidden" as const };
    if (err instanceof DbError) return { problem: "unreadable" as const };
    throw err;
  }
}

function Ours({ brk }: { brk: BreakView }) {
  const record = brk.record;
  const linked = record && LINKED_RECORDS.includes(record.subjectTable);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Our records</CardTitle>
      </CardHeader>
      <CardBody>
        <Facts
          items={[
            { label: "Amount", value: money(brk.ourCents) },
            {
              label: "Payment record",
              value: record ? (
                linked ? (
                  <RecordLink table={record.subjectTable} id={record.subjectId}>
                    {recordWords({ transaction: null, record })}
                  </RecordLink>
                ) : (
                  recordWords({ transaction: null, record })
                )
              ) : (
                "None on file"
              ),
            },
            { label: "Fuel purchase", value: brk.purchaseId ? "On file" : "None on file" },
            {
              label: "Driver",
              value: brk.driver ? (
                <RecordLink table="drivers" id={brk.driver.id}>
                  {brk.driver.code}
                </RecordLink>
              ) : (
                "Not known"
              ),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}

function Theirs({ brk }: { brk: BreakView }) {
  const t = brk.transaction;
  const g = gallons(t?.gallonsMilli ?? null);
  const where = t ? "The card provider" : systemWords(brk.outsideSystem);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{`${where.charAt(0).toUpperCase()}${where.slice(1)}`}</CardTitle>
      </CardHeader>
      <CardBody>
        <Facts
          items={[
            { label: "Amount", value: money(brk.outsideCents) },
            ...(t
              ? [
                  { label: "Card", value: `Card ending ${t.last4}` },
                  { label: "Where", value: t.portalName },
                  { label: "Posted", value: dayWords(t.postedOn) },
                  { label: "State", value: t.state ?? "Not given" },
                  ...(g ? [{ label: "Gallons", value: g }] : []),
                ]
              : []),
          ]}
        />
      </CardBody>
    </Card>
  );
}

// One difference: what our records say, what the other system says, why they differ, and the one
// way to close it (approve the match, wait for a later read, or dismiss it with a reason). Dark
// while its switch is off. A missing id and another carrier's id read the same "not here".
export default async function CardBreakPage({ params }: { params: Promise<{ breakId: string }> }) {
  const { breakId } = await params;
  if (!flags.cardRecon.enabled) {
    const off = await readOffShell();
    if ("problem" in off) return <NoCarrierPage problem={off.problem} />;
    return (
      <SignedInPage tenant={off.shell} current="/cards" title={TITLE}>
        <PageHeader title={TITLE} />
        <FeatureOff name={TITLE} />
      </SignedInPage>
    );
  }
  const page = await readRecordPage(breakId, readPage);
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  const back = (
    <Link href="/cards" className="text-link underline-offset-4 hover:underline">
      Back to Card check
    </Link>
  );
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/cards" title={TITLE}>
        <PageHeader title={TITLE} />
        <Card>
          <ErrorState category="not_found" retry={back} />
        </Card>
      </SignedInPage>
    );
  }
  const { brk, cards } = page.record;
  const status = statusOf(brk);
  const severity = severityOf(brk);
  return (
    <SignedInPage tenant={page.shell} current="/cards" title={breakTitle(brk)}>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {breakTitle(brk)}
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            {whatLine(brk)}
            <Badge tone="neutral">Test mode</Badge>
          </span>
        }
      />
      <Card className="grid gap-2 px-4 py-4 sm:px-5">
        <p className="text-body text-foreground">{breakSentence(brk)}</p>
        <p className="flex flex-wrap items-center gap-2 text-small text-foreground-2">
          <span>How serious:</span>
          <Badge tone={severity.tone}>{severity.label}</Badge>
          <span>The fix: {fixOf(brk)}</span>
        </p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Ours brk={brk} />
        <Theirs brk={brk} />
      </div>
      {cards.length > 0 ? <InvoiceCards cards={cards} auditorOn={flags.auditorEnabled} /> : null}
      {brk.status === "open" ? <DismissBreak breakId={brk.id} /> : null}
      <p className="text-small">{back}</p>
    </SignedInPage>
  );
}
