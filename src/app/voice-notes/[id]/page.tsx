import Link from "next/link";
import { notFound } from "next/navigation";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { flags } from "@/config/flags";
import { readShell, type Shell } from "@/lib/advances/read";
import { formatInstant } from "@/lib/format/dates";
import { codeToWords } from "@/lib/format/labels";
import { withRequestTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import { voiceOn } from "@/lib/voice/http";
import { readVoiceDetail, type VoiceDetail } from "@/lib/voice/read";
import {
  categoryLabel,
  costWords,
  durationWords,
  languageLabel,
  purposeLabel,
  stoppedWords,
  targetLabel,
} from "@/lib/voice/words";
import { problemOf, ReadFailed, type ReadProblem } from "../../advances/frame";
import { VoiceFrame, VoiceOffPage, VoiceStatusBadge } from "../frame";
import { CopyReply, NoteActions } from "./note-actions";

export const dynamic = "force-dynamic";

// One voice note: the recording, where it is in the pipeline, the words once the safety screen
// passed them, the agent's proposal, the reply draft and which model did each step. A held note
// shows why, never its words.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-small text-foreground-2">{label}</dt>
      <dd className="min-w-0 text-body break-words text-foreground">{children}</dd>
    </div>
  );
}

function stepsFor(note: VoiceDetail): ("prepare" | "hand-off" | "reply")[] {
  if (note.status === "transcribed") return flags.aiEnabled ? ["prepare"] : [];
  if (note.status === "ready") return flags.agentEnabled && flags.aiEnabled ? ["hand-off"] : [];
  if (note.status === "handed_off") return ["reply"];
  if (note.status === "replied") return ["reply"];
  return [];
}

