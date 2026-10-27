"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import { parseDollarsToCents } from "@/lib/advances/request";
import { cn } from "@/lib/cn";
import type { RequestChoiceLoad, RequestChoiceReceipt } from "@/lib/money-codes/request";
import { PURPOSE_CHOICES, requestSentence } from "@/lib/money-codes/words";
import type { MoneyCodePurpose } from "@/lib/rules-engine/money-codes";

const loadWords = (l: RequestChoiceLoad) =>
  `${l.loadNumber}, ${l.driverName} (${l.driverCode}), ${l.status === "delivered" ? "delivered" : "on the road"}`;

// The request form. Every refusal shows as a fixed sentence for its category; the server's pay
// rules decide, this only checks that each field is filled in.
export function CodeRequestForm({
  loads,
  receipts,
  capCents,
  capWords,
}: {
  loads: RequestChoiceLoad[];
  receipts: RequestChoiceReceipt[];
  capCents: number | null;
  capWords: string | null;
}) {
  const router = useRouter();
  const [loadId, setLoadId] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState<MoneyCodePurpose | "">("");
  const [documentId, setDocumentId] = useState("");
  const [errors, setErrors] = useState<{ load?: string; amount?: string; purpose?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const amountHint = capWords
    ? `Dollars and cents, up to ${capWords}, like 150 or 150.00. Use the receipt's total when there is one.`
    : "Dollars and cents, like 150 or 150.00. Use the receipt's total when there is one.";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const cents = parseDollarsToCents(amount);
    const amountOk = cents !== null && cents > 0 && (capCents === null || cents <= capCents);
    const next = {
      load: loadId ? undefined : "Pick a load.",
      amount: amountOk ? undefined : amountHint,
      purpose: purpose ? undefined : "Pick what the code is for.",
    };
    setErrors(next);
    setNotice(null);
    if (next.load || next.amount || next.purpose || cents === null || !purpose) return;
    setPending(true);
    try {
      const res = await fetch("/api/money-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loadId, amountCents: cents, purpose, documentId: documentId || null }),
      });
      if (res.ok) {
        router.push("/money-codes");
        return;
      }
      let code: unknown = null;
      try {
        code = ((await res.json()) as { error?: unknown }).error;
      } catch {
        code = null;
      }
      setNotice(requestSentence(typeof code === "string" ? code : null));
    } catch {
      setNotice(requestSentence(null));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      <Field
        id="code-load"
        label="Load"
        hint={loads.length > 0 ? "Loads on the road or delivered in the last three days. The driver comes with the load." : "No load is on the road or was delivered in the last three days."}
        error={errors.load}
      >
        {(control) => (
          <select
            {...control}
            value={loadId}
            onChange={(e) => setLoadId(e.target.value)}
            disabled={pending || loads.length === 0}
            className={cn(controlClass, "h-9")}
          >
            <option value="">Pick a load</option>
            {loads.map((l) => (
              <option key={l.id} value={l.id}>
                {loadWords(l)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="code-amount" label="Amount" hint={amountHint} error={errors.amount}>
        {(control) => (
          <Input
            {...control}
            inputMode="decimal"
            autoComplete="off"
            placeholder="150.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={pending}
          />
        )}
      </Field>
      <Field id="code-purpose" label="For" error={errors.purpose}>
        {(control) => (
          <select
            {...control}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as MoneyCodePurpose | "")}
            disabled={pending}
            className={cn(controlClass, "h-9")}
          >
            <option value="">Pick what it is for</option>
            {PURPOSE_CHOICES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        id="code-receipt"
        label="Receipt (optional)"
        hint="A receipt read in the last week. With one, the amount must equal its total and it must name this load."
      >
        {(control) => (
          <select
            {...control}
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            disabled={pending}
            className={cn(controlClass, "h-9")}
          >
            <option value="">No receipt</option>
            {receipts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.filename}
              </option>
            ))}
          </select>
        )}
      </Field>
      {notice ? <InlineAlert tone="destructive">{notice}</InlineAlert> : null}
      <div>
        <Button type="submit" pending={pending} pendingLabel="Checking" disabled={loads.length === 0}>
          Send for approval
        </Button>
      </div>
    </form>
  );
}
