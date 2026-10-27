"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import type { DriverOption } from "@/lib/advances/read";
import {
  ADVANCE_REQUEST_CATEGORIES,
  isDeskAmount,
  parseDollarsToCents,
  REQUEST_CATEGORY_LABELS,
  type AdvanceRequestCategory,
} from "@/lib/advances/request";
import { cn } from "@/lib/cn";

// A fixed sentence per refusal from the desk route; nothing from the server is shown but these.
const NOTICES: Readonly<Record<string, string>> = {
  disabled: "Advances are switched off.",
  agent_off: "The agent is switched off, so the request was not checked.",
  ai_off: "The models are switched off, so the request was not checked.",
  not_found: "That driver is not on file for your carrier.",
  busy: "The agent is answering another question. Try again in a moment.",
  bad_request: "Check the driver, the amount and the reason, then try again.",
  unauthenticated: "Your sign-in ended. Sign in again, then retry.",
  forbidden: "This login cannot make requests for this carrier.",
};
const FALLBACK = "The request did not finish. Open Home to see whether the agent answered before trying again.";

const AMOUNT_HINT = "Dollars and cents, from $1.00 to $10,000.00, like 300 or 300.50.";

export function RequestForm({ drivers, disabled }: { drivers: DriverOption[]; disabled: boolean }) {
  const router = useRouter();
  const [driverId, setDriverId] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<AdvanceRequestCategory | "">("");
  const [errors, setErrors] = useState<{ driver?: string; amount?: string; category?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    const cents = parseDollarsToCents(amount);
    const next = {
      driver: driverId ? undefined : "Pick a driver.",
      amount: cents !== null && isDeskAmount(cents) ? undefined : AMOUNT_HINT,
      category: category ? undefined : "Pick a reason.",
    };
    setErrors(next);
    setNotice(null);
    if (next.driver || next.amount || next.category || cents === null || !category) return;
    setPending(true);
    try {
      const res = await fetch("/api/advances/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driverId, amountCents: cents, category }),
      });
      if (res.ok) {
        router.push("/");
        return;
      }
      let code: unknown = null;
      try {
        code = ((await res.json()) as { error?: unknown }).error;
      } catch {
        code = null;
      }
      setNotice(typeof code === "string" && Object.hasOwn(NOTICES, code) ? NOTICES[code] : FALLBACK);
    } catch {
      setNotice(FALLBACK);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      <Field id="advance-driver" label="Driver" error={errors.driver}>
        {(control) => (
          <select
            {...control}
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            disabled={disabled || pending}
            className={cn(controlClass, "h-9")}
          >
            <option value="">Pick a driver</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}, {d.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="advance-amount" label="Amount" hint={AMOUNT_HINT} error={errors.amount}>
        {(control) => (
          <Input
            {...control}
            inputMode="decimal"
            autoComplete="off"
            placeholder="300.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={disabled || pending}
          />
        )}
      </Field>
      <Field id="advance-category" label="Reason" error={errors.category}>
        {(control) => (
          <select
            {...control}
            value={category}
            onChange={(e) => setCategory(e.target.value as AdvanceRequestCategory | "")}
            disabled={disabled || pending}
            className={cn(controlClass, "h-9")}
          >
            <option value="">Pick a reason</option>
            {ADVANCE_REQUEST_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {REQUEST_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {notice ? <InlineAlert tone="destructive">{notice}</InlineAlert> : null}
      <div>
        <Button type="submit" disabled={disabled} pending={pending} pendingLabel="The agent is checking">
          Ask the agent
        </Button>
      </div>
    </form>
  );
}