export default async function VoiceNotePage({ params }: { params: Promise<{ id: string }> }) {
  if (!voiceOn()) return <VoiceOffPage title="Voice note" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let page: { shell: Shell; note: VoiceDetail | null } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      note: await readVoiceDetail(q, id),
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;
  const note = page.note;
  const zone = page.shell.timezone;
  if (!note) {
    return (
      <VoiceFrame shell={page.shell} title="Voice note">
        <PageHeader title="Voice note" />
        <Card>
          <ErrorState category="not_found" retry={<Link href="/voice-notes" className="text-link underline-offset-4 hover:underline">All voice notes</Link>} />
        </Card>
      </VoiceFrame>
    );
  }

  const stopped = note.status === "blocked" || note.status === "failed";
  const flagged = note.screen?.verdict === "flagged" && !stopped;
  const totalNanocents = note.trace.reduce((sum, c) => sum + c.costNanocents, 0);
  return (
    <VoiceFrame shell={page.shell} title="Voice note">
      <PageHeader
        title={note.driverCode ? `Voice note from ${note.driverCode}` : "Voice note"}
        description={`Received ${formatInstant(note.createdAt, zone)}. Nothing is sent to the driver from here.`}
        actions={<VoiceStatusBadge status={note.status} />}
      />
      <p>
        <Link href="/voice-notes" className="text-small text-link underline-offset-4 hover:underline">
          All voice notes
        </Link>
      </p>

      {stopped ? (
        <InlineAlert tone={note.status === "blocked" ? "warning" : "destructive"} title={note.status === "blocked" ? "Held by the safety screen" : "Stopped"}>
          {stoppedWords(note.status, note.failCategory)}
        </InlineAlert>
      ) : null}
      {flagged ? (
        <InlineAlert tone="warning" title="Flagged by the safety screen">
          The agent can read this note, and any card it makes from it needs a second confirm.
          {note.screen && note.screen.categories.length > 0 ? ` Flagged for: ${note.screen.categories.map(codeToWords).join(", ").toLowerCase()}.` : ""}
        </InlineAlert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>The note</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4">
          {note.hasAudio ? (
            // A driver's recording has no caption track; the transcript below is its text.
            <audio controls preload="none" src={`/api/voice-notes/${note.id}/audio`} className="w-full max-w-[480px]">
              Your browser cannot play this clip.
            </audio>
          ) : (
            <p className="text-small text-foreground-2">No recording kept for this note.</p>
          )}
          <dl className="grid gap-3">
            <Row label="Driver">{note.driverName ? `${note.driverName} (${note.driverCode})` : "Not matched"}</Row>
            <Row label="Length">{durationWords(note.durationMs) || "Not known"}</Row>
            <Row label="Language">
              {languageLabel(note.language)}
              {note.confidenceMilli !== null ? <span className="text-foreground-2"> ({Math.round(note.confidenceMilli / 10)}% sure)</span> : null}
            </Row>
            <Row label="Sorted as">
              {categoryLabel(note.category)}
              {/* Only an urgent note is marked; the triage's other levels add nothing a person acts on. */}
              {note.urgency === "high" ? (
                <Badge tone="warning" className="ml-2">
                  Urgent
                </Badge>
              ) : null}
            </Row>
            <Row label="Amount heard">{note.amountCents === null ? "None stated" : <Money cents={note.amountCents} />}</Row>
            {note.transcript !== null ? <Row label="Transcript">{note.transcript}</Row> : null}
            {note.englishText !== null && note.language !== "en" ? <Row label="In English">{note.englishText}</Row> : null}
          </dl>
          <NoteActions id={note.id} steps={stepsFor(note)} />
        </CardBody>
      </Card>

      {note.status === "handed_off" || note.status === "replied" ? (
        <Card>
          <CardHeader>
            <CardTitle>The agent</CardTitle>
            <CardDescription>The agent reads the note through its safety checks and drafts a request. A person approves every payout on the card.</CardDescription>
          </CardHeader>
          <CardBody className="grid gap-3">
            {note.proposal ? (
              <dl className="grid gap-3">
                <Row label="Request">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Money cents={note.proposal.amountCents} /> <StatusBadge status={note.proposal.status} />
                  </span>
                </Row>
              </dl>
            ) : (
              <p className="text-body text-foreground-2">No request from this note yet. The agent may have asked a question instead.</p>
            )}
            <p>
              <Link href="/" className="text-small text-link underline-offset-4 hover:underline">
                Open the chat on Home
              </Link>
            </p>
          </CardBody>
        </Card>
      ) : null}

      {note.replyText !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>Reply draft</CardTitle>
            <CardDescription>Copy it into your own message to the driver. Nothing is sent from LedgerLine.</CardDescription>
          </CardHeader>
          <CardBody className="grid gap-3">
            <p className="text-body whitespace-pre-wrap text-foreground">{note.replyText}</p>
            <CopyReply text={note.replyText} />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Who did what</CardTitle>
          <CardDescription>Every model call for this note. The amounts come from your pay rules, never a model.</CardDescription>
        </CardHeader>
        <CardBody>
          {note.trace.length === 0 ? (
            <p className="text-body text-foreground-2">No model calls recorded for this note yet.</p>
          ) : (
            <ol className="grid gap-2">
              {note.trace.map((c, i) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border pb-2 last:border-b-0">
                  <span className="min-w-0">
                    <span className="font-medium">{targetLabel(c.target)}</span>
                    <span className="text-foreground-2">: {purposeLabel(c.purpose)}</span>
                    {c.status !== "ok" ? <span className="text-warning"> ({codeToWords(c.status).toLowerCase()})</span> : null}
                  </span>
                  <span className="text-small whitespace-nowrap text-foreground-2 tabular-nums">
                    {c.durationMs !== null ? `${(c.durationMs / 1000).toFixed(1)} s, ` : ""}
                    {costWords(c.costNanocents)}
                  </span>
                </li>
              ))}
              <li className="flex justify-between gap-4 pt-1 text-small text-foreground-2">
                <span>Total</span>
                <span className="tabular-nums">{costWords(totalNanocents)}</span>
              </li>
            </ol>
          )}
        </CardBody>
      </Card>
    </VoiceFrame>
  );
}
