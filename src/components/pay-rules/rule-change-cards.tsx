"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProposalCard, type ProposalCardProps } from "@/components/app/proposal-card";
import { rejectNotice } from "@/components/app/reject-notice";
import { postJson } from "@/components/invoices/post-json";
import { NOT_NOW_FAILED, SAVE_FAILED, SAVE_NOTICES } from "@/lib/pay-rules/words";

// The card as the page drew it, plus what the save needs from the stored change: the double-check's
// verdict and whether the message behind it was flagged.
export type RuleChangeCard = {
  card: Omit<ProposalCardProps, "hrefFor" | "onApprove" | "onReject" | "pending">;
  verdict: string | null;
  flagged: boolean;
};

// The double-check's lease: a check still running is asked again once, after it would have lapsed.
const AUDIT_RETRY_MS = 90_000;

// What the page says under a card when a save does not go through. An empty line says nothing more:
// the card's own line, read back, already says it.
const saveNotice = (category: string | null) =>
  category && Object.hasOwn(SAVE_NOTICES, category) ? SAVE_NOTICES[category] : SAVE_FAILED;

// The pay rule changes waiting on the Pay rules page, through the same gate as the chat's cards.
// With the double-check on, each waiting card nobody has checked is sent to it once per mount. Save
// runs the approve route (the gate, then the executor) and sends the second confirm whenever the
// card asked its question: a flag, or any verdict but a pass. A blocked card cannot be saved, so it
// carries no override. Not now records the decision. Either way the page reads itself back.
export function RuleChangeCards({ cards, auditorOn = false }: { cards: RuleChangeCard[]; auditorOn?: boolean }) {
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

  // One check request per card per mount; a check still running (202) is asked once more after the
  // lease would have lapsed. Whatever the answer, the page is read back for the stored verdict.
  const audit = useCallback(
    async (id: string, retried: boolean) => {
      let running = false;
      try {
        const res = await fetch(`/api/proposals/${encodeURIComponent(id)}/audit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        running = res.status === 202;
      } catch {
        running = false;
      }
      if (!alive.current) return;
      if (running && !retried) {
        later(() => void audit(id, true), AUDIT_RETRY_MS);
        return;
      }
      setChecking((c) => ({ ...c, [id]: false }));
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

  async function save(c: RuleChangeCard) {
    const id = c.card.id;
    if (busy) return;
    setBusy(id);
    setNotes((n) => ({ ...n, [id]: "" }));
    // The card asked its question (the flag's, or the double-check's for anything but a pass)
    // before Confirm, so that is the second confirm.
    const confirmed = c.flagged || c.verdict !== "pass";
    const reply = await postJson(`/api/proposals/${encodeURIComponent(id)}/approve`, { confirmed });
    if (!reply.ok) setNotes((n) => ({ ...n, [id]: saveNotice(reply.error) }));
    setBusy(null);
    router.refresh();
  }

  async function notNow(id: string) {
    if (busy) return;
    setBusy(id);
    setNotes((n) => ({ ...n, [id]: "" }));
    const reply = await postJson(`/api/proposals/${encodeURIComponent(id)}/reject`, { category: "other" });
    if (!reply.ok) setNotes((n) => ({ ...n, [id]: rejectNotice(reply.error, NOT_NOW_FAILED) }));
    setBusy(null);
    router.refresh();
  }

  return (
    <ul className="grid gap-4" aria-label="Pay rule changes waiting for you">
      {cards.map((c) => {
        const id = c.card.id;
        // The page drew an unchecked card as not checked; while this mount waits on the check it
        // reads as checking.
        const waiting =
          c.card.audit !== undefined && c.verdict === null && c.card.status === "proposed" && checking[id] === true;
        return (
          <li key={id} className="grid gap-2">
            <ProposalCard
              {...c.card}
              audit={waiting ? { state: "checking" } : c.card.audit}
              pending={busy === id}
              onApprove={() => void save(c)}
              onReject={(rid) => void notNow(rid)}
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
