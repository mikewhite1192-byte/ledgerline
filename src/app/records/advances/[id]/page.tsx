import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdvanceFrame, problemOf, ReadFailed, type ReadProblem } from "@/app/advances/frame";
import { readAdvanceRecord, readShell, type AdvanceRecord, type LedgerEntry, type Shell } from "@/lib/advances/read";
import { decisionNoteSentence, refusalSentence } from "@/lib/advances/reasons";
import { sourceWords } from "@/lib/advances/request";
import { advancesOn } from "@/lib/advances/switches";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
import { codeToWords, recordLabel } from "@/lib/format/labels";
import { isUuid } from "@/lib/uuid";
import { withRequestTenant } from "@/lib/tenant/context";
import { RecordActionButtons } from "./record-actions";

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
  const { advance, driver, proposal, ledger, input, eligibility, actions } = record;
  const when = (iso: string | null) => (iso ? formatInstant(iso, shell.timezone) : "Not yet");
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

      <Card>
        <CardHeader>
          <CardTitle>The advance</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label="Amount"><Money cents={advance.amountCents} /></Item>
            <Item label="Fee, charged back later"><Money cents={advance.feeCents} /></Item>
            <Item label="Recovered from pay"><Money cents={advance.recoveredCents} /></Item>
            <Item label="Source">{sourceWords(advance.source)}{input ? `, ${codeToWords(input.kind).toLowerCase()} received ${when(input.receivedAt)}` : ""}</Item>
            <Item label="Requested">{when(advance.requestedAt)}</Item>
            <Item label="Approved">{when(advance.decidedAt)}</Item>
            <Item label="Paid">{when(advance.paidAt)}</Item>
          </dl>
        </CardBody>
      </Card>

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
                <LedgerRow key={e.id} entry={e} when={when} />
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

const KIND_WORDS: Readonly<Record<string, string>> = {
  advance_payout: "Payout",
  advance_expense: "QuickBooks post",
};

function LedgerRow({ entry, when }: { entry: LedgerEntry; when: (iso: string | null) => string }) {
  return (
    <li className="grid gap-1 rounded-lg border border-border px-4 py-3">
      <p className="flex flex-wrap items-center gap-2 text-body text-foreground">
        {KIND_WORDS[entry.kind] ?? codeToWords(entry.kind)}, attempt {entry.attempt}
        <StatusBadge status={entry.state} />
        <Money cents={entry.amountCents} className="ml-auto" />
      </p>
      <p className="text-small text-muted-foreground">
        Reserved {when(entry.createdAt)}
        {entry.settledAt ? `, settled ${when(entry.settledAt)}` : ""}
        {entry.outsideTail ? `, outside id ending ${entry.outsideTail}` : ""}
        {entry.failureCategory ? `, ${codeToWords(entry.failureCategory).toLowerCase()}` : ""}
      </p>
    </li>
  );
}
