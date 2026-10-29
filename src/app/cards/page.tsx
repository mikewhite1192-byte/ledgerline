import Link from "next/link";
import type { ReactNode } from "react";
import { DataTable } from "@/components/app/data-table";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { StatCard } from "@/components/app/stat-card";
import { FeatureOff } from "@/components/app/states";
import { CheckCards } from "@/components/cards/check-cards";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import type { BreakView } from "@/lib/data/card-recon";
import { DbError } from "@/lib/db";
import {
  breakSentence,
  breakTitle,
  countOf,
  fixOf,
  readCardHome,
  resultLine,
  severityOf,
  uncheckedLines,
  whatLine,
  type CardHome,
} from "@/lib/recon/view";
import { money } from "@/lib/recon/words";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

const TITLE = "Card check";
const DESCRIPTION = "Compares your payment records with the card provider, the bank and QuickBooks.";

function openLink(b: BreakView, children: ReactNode) {
  return (
    <Link href={`/cards/${encodeURIComponent(b.id)}`} className="text-link underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

function emptyCopy(checked: boolean) {
  return checked
    ? { title: "Differences appear here", body: "The last check found none. Press Check cards to look again." }
    : {
        title: "Differences appear here",
        body: "Press Check cards to compare your payment records with the card provider, the bank and QuickBooks.",
      };
}

// On a phone each difference is a card, the amounts first.
function BreakList({ breaks }: { breaks: BreakView[] }) {
  if (breaks.length === 0) return null;
  return (
    <ul aria-label="Open differences" className="grid gap-3 sm:hidden">
      {breaks.map((b) => {
        const s = severityOf(b);
        return (
          <li key={b.id}>
            <Card className="grid gap-2 px-4 py-3">
              <p className="text-body tabular-nums text-foreground">
                Ours {money(b.ourCents)} / Theirs {money(b.outsideCents)}
              </p>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={s.tone}>{s.label}</Badge>
                <span className="text-small text-foreground-2">{breakTitle(b)}</span>
              </span>
              {openLink(b, whatLine(b))}
              <p className="text-small text-foreground-2">{breakSentence(b)}</p>
              <p className="text-small text-foreground-2">The fix: {fixOf(b)}</p>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

type Read = { shell: ShellTenant; home: CardHome | null };

async function readPage(withHome: boolean): Promise<Read | { problem: "forbidden" | "unreadable" }> {
  try {
    return await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      home: withHome ? await readCardHome(q) : null,
    }));
  } catch (err) {
    if (err instanceof ForbiddenError) return { problem: "forbidden" };
    if (err instanceof DbError) return { problem: "unreadable" };
    throw err;
  }
}

// The card check: the main button, the newest check's line and counters, and every open
// difference, most serious first. Each row opens the difference. Dark while its switch is off; the
// off page reads only the carrier chip.
export default async function CardsPage() {
  const on = flags.cardRecon.enabled;
  const read = await readPage(on);
  if ("problem" in read) return <NoCarrierPage problem={read.problem} />;
  const header = (
    <PageHeader
      title={TITLE}
      description={
        <span className="flex flex-wrap items-center gap-2">
          {DESCRIPTION}
          <Badge tone="neutral">Test mode</Badge>
        </span>
      }
    />
  );
  if (!on || !read.home) {
    return (
      <SignedInPage tenant={read.shell} current="/cards" title={TITLE}>
        {header}
        <FeatureOff name={TITLE} />
      </SignedInPage>
    );
  }
  const { run, breaks, open } = read.home;
  const running = run?.status === "running";
  const lines = uncheckedLines(run);

  return (
    <SignedInPage tenant={read.shell} current="/cards" title={TITLE}>
      {header}
      <Card className="grid gap-4 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
        <div className="grid gap-1">
          <p className="text-body text-foreground">{run ? resultLine(run) : "No check yet."}</p>
          {lines.map((line) => (
            <p key={line} className="text-small text-foreground-2">
              {line}
            </p>
          ))}
        </div>
        <CheckCards runningId={running && run ? run.id : null} />
      </Card>
      <section aria-label="Open differences" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Needs you" value={open.needsYou} />
        <StatCard label="Not confirmed yet" value={open.notConfirmed} />
        <StatCard label="Checked clean" value={run && run.status === "done" ? countOf(run, "recordsClean") : 0} />
      </section>
      <BreakList breaks={breaks} />
      {/* The table is the wide-screen view; with nothing open it shows its empty state everywhere. */}
      <div className={breaks.length > 0 ? "hidden sm:block" : undefined}>
        <DataTable
          caption="Open differences"
          rows={breaks}
          rowKey={(b) => b.id}
          empty={emptyCopy(run !== null)}
          columns={[
            {
              key: "what",
              header: "What",
              wrap: true,
              cell: (b) => (
                <span className="grid gap-0.5">
                  {openLink(b, whatLine(b))}
                  <span className="text-small text-foreground-2">{breakTitle(b)}</span>
                </span>
              ),
            },
            {
              key: "amounts",
              header: "Ours / Theirs",
              align: "right",
              cell: (b) => (
                <span className="tabular-nums whitespace-nowrap">
                  {money(b.ourCents)} / {money(b.outsideCents)}
                </span>
              ),
            },
            {
              key: "severity",
              header: "How serious",
              cell: (b) => {
                const s = severityOf(b);
                return <Badge tone={s.tone}>{s.label}</Badge>;
              },
            },
            { key: "fix", header: "The fix", cell: (b) => fixOf(b) },
            {
              key: "why",
              header: "Why",
              wrap: true,
              cell: (b) => <span className="text-small text-foreground-2">{breakSentence(b)}</span>,
            },
          ]}
        />
      </div>
    </SignedInPage>
  );
}
