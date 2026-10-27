"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProposalCard, type ProposalCardProps } from "@/components/app/proposal-card";
import { outcomeLabel } from "@/lib/invoices/labels";
import { postJson } from "./post-json";

// The card as the page drew it, plus what the approve call needs from the stored proposal: the
// auditor's verdict and its instant (the gate's second confirm and a block override) and the flag.
export type InvoiceCard = {
  card: Omit<ProposalCardProps, "hrefFor" | "onApprove" | "onReject" | "pending">;
  verdict: string | null;
  checkedAt: string | null;
  flagged: boolean;
};

// The auditor's lease: a check still running is asked again once, after it would have lapsed.
const AUDIT_RETRY_MS = 90_000;

// Why an approval did not go through, before the executor's own outcomes. Fixed sentences only. A
// lost or unreadable reply ("unknown", "unavailable") takes the shared not-known sentence.
const APPROVE_NOTICE: Readonly<Record<string, string>> = {
  not_executable: "This type of card cannot be approved yet. Nothing changed.",
  already_decided: "This card was already decided.",
  expired: "This card expired. Refresh the queue for a fresh one.",
  role: "An admin must approve an amount this size.",
  auditor_required: "This waits for the second check before anyone can approve it.",
  not_auditable: "This card was made before the second check started. Refresh the queue for a fresh one.",
  override_required: "The second check did not pass this. Write why you approve it anyway, then confirm.",
  stale: "The second check's result changed. Reload the card.",
  bad_request: "The reason must be 10 to 240 characters. Nothing changed.",
  needs_confirm: "Confirm the warning on the card first.",
  not_found: "That card is not here.",
};

// A page's own sentences (a money code's categories) are read before the shared ones.
const NO_NOTICES: Readonly<Record<string, string>> = {};

const notice = (category: string | null, own: Readonly<Record<string, string>>) => {
  if (category && Object.hasOwn(own, category)) return own[category];
  return category && Object.hasOwn(APPROVE_NOTICE, category) ? APPROVE_NOTICE[category] : outcomeLabel(category);
};

// The engine's invoice cards, through the same gate as an agent's card. With the auditor on, each
// waiting card nobody has checked is sent to it once per mount. Approve runs the approve route (the
// gate, then the invoice_post executor) and sends the second confirm whenever the card asked its
// question: a flag, or any verdict but a pass. An override over a block carries the verdict instant
// the card showed. Reject records the decision. Either way the page reads itself back. Another
// page's engine cards (the Money codes page) pass their own list name and sentences.
export function InvoiceCards({
  cards,
  auditorOn = false,
  label = "Invoices to approve",
  notices = NO_NOTICES,
}: {
  cards: InvoiceCard[];
  auditorOn?: boolean;
  label?: string;
  notices?: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const audited = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const live = timers.current;
    return () => {
      alive.current = false;
      for (const t of live) clearTimeout(t);
      live.clear();
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      if (alive.current) fn();
    }, ms);
    timers.current.add(t);
  }, []);

  // One audit request per card per mount; a check still running (202) is asked once more after the
  // lease would have lapsed. Whatever the answer, the page is read back for the stored verdict.
  const audit = useCallback(
    async (proposalId: string, retried: boolean) => {
      let running = false;
      try {
        const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/audit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        running = res.status === 202;
      } catch {
        running = false;
      }
      if (!alive.current) return;
      if (running && !retried) {
        later(() => void audit(proposalId, true), AUDIT_RETRY_MS);
        return;
      }
      setChecking((c) => ({ ...c, [proposalId]: false }));
      router.refresh();
    },
    [later, router],
  );

  useEffect(() => {
    if (!auditorOn) return;
    const started: Record<string, boolean> = {};
    for (const c of cards) {
      const id = c.card.id;
      if (c.verdict !== null || c.card.status !== "proposed" || audited.current.has(id)) continue;
      audited.current.add(id);
      started[id] = true;
      void audit(id, false);
    }
    if (Object.keys(started).length > 0) setChecking((s) => ({ ...s, ...started }));
  }, [cards, auditorOn, audit]);

  async function approve(c: InvoiceCard, overrideReason?: string) {
    const id = c.card.id;
    if (busy) return;
    setBusy(id);
    setNotes((n) => ({ ...n, [id]: "" }));
    // The card asked its question (the flag's, or the auditor's for anything but a pass) before
    // Confirm, so that is the second confirm.
    const confirmed = c.flagged || c.verdict !== "pass";
    const body = overrideReason
      ? { confirmed, overrideReason, auditedAt: c.checkedAt ?? undefined }
      : { confirmed };
    const reply = await postJson(`/api/proposals/${encodeURIComponent(id)}/approve`, body);
    if (!reply.ok) setNotes((n) => ({ ...n, [id]: notice(reply.error, notices) }));
    setBusy(null);
    router.refresh();
  }

  async function reject(id: string) {
    if (busy) return;
    setBusy(id);
    setNotes((n) => ({ ...n, [id]: "" }));
    const reply = await postJson(`/api/proposals/${encodeURIComponent(id)}/reject`, { category: "other" });
    if (!reply.ok) setNotes((n) => ({ ...n, [id]: notice(reply.error, notices) }));
    setBusy(null);
    router.refresh();
  }

  return (
    <ul className="grid gap-4" aria-label={label}>
      {cards.map((c) => {
        const id = c.card.id;
        // The page drew an unchecked card as not checked; while this mount waits on the auditor
        // it reads as checking.
        const waiting =
          c.card.audit !== undefined && c.verdict === null && c.card.status === "proposed" && checking[id] === true;
        return (
          <li key={id} className="grid gap-2">
            <ProposalCard
              {...c.card}
              audit={waiting ? { state: "checking" } : c.card.audit}
              pending={busy === id}
              onApprove={(_id, overrideReason) => void approve(c, overrideReason)}
              onReject={(rid) => void reject(rid)}
            />
            {notes[id] ? (
              <p role="status" className="px-1 text-small text-foreground-2">
                {notes[id]}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
