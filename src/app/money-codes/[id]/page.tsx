import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { LedgerEntryRow } from "@/components/app/ledger-entry";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Term } from "@/components/app/term";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { outsideTail } from "@/lib/advances/read";
import { formatInstant } from "@/lib/format/dates";
import { readMoneyCode, type MoneyCodeDetail } from "@/lib/money-codes/read";
import { moneyCodesOn } from "@/lib/money-codes/switches";
import { expiresInWords, moneyCodePurposeWord, moneyCodeStatusWord } from "@/lib/money-codes/words";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { isUuid } from "@/lib/uuid";
import { CodesFrame, CodesOffPage, codesProblemOf, CodesTitle, type CodesProblem } from "../frame";
import { CheckPending, CodeReveal } from "./code-actions";

export const dynamic = "force-dynamic";

const link = "text-link underline-offset-4 hover:underline";

const BADGE_OF: Readonly<Record<string, string>> = {
  issuing: "executing",
  issued: "confirmed",
  failed: "failed",
  unknown: "unknown",
  voided: "void",
};

// What the code's card says while there are no digits to show.
const STATUS_NOTE: Readonly<Record<string, string>> = {
  issuing: "The card provider has not answered yet. Use Check pending in a minute.",
  unknown: "The card provider's answer did not come back, so this code is not confirmed yet. Nothing is on the paystub until Check pending confirms it.",
  failed: "No code was issued and nothing was charged to the driver. Send a new request to try again.",
  voided: "This code was called off. Nothing is charged for it.",
};

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-small text-foreground-2">{label}</dt>
      <dd className="min-w-0 text-body break-words text-foreground">{children}</dd>
    </div>
  );
}

