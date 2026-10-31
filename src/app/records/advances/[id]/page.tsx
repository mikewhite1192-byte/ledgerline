import Link from "next/link";
import type { ReactNode } from "react";
import { FuelCardChip } from "@/components/app/fuel-card";
import { LedgerEntryRow } from "@/components/app/ledger-entry";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { flags } from "@/config/flags";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import { AdvanceFrame, AdvancesOffPage, problemOf, ReadFailed, type ReadProblem } from "@/app/advances/frame";
import { cardLineFor, readAdvanceRecord, readShell, type AdvanceRecord, type EligibilityNow, type Shell } from "@/lib/advances/read";
import { PARK_REASON_WORDS } from "@/lib/advances/parking";
import { decisionNoteSentence, refusalSentence } from "@/lib/advances/reasons";
import { sourceWords } from "@/lib/advances/request";
import { takebackReasonWords } from "@/lib/advances/takeback-words";
import { advancesOn } from "@/lib/advances/switches";
import { pullbackOn } from "@/lib/pullbacks/switches";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
import { codeToWords, recordNamer } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { hrefOrNull, recordHref, type SourceRef } from "@/lib/records/href";
import type { AdvanceRefusal } from "@/lib/rules-engine/types";
import { isUuid } from "@/lib/uuid";
import { withRequestTenant } from "@/lib/tenant/context";
import { RecordActionButtons } from "./record-actions";
import { TakeBack } from "./take-back";

export const dynamic = "force-dynamic";

// The agent's own judgment of the request, in words; any other code reads as its words.
const AGENT_CHECK: Readonly<Record<string, string>> = {
  eligible: "Within the pay rules",
  partial: "Within the pay rules for part of the amount",
  ineligible: "Outside the pay rules",
  not_given: "Not given",
};

// Each pay rule the advance check runs, as a plain line read with "yes" or "no". The rules engine
// runs every one and lists each that fails, so a rule not listed passed. The load's cap is a rule
// only when the load has one.
const RULE_LINES: Readonly<Record<AdvanceRefusal, (e: EligibilityNow) => string>> = {
  driver_inactive: () => "The driver is active",
  driver_not_armed: () => "The driver is armed to receive money",
  below_minimum: (e) => `At least the carrier's smallest advance, ${formatCents(e.minCents)}`,
  no_unpaid_earnings: () => "The driver has earned pay that is not paid yet",
  exceeds_earned_share: () => "Within the share of earned, unpaid pay the carrier allows",
  over_driver_limit: (e) => `Open advances stay under the driver's limit of ${formatCents(e.limitCents)}`,
  possible_duplicate: () => "Not a repeat of a request from the last 24 hours",
  over_load_cap: () => "Within the cap on advances for this load",
};

