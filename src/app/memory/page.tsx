import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { FeatureOff } from "@/components/app/states";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { listNotes, listNoteSubjects, type NoteRow, type NoteSubject } from "@/lib/memory/notes";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, shellProblemOf, ShellProblemPage, SignOutForm, type ShellInfo, type ShellProblem } from "../shell";
import { NotesBoard } from "./notes-board";

export const dynamic = "force-dynamic";

// The carrier's notes: what the office keeps about its customers, drivers and preferences, which
// the agent reads as context (never for amounts). Every read runs inside withRequestTenant, so only
// the signed-in carrier's notes appear; with carrierMemoryEnabled off nothing is read.
export default async function MemoryPage() {
  let data: { shell: ShellInfo; notes: NoteRow[]; subjects: NoteSubject[] } | null = null;
  let problem: ShellProblem | null = null;
  try {
    data = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      notes: flags.carrierMemoryEnabled ? await listNotes(q) : [],
      subjects: flags.carrierMemoryEnabled ? await listNoteSubjects(q) : [],
    }));
  } catch (err) {
    problem = shellProblemOf(err);
  }
  if (!data) return <ShellProblemPage problem={problem ?? "unreadable"} />;
  const { shell, notes, subjects } = data;
  const limits = flags.carrierMemoryLimits;

  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone }}
      nav={appNav("/memory")}
      title="Memory"
      signOut={<SignOutForm />}
    >
      <div className="mx-auto grid w-full max-w-[960px] gap-6">
        <PageHeader
          title="Memory"
          description="Short notes the agent keeps about your customers, drivers and preferences. The office writes and keeps them; the agent reads them for context and never for amounts."
        />
        {!flags.carrierMemoryEnabled ? (
          <Card>
            <FeatureOff name="Memory" />
          </Card>
        ) : (
          <NotesBoard
            notes={notes}
            subjects={subjects}
            timeZone={shell.timezone}
            maxChars={limits.maxNoteChars}
            maxNotes={limits.maxNotesPerCarrier}
          />
        )}
      </div>
    </AppShell>
  );
}
