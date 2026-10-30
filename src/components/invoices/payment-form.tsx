"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Money } from "@/components/app/money";
import { Term } from "@/components/app/term";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { formatLocalDate } from "@/lib/format/dates";
import { outcomeLabel } from "@/lib/invoices/labels";
import {
  centsToDollarsText,
  dollarsToCents,
  MAX_MEMO,
  MAX_PAYMENT_REF,
  PAYMENT_METHODS,
  PAYMENT_REF,
} from "@/lib/invoices/form-text";
import type { PaymentFormCustomer } from "@/lib/invoices/views";
import { postJson } from "./post-json";

const METHOD_WORDS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  check: "Check",
  ach: "ACH",
  wire: "Wire",
};

// Oldest due first, each up to its balance, until the payment runs out.
function prefill(customer: PaymentFormCustomer | undefined, amountCents: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  let left = amountCents ?? 0;
  for (const inv of customer?.invoices ?? []) {
    const take = Math.min(left, inv.balanceCents);
    out[inv.id] = take > 0 ? centsToDollarsText(take) : "";
    left -= take;
  }
  return out;
}

// One customer payment: who paid, when, how much, the reference, and how much goes to each open
// invoice. The server checks everything again; the reference is unique per carrier, so a second
// send of the same form is the same payment.
export function PaymentForm({
  customers,
  today,
  initialCustomerId,
}: {
  customers: PaymentFormCustomer[];
  today: string;
  initialCustomerId?: string;
}) {
  const router = useRouter();
  const first = customers.find((c) => c.id === initialCustomerId) ?? customers[0];
  const [customerId, setCustomerId] = useState(first?.id ?? "");
  const [receivedOn, setReceivedOn] = useState(today);
  const [amountText, setAmountText] = useState("");
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("check");
  const [paymentRef, setPaymentRef] = useState("");
  const [memo, setMemo] = useState("");
  const [apps, setApps] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState<{ paymentId: string; created: boolean } | null>(null);

  const customer = customers.find((c) => c.id === customerId);
  const amountCents = dollarsToCents(amountText);
  const appCents = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const inv of customer?.invoices ?? []) {
      const text = (apps[inv.id] ?? "").trim();
      out[inv.id] = text === "" ? 0 : dollarsToCents(text);
    }
    return out;
  }, [apps, customer]);
  const appliedCents = Object.values(appCents).reduce<number>((s, c) => s + (c ?? 0), 0);
  const badApp = (customer?.invoices ?? []).find((inv) => {
    const c = appCents[inv.id];
    return c === null || c === undefined || c > inv.balanceCents;
  });
  const overApplied = amountCents !== null && appliedCents > amountCents;
  const refOk = PAYMENT_REF.test(paymentRef);
  const ready =
    !!customer &&
    amountCents !== null &&
    amountCents > 0 &&
    refOk &&
    !badApp &&
    !overApplied &&
    receivedOn !== "" &&
    receivedOn <= today;

  // Any edit clears the last refusal, so it never sits under a form it no longer describes.
  function pickCustomer(id: string) {
    setProblem("");
    setCustomerId(id);
    setTouched(false);
    setApps(prefill(customers.find((c) => c.id === id), amountCents));
  }

  function changeAmount(text: string) {
    setProblem("");
    setAmountText(text);
    if (!touched) setApps(prefill(customer, dollarsToCents(text)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // A second click while the first is running does nothing; the server's key is the real guard.
    if (inFlight.current || !ready || amountCents === null || !customer) return;
    inFlight.current = true;
    setPending(true);
    setProblem("");
    try {
      const applications = customer.invoices
        .map((inv) => ({ invoiceId: inv.id, amountCents: appCents[inv.id] ?? 0 }))
        .filter((a) => a.amountCents > 0);
      const reply = await postJson("/api/customer-payments", {
        customerId: customer.id,
        receivedOn,
        amountCents,
        method,
        paymentRef,
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        applications,
      });
      const paymentId = typeof reply.data.paymentId === "string" ? reply.data.paymentId : null;
      if (reply.ok && paymentId) {
        setDone({ paymentId, created: reply.data.created === true });
        router.refresh();
      } else {
        // A success with no payment id is a reply the form cannot read: the outcome is not known.
        setProblem(outcomeLabel(reply.ok ? "unknown" : reply.error));
      }
    } finally {
      // Whatever happened, the button comes back.
      inFlight.current = false;
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="grid gap-3">
        <InlineAlert tone="success">
          {done.created ? "Payment recorded." : "This payment was already recorded with that reference."}
        </InlineAlert>
        <div className="flex flex-wrap gap-4">
          <Link
            href={`/records/customer_payments/${encodeURIComponent(done.paymentId)}`}
            className="text-body text-link underline-offset-4 hover:underline"
          >
            Open the payment
          </Link>
          <button
            type="button"
            className="text-body text-link underline-offset-4 hover:underline"
            onClick={() => {
              setDone(null);
              setAmountText("");
              setPaymentRef("");
              setMemo("");
              setTouched(false);
              setApps({});
            }}
          >
            Record another
          </button>
        </div>
      </div>
    );
  }

  return (
    // A payment a person records and applies: its amounts never hide.
    <form onSubmit={(e) => void submit(e)} className="grid gap-5" noValidate data-amounts="shown">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pay-customer" label="Customer">
          {(p) => (
            <select
              {...p}
              className={cn(controlClass, "h-9")}
              value={customerId}
              onChange={(e) => pickCustomer(e.target.value)}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="pay-received"
          label="Date received"
          error={receivedOn === "" ? "Enter the date received." : receivedOn > today ? "Not after today." : undefined}
        >
          {(p) => (
            <Input
              {...p}
              type="date"
              max={today}
              value={receivedOn}
              onChange={(e) => {
                setProblem("");
                setReceivedOn(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          id="pay-amount"
          label="Amount"
          hint="Dollars and cents, for example 1250.00"
          error={amountText !== "" && (amountCents === null || amountCents === 0) ? "Enter an amount above zero." : undefined}
        >
          {(p) => (
            <Input {...p} inputMode="decimal" autoComplete="off" value={amountText} onChange={(e) => changeAmount(e.target.value)} />
          )}
        </Field>
        <Field id="pay-method" label="Method">
          {(p) => (
            <select
              {...p}
              className={cn(controlClass, "h-9")}
              value={method}
              onChange={(e) => {
                setProblem("");
                setMethod(e.target.value as (typeof PAYMENT_METHODS)[number]);
              }}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_WORDS[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="pay-ref"
          label="Reference"
          hint={`The check or ACH number: letters, digits and dashes, up to ${MAX_PAYMENT_REF}.`}
          error={paymentRef !== "" && !refOk ? `Letters, digits and dashes only, up to ${MAX_PAYMENT_REF}.` : undefined}
        >
          {(p) => (
            <Input
              {...p}
              autoComplete="off"
              maxLength={MAX_PAYMENT_REF}
              value={paymentRef}
              onChange={(e) => {
                setProblem("");
                setPaymentRef(e.target.value);
              }}
            />
          )}
        </Field>
        <Field id="pay-memo" label="Memo (optional)">
          {(p) => (
            <Input
              {...p}
              maxLength={MAX_MEMO}
              value={memo}
              onChange={(e) => {
                setProblem("");
                setMemo(e.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-small font-semibold text-foreground-2">Apply to open invoices</legend>
        {customer && customer.invoices.length > 0 ? (
          <ul className="grid gap-2">
            {customer.invoices.map((inv) => {
              const c = appCents[inv.id];
              const wrong = c === null || (c ?? 0) > inv.balanceCents;
              return (
                <li key={inv.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[1fr_auto_10rem]">
                  <span className="min-w-0 text-body text-foreground">
                    {inv.invoiceNumber}
                    <span className="ml-2 text-small text-foreground-2">due {formatLocalDate(inv.dueOn)}</span>
                  </span>
                  <span className="text-small text-foreground-2">
                    owes <Money cents={inv.balanceCents} tone="plain" />
                  </span>
                  <Input
                    aria-label={`Amount for ${inv.invoiceNumber}`}
                    aria-invalid={wrong ? true : undefined}
                    inputMode="decimal"
                    autoComplete="off"
                    className="col-span-2 sm:col-span-1"
                    value={apps[inv.id] ?? ""}
                    onChange={(e) => {
                      setProblem("");
                      setTouched(true);
                      setApps((a) => ({ ...a, [inv.id]: e.target.value }));
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-body text-foreground-2">No open invoices. The whole payment stays as credit.</p>
        )}
      </fieldset>

      <p className="text-body text-foreground" aria-live="polite">
        Applied <Money cents={appliedCents} tone="plain" />
        {" · "}
        <Term id="credit-on-account">Credit on account</Term>{" "}
        <Money cents={Math.max(0, (amountCents ?? 0) - appliedCents)} tone="plain" />
      </p>
      {badApp ? <InlineAlert tone="warning">An amount is not valid or is more than that invoice owes.</InlineAlert> : null}
      {overApplied ? <InlineAlert tone="warning">More is applied than the payment.</InlineAlert> : null}
      {problem ? <InlineAlert tone="destructive">{problem}</InlineAlert> : null}

      <div>
        <Button type="submit" pending={pending} disabled={!ready || pending}>
          Record payment
        </Button>
      </div>
    </form>
  );
}
