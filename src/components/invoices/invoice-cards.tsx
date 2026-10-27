"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProposalCard, type ProposalCardProps } from "@/components/app/proposal-card";
import { outcomeLabel } from "@/lib/invoices/labels";
import { postJson } from "./post-json";

export type InvoiceCard = Omit<ProposalCardProps, "hrefFor" | "onApprove" | "onReject" | "pending">;

// Why an approval did not go through, before the executor's own outcomes. Fixed sentences only.
const APPROVE_NOTICE: Readonly<Record<string, string>> = {
  not_executable: "This kind of proposal cannot run yet. Nothing changed.",
  already_decided: "This proposal was already decided.",
  expired: "This proposal expired. Refresh the queue for a fresh one.",
  role: "An admin must approve an amount this size.",
  not_found: "That proposal is not here.",
  unavailable: "The approval did not go through. Nothing changed. Try again in a moment.",
};

const notice = (category: string | null) =>
  category && Object.hasOwn(APPROVE_NOTICE, category) ? APPROVE_NOTICE[category] : outcomeLabel(category);

// The engine's invoice cards. Approve runs the existing approve route (the gate and the
// invoice_post executor); Reject records the decision. Either way the page reads itself back.
export function InvoiceCards({ cards }: { cards: InvoiceCard[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function decide(id: string, action: "approve" | "reject") {
    if (busy) return;
    setBusy(id);
    setNotes((n) => ({ ...n, [id]: "" }));
    const reply = await postJson(
      `/api/proposals/${encodeURIComponent(id)}/${action}`,
      action === "approve" ? { confirmed: false } : { category: "other" },
    );
    if (!reply.ok) setNotes((n) => ({ ...n, [id]: notice(reply.error) }));
    setBusy(null);
    router.refresh();
  }

  return (
    <ul className="grid gap-4" aria-label="Invoices to approve">
      {cards.map((c) => (
        <li key={c.id} className="grid gap-2">
          <ProposalCard
            {...c}
            pending={busy === c.id}
            onApprove={(id) => void decide(id, "approve")}
            onReject={(id) => void decide(id, "reject")}
          />
          {notes[c.id] ? (
            <p role="status" className="px-1 text-small text-foreground-2">
              {notes[c.id]}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
