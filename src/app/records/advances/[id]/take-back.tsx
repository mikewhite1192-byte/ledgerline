"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import { takeBackSentence } from "@/lib/advances/reasons";
import { parseDollarsToCents, suggestionInput } from "@/lib/advances/request";
import { TAKEBACK_REASON_LABELS, TAKEBACK_REASONS, type TakebackReason } from "@/lib/advances/takeback-words";
import { cn } from "@/lib/cn";
import { dollars } from "@/lib/money/format";

// Take back, on an advance's page. A paid advance records the amount taken back (up to what is
// still owed); one not yet paid is cancelled with nothing taken. Nothing is pulled off the card.
// The route re-checks the switch, the size rule and the advance's state itself. The page reads the
// advance again after a press, which usually stops offering Take back; its notice still shows.
export function TakeBack({
  advanceId,
  offered,
  paid,
  stillOwedCents,
}: {
  advanceId: string;
  offered: boolean;
  paid: boolean;
  stillOwedCents: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(paid ? suggestionInput(stillOwedCents) : "");
  const [reason, setReason] = useState<TakebackReason | "">("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const cents = paid ? parseDollarsToCents(amount) : 0;
    const next = {
      amount:
        !paid || (cents !== null && cents > 0 && cents <= stillOwedCents)
          ? undefined
          : `Dollars and cents, above zero and up to ${dollars(stillOwedCents)}.`,
      reason: reason ? undefined : "Pick a reason.",
    };
    setErrors(next);
    setNotice(null);
    if (next.amount || next.reason || cents === null || !reason) return;
    setPending(true);
    try {
      const res = await fetch(`/api/advances/${encodeURIComponent(advanceId)}/take-back`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: cents, reason }),
      });
      let body: { error?: unknown; changed?: unknown; status?: unknown } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        body = {};
      }
      if (res.ok) {
        const text =
          body.changed === false
            ? "This was already recorded. Nothing changed."
            : body.status === "cancelled"
              ? "Cancelled. Nothing was paid, so nothing was taken back."
              : `Recorded ${dollars(cents)} taken back. Nothing was pulled off the card.`;
        setNotice({ ok: true, text });
        setOpen(false);
      } else {
        setNotice({ ok: false, text: takeBackSentence(typeof body.error === "string" ? body.error : "unavailable") });
      }
    } catch {
      setNotice({ ok: false, text: takeBackSentence("unavailable") });
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  if (!offered && !notice) return null;
  return (
    <div className="grid gap-3">
      {!offered ? null : open ? (
        <form onSubmit={submit} noValidate className="grid gap-4 rounded-lg border border-border bg-card p-4">
          <p className="text-body text-foreground-2">
            {paid
              ? "Records how much of this advance came back. It stops counting as owed and is not taken from pay. Nothing is pulled off the card."
              : "Nothing was paid on this advance, so taking it back cancels it."}
          </p>
          {paid ? (
            <Field id="takeback-amount" label="Amount taken back" error={errors.amount}>
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setErrors((prev) => ({ ...prev, amount: undefined }));
                  }}
                  disabled={pending}
                />
              )}
            </Field>
          ) : null}
          <Field id="takeback-reason" label="Reason" error={errors.reason}>
            {(control) => (
              <select
                {...control}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value as TakebackReason | "");
                  setErrors((prev) => ({ ...prev, reason: undefined }));
                }}
                disabled={pending}
                className={cn(controlClass, "h-9")}
              >
                <option value="">Pick a reason</option>
                {TAKEBACK_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {TAKEBACK_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" pending={pending} pendingLabel="Recording">
              {paid ? "Record take-back" : "Cancel this advance"}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Never mind
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Take back
          </Button>
        </div>
      )}
      {notice ? <InlineAlert tone={notice.ok ? "success" : "destructive"}>{notice.text}</InlineAlert> : null}
    </div>
  );
}