// One money code: the code itself after Show code (issued and not expired), how long it has left,
// the receipt behind it, the load, the two paystub lines that net to zero, the invoice line for a
// lumper, and every payment record. Check pending shows while the issue is not confirmed.
export default async function MoneyCodePage({ params }: { params: Promise<{ id: string }> }) {
  if (!moneyCodesOn()) return <CodesOffPage title="Money code" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let page: { shell: ShellTenant; detail: MoneyCodeDetail | null } | null = null;
  let problem: CodesProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      detail: await readMoneyCode(q, id),
    }));
  } catch (err) {
    problem = codesProblemOf(err);
  }
  if (!page) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const zone = page.shell.timezone;
  const detail = page.detail;
  if (!detail) {
    return (
      <CodesFrame shell={page.shell} title="Money code">
        <PageHeader title="Money code" />
        <Card>
          <ErrorState
            category="not_found"
            retry={
              <Link href="/money-codes" className={link}>
                All money codes
              </Link>
            }
          />
        </Card>
      </CodesFrame>
    );
  }

  const { code, charge, reimbursement, accessorial, receipt, settlementId } = detail;
  const now = new Date();
  const purpose = moneyCodePurposeWord(code.purpose);
  const live = code.status === "issued" && code.expiresAt !== null && Date.parse(code.expiresAt) > now.getTime();
  const pending = code.status === "unknown" || code.status === "issuing";
  const when = (iso: string | null) => (iso ? formatInstant(iso, zone) : "None");
  const ledger = detail.actions.map((a) => ({
    id: a.id,
    kind: a.kind,
    state: a.state,
    attempt: a.attempt,
    amountCents: a.amountCents,
    failureCategory: a.failureCategory,
    outsideSystem: a.outsideSystem,
    outsideTail: outsideTail(a.outsideId),
    createdAt: a.createdAt,
    settledAt: a.settledAt,
  }));

  return (
    <CodesFrame shell={page.shell} title="Money code">
      <PageHeader
        title={<CodesTitle>{`${purpose} code for ${code.loadNumber}`}</CodesTitle>}
        description={`For ${code.driverName}. Asked for ${when(code.createdAt)}.`}
        actions={<StatusBadge status={BADGE_OF[code.status] ?? "unknown"} label={moneyCodeStatusWord(code.status)} />}
      />
      <p>
        <Link href="/money-codes" className={`text-small ${link}`}>
          All money codes
        </Link>
      </p>

      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>The code</CardTitle>
            <CardDescription>
              One use, for <Money cents={code.amountCents} />. The driver gives it to the {code.purpose === "repair" ? "repair shop" : code.purpose === "lumper" ? "lumper" : "payee"}.
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody className="grid gap-4">
          {live ? (
            <>
              <CodeReveal codeId={code.id} />
              <p className="text-body text-foreground-2">
                Expires in {expiresInWords(code.expiresAt as string, now)}, at {when(code.expiresAt)}.
              </p>
            </>
          ) : code.status === "issued" ? (
            <p className="text-body text-foreground-2">This code expired at {when(code.expiresAt)}. Request a new one if the driver still needs it.</p>
          ) : (
            <p className="text-body text-foreground-2">{STATUS_NOTE[code.status] ?? STATUS_NOTE.unknown}</p>
          )}
          {pending ? <CheckPending codeId={code.id} /> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where it shows</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-3">
            <Row label="Driver">
              <Link href={`/records/drivers/${code.driverId}`} className={link}>
                {code.driverName}
              </Link>{" "}
              <span className="text-foreground-2">({code.driverCode})</span>
            </Row>
            <Row label="Load">
              <Link href={`/records/loads/${code.loadId}`} className={link}>
                {code.loadNumber}
              </Link>
            </Row>
            <Row label="Receipt">
              {receipt ? (
                <Link href={`/documents/${receipt.id}`} className={link}>
                  {receipt.filename}
                </Link>
              ) : (
                <span className="text-foreground-2">None cited</span>
              )}
            </Row>
            <Row label={<Term id="paystub">On the paystub</Term>}>
              {charge && reimbursement ? (
                <>
                  Charge <Money cents={charge.amountCents} sign="never" />, reimbursement <Money cents={reimbursement.amountCents} />, so the
                  driver&apos;s pay does not change.{" "}
                  {settlementId ? (
                    <Link href={`/records/settlements/${settlementId}`} className={link}>
                      Open the paystub
                    </Link>
                  ) : (
                    <span className="text-foreground-2">The paystub for that week is not made yet.</span>
                  )}
                </>
              ) : (
                <span className="text-foreground-2">Nothing yet. The two lines are added once the code is issued.</span>
              )}
            </Row>
            {code.purpose === "lumper" ? (
              <Row label="On the invoice">
                {accessorial ? (
                  <>
                    <Term id="lumper">Lumper</Term> <Money cents={accessorial.amountCents} />, billed with the load.
                  </>
                ) : (
                  <span className="text-foreground-2">Nothing yet. The lumper line is added once the code is issued.</span>
                )}
              </Row>
            ) : null}
          </dl>
        </CardBody>
      </Card>

      {receipt?.isImage ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>The receipt</CardTitle>
            <CardDescription>{receipt.filename}</CardDescription>
          </CardHeader>
          <CardBody>
            {/* The file route answers with no-store for one carrier's login; the image optimizer
                would cache private bytes, so the plain element is used on purpose. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/documents/${receipt.id}/file`}
              alt={`${receipt.filename}, the receipt photo`}
              className="h-auto w-full max-w-[320px] rounded-md border border-border"
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>Payment records</CardTitle>
            <CardDescription>
              Every request to the <Term id="card-provider">card provider</Term>, recorded before it was sent. Test mode only.
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {ledger.length === 0 ? (
            <p className="text-body text-foreground-2">Nothing has been sent yet.</p>
          ) : (
            <ol className="grid gap-3">
              {ledger.map((e) => (
                <LedgerEntryRow key={e.id} entry={e} when={when} />
              ))}
            </ol>
          )}
          {code.status === "unknown" ? (
            <InlineAlert tone="warning" className="mt-3">
              Not confirmed yet: unknown is not the same as failed. Check pending reads the answer back before anything is charged.
            </InlineAlert>
          ) : null}
        </CardBody>
      </Card>
    </CodesFrame>
  );
}
