"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/app/status-badge";
import { useToast } from "@/components/app/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import type { NoteCard } from "@/lib/driver-notes/view";
import { LANGUAGE_WORDS, NOTE_STATUS_WORDS, refusalWords } from "@/lib/driver-notes/words";

export type BoardCard = NoteCard & { decidedText: string | null };

// A drafting pass runs in slices; the board asks again while the server says there is more, up to
// this many slices per click.
const MAX_SLICES = 20;

// Fixed words per refusal category from the routes; the raw reply never reaches the page.
const DRAFT_ERRORS: Record<string, string> = {
  notes_off: "Driver notes are switched off.",
  ai_off: "The models are switched off.",
  not_found: "This pay period is not here.",
  forbidden: "This login cannot draft notes for this carrier.",
  unauthenticated: "Your session ended. Sign in again.",
};

const DECIDE_ERRORS: Record<string, string> = {
  already_decided: "Someone already decided this note.",
  not_approvable: "Only a note that passed the check can be decided.",
  not_found: "This note is not here.",
  notes_off: "Driver notes are switched off.",
  forbidden: "This login cannot decide notes for this carrier.",
  unauthenticated: "Your session ended. Sign in again.",
};

async function postJson(url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function errorOf(json: Record<string, unknown>): string {
  return typeof json.error === "string" ? json.error : "unknown";
}

export function NotesBoard({
  periodId,
  cards,
  draftOffReason,
}: {
  periodId: string;
  cards: BoardCard[];
  draftOffReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [drafting, setDrafting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const toDraft = cards.filter((c) => !c.note || c.note.status === "over_cap").length;

  async function draft() {
    setDrafting(true);
    setProgress(null);
    try {
      for (let slice = 0; slice < MAX_SLICES; slice++) {
        const { status, json } = await postJson("/api/driver-notes", { periodId });
        if (status !== 200) {
          toast({
            title: "Notes were not drafted",
            body: DRAFT_ERRORS[errorOf(json)] ?? "Try again in a moment.",
            tone: "warning",
          });
          return;
        }
        const total = Number(json.total ?? 0);
        const done = Number(json.drafted ?? 0);
        setProgress(`${done} of ${total} drafted`);
        if (json.stoppedBy === "cap") {
          toast({ title: "Drafting stopped at the note spending cap", body: "The rest were not drafted.", tone: "warning" });
        } else if (json.stoppedBy === "model") {
          toast({ title: "The model call failed", body: "Notes not drafted yet can be drafted again later.", tone: "warning" });
        }
        if (json.more !== true) break;
      }
    } catch {
      toast({ title: "Notes were not drafted", body: "The request did not finish. Try again in a moment.", tone: "warning" });
    } finally {
      setDrafting(false);
      router.refresh();
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-body font-medium text-foreground">
              {toDraft === 0 ? "Every paystub has a note" : `${toDraft} ${toDraft === 1 ? "paystub needs" : "paystubs need"} a note`}
            </p>
            <p className="text-small text-foreground-2" aria-live="polite">
              {draftOffReason ?? progress ?? "Drafts go to this page first. Nothing reaches a driver until a person approves it."}
            </p>
          </div>
          <Button
            onClick={draft}
            disabled={toDraft === 0 || draftOffReason !== undefined}
            pending={drafting}
            pendingLabel="Drafting"
          >
            <Sparkles aria-hidden />
            Draft notes
          </Button>
        </CardBody>
      </Card>
      <ul className="grid gap-3" aria-label="Driver notes">
        {cards.map((c) => (
          <li key={c.settlementId}>
            <NoteCardView card={c} onDecided={() => router.refresh()} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoteCardView({ card, onDecided }: { card: BoardCard; onDecided: () => void }) {
  const toast = useToast();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const note = card.note;

  async function decide(action: "approve" | "reject") {
    if (!note) return;
    setPending(action);
    try {
      const { status, json } = await postJson(`/api/driver-notes/${note.id}/${action}`);
      if (status !== 200) {
        toast({
          title: action === "approve" ? "Not approved" : "Not rejected",
          body: DECIDE_ERRORS[errorOf(json)] ?? "Try again in a moment.",
          tone: "warning",
        });
        return;
      }
      toast({
        title: action === "approve" ? "Approved" : "Rejected",
        body:
          action === "approve"
            ? json.email === "sent"
              ? "The driver sees it with their paystub, and it was emailed."
              : "The driver sees it with their paystub."
            : "The driver sees the short pay line instead.",
        tone: "success",
      });
      onDecided();
    } catch {
      toast({ title: "The request did not finish", body: "Reload the page to see where the note stands.", tone: "warning" });
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardBody className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-h3 text-foreground">{card.driverName}</p>
            <p className="text-small text-foreground-2">{card.driverCode}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{LANGUAGE_WORDS[card.language]}</Badge>
            {note ? (
              <StatusBadge status={note.status} label={NOTE_STATUS_WORDS[note.status]} />
            ) : (
              <StatusBadge status="none" label="No note yet" />
            )}
          </div>
        </div>

        {note && note.body && (note.status === "drafted" || note.status === "approved" || note.status === "rejected") ? (
          <blockquote lang={note.language} className="border-l-2 border-border pl-3 text-body whitespace-pre-line text-foreground">
            {note.body}
          </blockquote>
        ) : null}

        {note?.status === "refused" ? (
          <>
            <InlineAlert tone="warning" title="This draft failed the check">
              {refusalWords(note.refusalCategory)}
            </InlineAlert>
            <p lang={card.language} className="text-body text-foreground-2">
              The driver sees: {card.fallback}
            </p>
          </>
        ) : null}

        {note?.status === "over_cap" ? (
          <p className="text-body text-foreground-2">
            Not drafted yet: the note spending cap for this period was reached, or the model could not be
            called. Draft notes again to retry.
          </p>
        ) : null}

        {note?.status === "drafting" ? (
          <p className="text-body text-foreground-2">Drafting now. Reload in a moment.</p>
        ) : null}

        {card.citedLines.length > 0 ? (
          <div className="grid gap-1">
            <p className="text-small font-medium text-foreground-2">Lines this note cites</p>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-small">
              {card.citedLines.map((l) => (
                <li key={l.seq}>
                  <Link
                    href={`/driver-notes/${card.settlementId}/view#line-${l.seq}`}
                    className="text-link underline-offset-4 hover:underline"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={`/driver-notes/${card.settlementId}/view`}
            className="text-small text-link underline-offset-4 hover:underline"
          >
            What the driver sees
          </Link>
          {note?.status === "drafted" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => decide("reject")}
                disabled={pending !== null}
                pending={pending === "reject"}
                pendingLabel="Rejecting"
              >
                Reject
              </Button>
              <Button
                size="sm"
                onClick={() => decide("approve")}
                disabled={pending !== null}
                pending={pending === "approve"}
                pendingLabel="Approving"
              >
                Approve
              </Button>
            </div>
          ) : card.decidedText && (note?.status === "approved" || note?.status === "rejected") ? (
            <p className="text-small text-foreground-2">
              {note.status === "approved" ? "Approved" : "Rejected"} {card.decidedText}
            </p>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
