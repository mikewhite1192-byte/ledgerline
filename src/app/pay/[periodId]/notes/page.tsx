import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { weekEnding } from "@/components/agent/page-focus";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState, FeatureOff } from "@/components/app/states";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { readPeriodNotes, type NoteCard, type PeriodNotes } from "@/lib/driver-notes/view";
import { formatInstant, formatPeriod } from "@/lib/format/dates";
import { withRequestTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import {
  readShell,
  shellProblemOf,
  ShellProblemPage,
  SignOutForm,
  type ShellInfo,
  type ShellProblem,
} from "../../../shell";
import { NotesBoard, type BoardCard } from "./notes-board";

export const dynamic = "force-dynamic";

// One pay period's driver notes: draft them, read each one with the lines it cites, and approve
// or reject each note that passed the check. A note that failed the check never shows an approve
// button; the driver sees the fallback line instead.
export default async function PeriodNotesPage({ params }: { params: Promise<{ periodId: string }> }) {
  const { periodId } = await params;
  if (!isUuid(periodId)) notFound();

  let data: { shell: ShellInfo; notes: PeriodNotes | null } | null = null;
  let problem: ShellProblem | null = null;
  try {
    data = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      notes: flags.driverNotesEnabled ? await readPeriodNotes(q, periodId) : null,
    }));
  } catch (err) {
    problem = shellProblemOf(err);
  }
  if (!data) return <ShellProblemPage problem={problem ?? "unreadable"} />;
  const { shell, notes } = data;

  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone, role: shell.role }}
      nav={appNav("/driver-notes")}
      title="Driver notes"
      signOut={<SignOutForm />}
      // The pay week, once it was read under the carrier; a week not found declares none.
      focus={notes ? { table: "settlement_periods", id: notes.period.id, label: weekEnding(notes.period.periodEnd) } : undefined}
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6">
        <Link href="/driver-notes" className="w-fit text-small text-link underline-offset-4 hover:underline">
          All pay periods
        </Link>
        {!flags.driverNotesEnabled ? (
          <>
            <PageHeader title="Driver notes" />
            <Card>
              <FeatureOff name="Driver notes" plural />
            </Card>
          </>
        ) : !notes ? (
          <>
            <PageHeader title="Driver notes" />
            <Card>
              <ErrorState category="not_found" />
            </Card>
          </>
        ) : (
          <>
            <PageHeader
              title={formatPeriod(notes.period.periodStart, notes.period.periodEnd)}
              description="Each note is written in the driver's language and checked against the paystub. Only a note that passed the check can be approved."
              actions={
                flags.payCardsEnabled ? (
                  <Link
                    href={`/pay/${notes.period.id}/cards`}
                    className="text-small text-link underline-offset-4 hover:underline"
                  >
                    Pay cards
                  </Link>
                ) : undefined
              }
            />
            {notes.cards.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<NotebookPen aria-hidden />}
                  title="No approved paystubs in this period"
                  body="Notes can be drafted once paystubs are approved."
                />
              </Card>
            ) : (
              <NotesBoard
                periodId={notes.period.id}
                cards={notes.cards.map((c) => boardCard(c, shell.timezone))}
                draftOffReason={flags.aiEnabled ? undefined : "The models are switched off, so no notes can be drafted right now."}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

// The decision time is shown in the carrier's zone; a time that cannot be read shows as nothing.
function boardCard(card: NoteCard, timezone: string): BoardCard {
  let decidedText: string | null = null;
  if (card.note?.decidedAt) {
    try {
      decidedText = formatInstant(card.note.decidedAt, timezone);
    } catch {
      decidedText = null;
    }
  }
  return { ...card, decidedText };
}
