import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { FuelCardChip } from "@/components/app/fuel-card";
import { LedgerEntryRow } from "@/components/app/ledger-entry";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdvanceFrame, problemOf, ReadFailed, type ReadProblem } from "@/app/advances/frame";
import { cardLineFor, readAdvanceRecord, readShell, type AdvanceRecord, type Shell } from "@/lib/advances/read";
import { decisionNoteSentence, refusalSentence } from "@/lib/advances/reasons";
import { sourceWords } from "@/lib/advances/request";
import { takebackReasonWords } from "@/lib/advances/takeback-words";
import { advancesOn } from "@/lib/advances/switches";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
import { codeToWords, recordLabel } from "@/lib/format/labels";
import { isUuid } from "@/lib/uuid";
import { withRequestTenant } from "@/lib/tenant/context";
import { RecordActionButtons } from "./record-actions";
import { TakeBack } from "./take-back";

export const dynamic = "force-dynamic";

// One advance: what was asked, what the pay rules say now, the proposal a person decided, and
// every payout and QuickBooks attempt from the ledger. A missing id and another carrier's id read
// the same "not here", so an id's existence elsewhere is never revealed.
export default async function AdvanceRecordPage({ params }: { params: Promise<{ id: string }> }) {
  if (!advancesOn()) notFound();
  const { id: raw } = await params;
  const id = isUuid(raw) ? raw.toLowerCase() : null;

  let page: { shell: Shell; record: AdvanceRecord | null } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      record: id ? await readAdvanceRecord(q, id, new Date()) : null,
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;
  const { shell, record } = page;
  if (!record) {
    return (
      <AdvanceFrame shell={shell} title="Advance">
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
  return (
    <AdvanceFrame shell={shell} title={`Advance ${advance.requestRef}`}>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Money cents={advance.amountCents} /> for {driver.name}
            <StatusBadge status={advance.status} />
          </span>
        }
        description={`${advance.requestRef} · driver ${driver.code} · requested ${formatLocalDate(advance.requestedOn)}`}
      />
      <RecordActionButtons advanceId={advance.id} actions={actions} />
      <TakeBack
        advanceId={advance.id}
        offered={actions.takeBack}
        paid={advance.status === "paid"}
        stillOwedCents={Math.max(0, advance.amountCents + advance.feeCents - advance.recoveredCents)}
      />

      <Card>
        <CardHeader>
          <CardTitle>The advance</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label="Driver">
              <Link href={`/records/drivers/${driver.id}`} className="text-link underline-offset-4 hover:underline">
                {driver.name}
              </Link>
            </Item>
            <Item label="Amount"><Money cents={advance.amountCents} /></Item>
            <Item label="Fee, charged back later"><Money cents={advance.feeCents} /></Item>
            <Item label="Recovered from pay"><Money cents={advance.recoveredCents} /></Item>
            <Item label="Source">{sourceWords(advance.source)}{input ? `, ${codeToWords(input.kind).toLowerCase()} received ${when(input.receivedAt)}` : ""}</Item>
            <Item label="Requested">{when(advance.requestedAt)}</Item>
            <Item label="Approved">{when(advance.decidedAt)}</Item>
            <Item label="Paid">{when(advance.paidAt)}</Item>
            {load ? <Item label="For load">{load.number}</Item> : null}
            {headroom ? (
              <Item label="Headroom on this load">
                <Money cents={headroom.headroomCents} /> of <Money cents={headroom.capCents} /> cap,{" "}
                <Money cents={headroom.openOnLoadCents} /> open
              </Item>
            ) : null}
            {takeback ? (
              <Item label="Taken back">
                {takeback.cents > 0 ? (
                  <>
                    <Money cents={takeback.cents} /> on {when(takeback.at)}: {takebackReasonWords(takeback.reason).toLowerCase()}
                  </>
                ) : (
                  <>Cancelled before payout on {when(takeback.at)}: {takebackReasonWords(takeback.reason).toLowerCase()}</>
                )}
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
                    {o.requestRef}
                  </Link>
                  <Money cents={o.amountCents} />
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
              <CardTitle>The proposal</CardTitle>
              <CardDescription>What the agent proposed and what a person decided.</CardDescription>
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
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Item label="Proposed">{when(proposal.createdAt)}</Item>
              <Item label="Decided">{when(proposal.decidedAt)}</Item>
              <Item label="Agent's check">{codeToWords(proposal.operatorVerdict)}</Item>
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
            <CardTitle>If asked again now</CardTitle>
            <CardDescription>The pay rules run on today&apos;s records for the same amount. No model is involved.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {eligibility === null ? (
            <p className="text-body text-foreground-2">Eligibility could not be checked right now. Nothing is assumed.</p>
          ) : (
            <div className="grid gap-3">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Item label="Most allowed now"><Money cents={eligibility.maxCents} /></Item>
                <Item label="Earned, unpaid"><Money cents={eligibility.earnedUnpaidCents} /></Item>
                <Item label="Open advances"><Money cents={eligibility.openCents} /></Item>
                <Item label="Driver's limit"><Money cents={eligibility.limitCents} /></Item>
                <Item label="Fee"><Money cents={eligibility.feeCents} /></Item>
                <Item label="Verdict">{eligibility.eligible ? "Eligible" : "Not eligible"}</Item>
              </dl>
              {eligibility.reasons.length > 0 ? (
                <ul className="grid list-disc gap-1 pl-5 text-body text-foreground-2">
                  {eligibility.reasons.map((r) => (
                    <li key={r}>{refusalSentence(r, eligibility)}</li>
                  ))}
                </ul>
              ) : null}
              {eligibility.sources.length > 0 ? (
                <p className="text-small text-muted-foreground">
                  From:{" "}
                  {eligibility.sources.map((s, i) => (
                    <span key={`${s.table}:${s.id}`}>
                      {i > 0 ? ", " : ""}
                      {s.table === "advances" ? (
                        <Link href={`/records/advances/${s.id}`} className="text-link underline-offset-4 hover:underline">
                          {recordLabel(s)}
                        </Link>
                      ) : (
                        recordLabel(s)
                      )}
                    </span>
                  ))}
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
            <CardDescription>Every attempt, reserved before it was sent. Test mode only.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {ledger.length === 0 ? (
            <p className="text-body text-foreground-2">
              {advance.proposalId ? "Nothing has been sent yet." : "Recorded before this app; no payout was sent from here."}
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
