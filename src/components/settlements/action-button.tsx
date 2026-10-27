"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { settlementOutcome } from "@/lib/settlements/labels";

type Kind = "run" | "post" | "retry";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const whole = (v: unknown): number => (Number.isSafeInteger(v) ? (v as number) : 0);

const LEG_STATE: Readonly<Record<string, string>> = {
  confirmed: "done",
  sent: "sent, waiting on the read-back",
  reserved: "waiting to send",
  unknown: "sent, waiting on the read-back",
  failed: "failed",
  not_started: "not started",
  attempts_used: "tried the most times allowed",
};

const legWords = (v: unknown) => (typeof v === "string" && Object.hasOwn(LEG_STATE, v) ? LEG_STATE[v] : settlementOutcome(String(v)));

// What a reply that went through says, from its fields. Fixed sentences and counts only.
export function doneNote(kind: Kind, data: Record<string, unknown>): string {
  if (kind === "run") {
    const c = (data.counts ?? {}) as Record<string, unknown>;
    const parts = [plural(whole(c.drafts), "paystub drafted", "paystubs drafted")];
    if (whole(c.exceptions) > 0) parts.push(plural(whole(c.exceptions), "has exceptions", "have exceptions"));
    if (whole(c.locked) > 0) parts.push(`${whole(c.locked)} already approved or paid`);
    return `${parts.join(", ")}.${c.truncated === true ? " More drivers wait for the next run." : ""}`;
  }
  if (kind === "post") {
    const legs = (data.legs ?? {}) as Record<string, unknown>;
    return `Bill: ${legWords(legs.bill)}. Bill payment: ${legWords(legs.billPayment)}.`;
  }
  return `Payout: ${legWords(data.state)}.`;
}

// One POST button on a settlement screen: a second press while the first runs does nothing, the
// outcome reads as a fixed sentence (categories only), and the page reads itself back after.
export function SettlementAction({
  url,
  label,
  kind,
  body,
  variant = "primary",
}: {
  url: string;
  label: string;
  kind: Kind;
  body?: Record<string, string>;
  variant?: "primary" | "outline";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function run() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson(url, body);
    setNote(reply.ok ? doneNote(kind, reply.data) : settlementOutcome(reply.error));
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant={variant} pending={pending} onClick={() => void run()}>
        {label}
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
