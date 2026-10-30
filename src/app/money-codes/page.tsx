import Link from "next/link";
import { Ticket } from "lucide-react";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage } from "@/components/app/signed-in-page";
import { StatusBadge } from "@/components/app/status-badge";
import { InvoiceCards, type InvoiceCard } from "@/components/invoices/invoice-cards";
import { buttonVariants } from "@/components/ui/button";
import { flags } from "@/config/flags";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import { formatInstant } from "@/lib/format/dates";
import { listMoneyCodes, MONEY_CODE_LIST_MAX, type MoneyCodeRow } from "@/lib/money-codes/read";
import { moneyCodesOn } from "@/lib/money-codes/switches";
import {
  MONEY_CODE_PAGE_NOTICE,
  moneyCodePurposeWord,
  moneyCodeStatusWord,
  TEST_MODE_NOTE,
} from "@/lib/money-codes/words";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { CODES_HELP, CodesFrame, CodesOffPage, codesProblemOf, CodesTitle, type CodesProblem } from "./frame";

export const dynamic = "force-dynamic";

// The codes a status badge colors: issued reads as done, not confirmed as a warning.
const BADGE_OF: Readonly<Record<string, string>> = {
  issuing: "executing",
  issued: "confirmed",
  failed: "failed",
  unknown: "unknown",
  voided: "void",
};

const link = "text-link underline-offset-4 hover:underline";

// The Money codes page: the requests waiting for approval (each a card through the same gate as an
// agent's card), then every code on file, newest first. Dark while the switch is off, and reads
// nothing else then.
export default async function MoneyCodesPage() {
  if (!moneyCodesOn()) return <CodesOffPage title="Money codes" />;
  let page: { shell: ShellTenant; cards: InvoiceCard[]; codes: MoneyCodeRow[] } | null = null;
  let problem: CodesProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => {
      const shell = await readShell(q, session);
      const proposals = await readEngineProposalViews(q, "money_code");
      const audit = { on: flags.auditorEnabled, checking: false, timezone: shell.timezone };
      const cards: InvoiceCard[] = proposals.map((p) => ({
        card: proposalCardFrom(p, audit),
        verdict: p.auditorVerdict,
        checkedAt: p.auditorCheckedAt,
        flagged: p.flagged,
      }));
      return { shell, cards, codes: await listMoneyCodes(q, { limit: MONEY_CODE_LIST_MAX }) };
    });
  } catch (err) {
    problem = codesProblemOf(err);
  }
  if (!page) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const zone = page.shell.timezone;
  const when = (iso: string | null) =>
    iso ? <span className="whitespace-nowrap">{formatInstant(iso, zone)}</span> : <span className="text-muted-foreground">None</span>;

  return (
    <CodesFrame shell={page.shell} title="Money codes">
      <PageHeader
        title={<CodesTitle>Money codes</CodesTitle>}
        description={CODES_HELP}
        actions={
          <Link href="/money-codes/new" className={buttonVariants({ variant: "primary" })}>
            Request a code
          </Link>
        }
      />
      <p className="text-small text-foreground-2">{TEST_MODE_NOTE}</p>
      {page.cards.length > 0 ? (
        <section className="grid gap-3" aria-labelledby="codes-waiting">
          <h2 id="codes-waiting" className="text-h2 text-foreground">
            Waiting for approval
          </h2>
          <InvoiceCards
            cards={page.cards}
            auditorOn={flags.auditorEnabled}
            label="Money codes to approve"
            notices={MONEY_CODE_PAGE_NOTICE}
          />
        </section>
      ) : null}
      <DataTable<MoneyCodeRow>
        caption="Money codes, newest first"
        rows={page.codes}
        rowKey={(r) => r.id}
        empty={{
          icon: <Ticket aria-hidden />,
          title: "No codes yet",
          body: "Press Request a code, or ask the agent: \"A driver sent a lumper receipt, get them a money code.\"",
        }}
        columns={[
          {
            key: "driver",
            header: "Driver",
            cell: (r) => (
              <span className="whitespace-nowrap">
                <Link href={`/records/drivers/${r.driverId}`} className={link}>
                  {r.driverName}
                </Link>
                <span className="block text-small text-muted-foreground">{r.driverCode}</span>
              </span>
            ),
          },
          {
            key: "load",
            header: "Load",
            cell: (r) => (
              <Link href={`/records/loads/${r.loadId}`} className={`whitespace-nowrap ${link}`}>
                {r.loadNumber}
              </Link>
            ),
          },
          {
            key: "purpose",
            header: "Purpose",
            cell: (r) => (
              <Link href={`/money-codes/${r.id}`} className={`font-medium ${link}`}>
                {moneyCodePurposeWord(r.purpose)}
              </Link>
            ),
          },
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} /> },
          {
            key: "status",
            header: "Status",
            cell: (r) => <StatusBadge status={BADGE_OF[r.status] ?? "unknown"} label={moneyCodeStatusWord(r.status)} />,
          },
          { key: "issued", header: "Issued", cell: (r) => when(r.issuedAt) },
          { key: "expires", header: "Expires", cell: (r) => when(r.expiresAt) },
        ]}
      />
    </CodesFrame>
  );
}