// One advance: what was asked, what the pay rules say now, the request a person decided, and
// every payout and QuickBooks attempt on record. A missing id and another carrier's id read the
// same "not here", so an id's existence elsewhere is never revealed.
export default async function AdvanceRecordPage({ params }: { params: Promise<{ id: string }> }) {
  if (!advancesOn()) return <AdvancesOffPage title="Advance" />;
  const { id: raw } = await params;
  const id = isUuid(raw) ? raw.toLowerCase() : null;

  let page: { shell: Shell; record: AdvanceRecord | null; pullCards: InvoiceCard[] } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      record: id ? await readAdvanceRecord(q, id, new Date()) : null,
      // A take-back's pull-back card waiting or running, through the same gate as any card.
      pullCards:
        id && pullbackOn()
          ? (await readEngineProposalViews(q, "card_pullback", 5, id)).map((p) => ({
              card: proposalCardFrom(p, { on: flags.auditorEnabled, checking: false }),
              verdict: p.auditorVerdict,
              checkedAt: p.auditorCheckedAt,
              flagged: p.flagged,
            }))
          : [],
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;
  const { shell, record, pullCards } = page;
  if (!record) {
    return (
      <AdvanceFrame shell={shell} title="Advance">
        <PageHeader title="Advance" />
        <Card>
          <ErrorState category="not_found" retry={<Link href="/advances" className="text-link underline-offset-4 hover:underline">All advances</Link>} />
        </Card>
      </AdvanceFrame>
    );
  }
  const { advance, driver, card, proposal, ledger, input, eligibility, actions, load, headroom, siblingsOnLoad, takeback } =
    record;
  const when = (iso: string | null) => (iso ? formatInstant(iso, shell.timezone) : "Not yet");
  const cardLine = cardLineFor(advance.status, card);
  // Recorded by the office before this app: no request, no approval and no payout ran here.
  const beforeApp = advance.proposalId === null;
  // The driver's other advances on this load, by their amount ("Advance of $125.00"), since a
  // reference can be an office code a person does not know. Two of the same amount add the
  // reference so they never read the same.
  const byAmount = (o: (typeof siblingsOnLoad)[number]) => `Advance of ${formatCents(o.amountCents)}`;
  const siblingName = (o: (typeof siblingsOnLoad)[number]) =>
    siblingsOnLoad.filter((x) => x.amountCents === o.amountCents).length > 1 ? `${byAmount(o)}, ${o.requestRef}` : byAmount(o);
  // The records the check read, by the names this page already knows (the driver, the load, this
  // advance and the others on its load); any other is named by its kind, never an id tail.
  const known = new Map<string, string>([
    [`drivers:${driver.id}`, driver.name],
    [`advances:${advance.id}`, "This advance"],
    ...(load ? ([[`loads:${load.id}`, `Load ${load.number}`]] as [string, string][]) : []),
    ...siblingsOnLoad.map((o) => [`advances:${o.id}`, siblingName(o)] as [string, string]),
  ]);
  const keyOf = (s: SourceRef) => `${s.table}:${s.id}`;
  const unnamed = recordNamer((eligibility?.sources ?? []).filter((s) => !known.has(keyOf(s))));
  const sourceName = (s: SourceRef) => known.get(keyOf(s)) ?? unnamed(s);
  const title = `Advance for ${driver.name}, ${formatLocalDate(advance.requestedOn)}`;
  const decidedLabel = advance.status === "rejected" ? "Rejected" : "Approved";
  const decided = advance.decidedAt ? when(advance.decidedAt) : beforeApp ? "Recorded by the office before this app" : "Not yet";
  const paid = advance.paidAt ? when(advance.paidAt) : advance.status === "paid" && beforeApp ? "Before this app" : "Not yet";
  const rules = (Object.keys(RULE_LINES) as AdvanceRefusal[]).filter((code) => code !== "over_load_cap" || headroom !== null);
  return (
    <AdvanceFrame shell={shell} title={title} focus={{ table: "advances", id: advance.id, label: title }}>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {title}
            <StatusBadge status={advance.status} />
          </span>
        }
        description={
          <Link href={`/records/drivers/${driver.id}`} className="text-link underline-offset-4 hover:underline">
            {driver.name} ({driver.code})
          </Link>
        }
      />
      <RecordActionButtons advanceId={advance.id} actions={actions} />
      <TakeBack
        advanceId={advance.id}
        offered={actions.takeBack}
        paid={advance.status === "paid"}
        stillOwedCents={Math.max(0, advance.amountCents + advance.feeCents - advance.recoveredCents)}
        pulls={pullbackOn()}
      />
      {pullCards.length > 0 ? (
        <InvoiceCards cards={pullCards} auditorOn={flags.auditorEnabled} label="Card pull-back to approve" />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>The advance</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2" data-amounts="shown">
            <Item label="Reference">{advance.requestRef}</Item>
            <Item label="Requested">{when(advance.requestedAt)}</Item>
            <Item label="Amount"><Money cents={advance.amountCents} /></Item>
            <Item label="Fee"><Money cents={advance.feeCents} /></Item>
            <Item label={decidedLabel}>{decided}</Item>
            <Item label="Paid">{paid}</Item>
            {advance.status === "parked" && advance.parkReason && advance.parkedAt ? (
              <Item label="Parked">
                {PARK_REASON_WORDS[advance.parkReason]} (since {when(advance.parkedAt)}). Approve it again from its card, or reject it.
              </Item>
            ) : null}
            {cardLine ? (
              <Item label={cardLine.label}>
                {cardLine.card ? (
                  <FuelCardChip last4={cardLine.card.last4} status={cardLine.card.status} />
                ) : (
                  "No fuel card on file"
                )}
              </Item>
            ) : null}
            <Item label="Repaid from pay so far"><Money cents={advance.recoveredCents} /></Item>
            <Item label="Requested through">{sourceWords(advance.source)}{input ? `, ${codeToWords(input.kind).toLowerCase()} received ${when(input.receivedAt)}` : ""}</Item>
            {load ? <Item label="For load">{load.number}</Item> : null}
            {headroom ? (
              <Item label="Room left on this load">
                <Money cents={headroom.headroomCents} /> of the <Money cents={headroom.capCents} /> cap,{" "}
                <Money cents={headroom.openOnLoadCents} /> already advanced
              </Item>
            ) : null}
            {takeback ? (
              <Item label="Taken back">
                {takeback.cents > 0 ? (
                  <>
                    <Money cents={takeback.cents} /> on {when(takeback.at)}: {takebackReasonWords(takeback.reason).toLowerCase()}
                  </>
                ) : (
                  <>Canceled before payout on {when(takeback.at)}: {takebackReasonWords(takeback.reason).toLowerCase()}</>
                )}
              </Item>
            ) : null}
          </dl>
        </CardBody>
      </Card>

      {load && siblingsOnLoad.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>Other advances on this load</CardTitle>
              <CardDescription>Every other advance this driver has against load {load.number}, newest first.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <ul className="grid gap-2">
              {siblingsOnLoad.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2 text-body text-foreground">
                  <Link href={`/records/advances/${o.id}`} className="text-link underline-offset-4 hover:underline">
                    {siblingName(o)}
                  </Link>
                  <StatusBadge status={o.status} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {proposal ? (
        <Card>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>The request</CardTitle>
              <CardDescription>What the agent suggested and what a person decided.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="grid gap-3">
            <p className="flex flex-wrap items-center gap-2 text-body text-foreground">
              {proposal.title} <StatusBadge status={proposal.status} />
            </p>
            {proposal.status === "failed" && advance.status === "paid" ? (
              <p className="text-body text-foreground-2">
                The first payout attempt failed; a retry paid it, so the advance above is the record.
              </p>
            ) : null}
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2" data-amounts="shown">
              <Item label="Suggested">{when(proposal.createdAt)}</Item>
              <Item label="Decided">{when(proposal.decidedAt)}</Item>
              <Item label="Agent's check">
                {Object.hasOwn(AGENT_CHECK, proposal.operatorVerdict) ? AGENT_CHECK[proposal.operatorVerdict] : codeToWords(proposal.operatorVerdict)}
              </Item>
              <Item label="Outside message">{proposal.flagged ? "Flagged by screening, so approval needed a second confirm" : "None flagged"}</Item>
            </dl>
            {decisionNoteSentence(proposal.decisionNote) ? (
              <p className="text-body text-foreground-2">{decisionNoteSentence(proposal.decisionNote)}</p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>If this were requested today</CardTitle>
            <CardDescription>Your pay rules, run on today&apos;s records for the same amount. No model is involved.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {eligibility === null ? (
            <p className="text-body text-foreground-2">The pay rules could not be checked right now. Nothing is assumed; try again later.</p>
          ) : (
            <div className="grid gap-3">
              <p className="text-body font-semibold text-foreground">
                {eligibility.eligible ? "Yes, it would be allowed today." : "No, it would not be allowed today."}
              </p>
              <ul aria-label="Pay rules checked" className="grid gap-1.5">
                {rules.map((code) => {
                  const failed = eligibility.reasons.includes(code);
                  return (
                    <li key={code} className="text-body text-foreground">
                      {RULE_LINES[code](eligibility)}: <span className={failed ? "font-semibold text-destructive" : undefined}>{failed ? "no" : "yes"}</span>
                      {failed ? (
                        <span className="block text-small text-foreground-2">{refusalSentence(code, eligibility)}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3" data-amounts="shown">
                <Item label="Most that could be paid now"><Money cents={eligibility.maxCents} /></Item>
                <Item label="Earned, not paid yet"><Money cents={eligibility.earnedUnpaidCents} /></Item>
                <Item label="Advances still open"><Money cents={eligibility.openCents} /></Item>
                <Item label="Driver's limit"><Money cents={eligibility.limitCents} /></Item>
                <Item label="Fee"><Money cents={eligibility.feeCents} /></Item>
              </dl>
              {eligibility.sources.length > 0 ? (
                <p className="text-small text-muted-foreground">
                  Read from:{" "}
                  {eligibility.sources.map((s, i) => {
                    const href = hrefOrNull(recordHref, s);
                    return (
                      <span key={keyOf(s)}>
                        {i > 0 ? ", " : ""}
                        {href ? (
                          <Link href={href} className="text-link underline-offset-4 hover:underline">
                            {sourceName(s)}
                          </Link>
                        ) : (
                          sourceName(s)
                        )}
                      </span>
                    );
                  })}
                </p>
              ) : null}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>Payout and QuickBooks</CardTitle>
            <CardDescription>Every attempt, recorded before it was sent. Test mode only.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {ledger.length === 0 ? (
            <p className="text-body text-foreground-2">
              {beforeApp ? "The office recorded this before the app. Nothing was paid from here." : "Nothing has been sent yet."}
            </p>
          ) : (
            <ol className="grid gap-3">
              {ledger.map((e) => (
                <LedgerEntryRow key={e.id} entry={e} when={when} />
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </AdvanceFrame>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-small text-muted-foreground">{label}</dt>
      <dd className="text-body text-foreground">{children}</dd>
    </div>
  );
}
