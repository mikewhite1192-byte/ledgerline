"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { StatusBadge } from "@/components/app/status-badge";
import { useToast } from "@/components/app/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  DECIDE_ERROR_WORDS,
  DRAFT_ERROR_WORDS,
  draftedWords,
  EMAIL_UNCONFIRMED_WORDS,
  REMINDER_STATUS_WORDS,
  refusalWords,
  stillWaitingWords,
  TONE_HELP,
  TONE_WORDS,
  UNCONFIRMED_DECISION_WORDS,
} from "@/lib/collections/words";
import type { CollectionTone } from "@/lib/rules-engine/collections";

// One late invoice with no reminder yet, as the page shows it.
export type BoardLate = {
  key: string;
  customerName: string;
  invoiceNumber: string;
  daysLate: number;
  balanceText: string;
  invoiceHref: string | null;
};

// One reminder, with its words and links worked out on the server.
export type BoardCard = {
  id: string;
  status: "drafting" | "drafted" | "refused" | "over_cap" | "approved" | "rejected";
  tone: CollectionTone;
  customerName: string;
  customerHref: string | null;
  invoiceNumber: string;
  invoiceHref: string | null;
  daysLate: number;
  balanceText: string;
  dueText: string;
  subject: string | null;
  body: string | null;
  refusalCategory: string | null;
  afterText: string | null;
};

// How many late invoices the list under the button names before "and N more".
const LIST_MAX = 5;

async function postJson(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" } });
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

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

function MaybeLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <Link href={href} className="text-link underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

export function CollectionsBoard({
  toDraft,
  cards,
  draftOffReason,
}: {
  toDraft: BoardLate[];
  cards: BoardCard[];
  draftOffReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [drafting, setDrafting] = useState(false);
  const shown = toDraft.slice(0, LIST_MAX);

  async function draft() {
    setDrafting(true);
    try {
      const { status, json } = await postJson("/api/collections/draft");
      if (status !== 200) {
        toast({
          title: "Reminders were not drafted",
          body: DRAFT_ERROR_WORDS[errorOf(json)] ?? "Try again in a moment.",
          tone: "warning",
        });
        return;
      }
      const waiting = count(json.remaining) + count(json.overCap);
      const stoppedBy = typeof json.stoppedBy === "string" ? json.stoppedBy : null;
      toast({
        title: draftedWords(count(json.drafted), count(json.refused)),
        body: stillWaitingWords(waiting, stoppedBy) ?? "Each one waits below for you to approve or reject.",
        tone: stoppedBy === "cap" || stoppedBy === "model" ? "warning" : "success",
      });
    } catch {
      toast({ title: "Reminders were not drafted", body: "The request did not finish. Try again in a moment.", tone: "warning" });
    } finally {
      setDrafting(false);
      router.refresh();
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardBody className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid min-w-0 gap-0.5">
              <p className="text-body font-medium text-foreground">
                {toDraft.length === 0
                  ? "Every late invoice has a reminder"
                  : `${toDraft.length} late ${toDraft.length === 1 ? "invoice needs" : "invoices need"} a reminder`}
              </p>
              <p className="text-small text-foreground-2">
                {draftOffReason ?? "Drafts wait on this page. Nothing goes to a customer until you approve it."}
              </p>
            </div>
            <Button
              onClick={draft}
              disabled={toDraft.length === 0 || draftOffReason !== undefined}
              pending={drafting}
              pendingLabel="Drafting"
            >
              <Sparkles aria-hidden />
              Draft reminders
            </Button>
          </div>
          {shown.length > 0 ? (
            <ul className="grid gap-1 text-small text-foreground-2" aria-label="Late invoices with no reminder yet">
              {shown.map((l) => (
                <li key={l.key}>
                  {l.customerName} · <MaybeLink href={l.invoiceHref}>Invoice {l.invoiceNumber}</MaybeLink> ·{" "}
                  {l.daysLate} days late · {l.balanceText} due
                </li>
              ))}
              {toDraft.length > shown.length ? <li>and {toDraft.length - shown.length} more</li> : null}
            </ul>
          ) : null}
        </CardBody>
      </Card>
      {cards.length > 0 ? (
        <ul className="grid gap-3" aria-label="Payment reminders">
          {cards.map((c) => (
            <li key={c.id}>
              <ReminderCardView card={c} onDecided={() => router.refresh()} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ReminderCardView({ card, onDecided }: { card: BoardCard; onDecided: () => void }) {
  const toast = useToast();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);

  async function decide(action: "approve" | "reject") {
    setPending(action);
    try {
      const { status, json } = await postJson(`/api/collections/${card.id}/${action}`);
      if (status !== 200) {
        // A server failure may follow a saved decision, so it claims neither outcome. Every refusal
        // reads the page again, so the card shows where the reminder stands now.
        toast(
          status >= 500
            ? { ...UNCONFIRMED_DECISION_WORDS, tone: "warning" }
            : {
                title: action === "approve" ? "Not approved" : "Not rejected",
                body: DECIDE_ERROR_WORDS[errorOf(json)] ?? "Try again in a moment.",
                tone: "warning",
              },
        );
        onDecided();
        return;
      }
      const emailUnknown = action === "approve" && json.email === "unknown";
      toast({
        title: action === "approve" ? "Reminder approved" : "Reminder rejected",
        body:
          action === "approve"
            ? json.email === "sent"
              ? "It was emailed to the customer."
              : emailUnknown
                ? EMAIL_UNCONFIRMED_WORDS
                : "It is recorded here. Nothing was sent (Test mode)."
            : "It will not be sent.",
        tone: emailUnknown ? "warning" : "success",
      });
      onDecided();
    } catch {
      toast({ title: "The request did not finish", body: "Reload the page to see where the reminder stands.", tone: "warning" });
    } finally {
      setPending(null);
    }
  }

  const statusLabel = card.status === "approved" && card.afterText ? card.afterText : REMINDER_STATUS_WORDS[card.status];

  return (
    <Card>
      <CardBody className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 text-body text-foreground">
            <span className="font-medium">
              <MaybeLink href={card.customerHref}>{card.customerName}</MaybeLink>
            </span>{" "}
            · <MaybeLink href={card.invoiceHref}>Invoice {card.invoiceNumber}</MaybeLink> · {card.daysLate} days late ·{" "}
            {card.balanceText} due
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge title={TONE_HELP}>{TONE_WORDS[card.tone]} tone</Badge>
            <StatusBadge status={card.status} label={statusLabel} />
          </div>
        </div>
        <p className="text-small text-foreground-2">Was due {card.dueText}.</p>

        {card.subject && card.body ? (
          <div className="grid gap-2">
            <p className="text-body font-medium text-foreground">Subject: {card.subject}</p>
            <div className="rounded-md bg-secondary p-3 text-body whitespace-pre-line text-foreground">{card.body}</div>
          </div>
        ) : null}

        {card.status === "refused" ? (
          <InlineAlert tone="warning" title="This reminder did not pass its check">
            {refusalWords(card.refusalCategory)}
          </InlineAlert>
        ) : null}

        {card.status === "drafting" ? <p className="text-body text-foreground-2">Drafting now. Reload in a moment.</p> : null}

        {card.status === "drafted" ? (
          <div className="flex flex-wrap justify-end gap-2">
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
              Approve reminder
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
