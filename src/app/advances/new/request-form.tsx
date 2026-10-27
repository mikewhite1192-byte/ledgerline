"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import type { DeskLoad, DeskSuggestion, DriverOption } from "@/lib/advances/read";
import {
  ADVANCE_REQUEST_CATEGORIES,
  isDeskAmount,
  parseDollarsToCents,
  REQUEST_CATEGORY_LABELS,
  suggestionInput,
  suggestionLine,
  type AdvanceRequestCategory,
} from "@/lib/advances/request";
import { formatLocalDate } from "@/lib/format/dates";
import { cn } from "@/lib/cn";

// A fixed sentence per refusal from the desk route; nothing from the server is shown but these.
const NOTICES: Readonly<Record<string, string>> = {
  disabled: "Advances are switched off.",
  agent_off: "The agent is switched off, so the request was not checked.",
  ai_off: "The models are switched off, so the request was not checked.",
  not_found: "That driver or load is not on file for your carrier.",
  busy: "The agent is answering another question. Try again in a moment.",
  bad_request: "Check the driver, the amount and the reason, then try again.",
  unauthenticated: "Your sign-in ended. Sign in again, then retry.",
  forbidden: "This login cannot make requests for this carrier.",
};
const FALLBACK = "The request did not finish. Open Home to see whether the agent answered before trying again.";

const AMOUNT_HINT = "Dollars and cents, from $1.00 to $10,000.00, like 300 or 300.50.";
const SUGGEST_FAILED = "The suggestion could not be read. The agent still checks the pay rules.";

type SuggestBody = { loads?: DeskLoad[]; suggestion?: DeskSuggestion; error?: unknown };

export function RequestForm({ drivers, disabled }: { drivers: DriverOption[]; disabled: boolean }) {
  const router = useRouter();
  const [driverId, setDriverId] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<AdvanceRequestCategory | "">("");
  const [errors, setErrors] = useState<{ driver?: string; amount?: string; category?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loads, setLoads] = useState<DeskLoad[]>([]);
  const [loadId, setLoadId] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  // Each pick asks again; only the newest answer is shown.
  const asked = useRef(0);

  // The pay rules' suggestion for the picked driver and load, computed on the server. The amount
  // field takes it only while it is empty, so a typed amount is never overwritten.
  async function suggest(nextDriver: string, nextLoad: string) {
    const ask = ++asked.current;
    setSuggestion(null);
    if (!nextDriver) {
      setLoads([]);
      return;
    }
    try {
      const res = await fetch("/api/advances/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextLoad ? { driverId: nextDriver, loadId: nextLoad } : { driverId: nextDriver }),
      });
      const body = (await res.json()) as SuggestBody;
      if (ask !== asked.current) return;
      if (!res.ok || !body.suggestion) {
        setSuggestion(SUGGEST_FAILED);
        return;
      }
      if (!nextLoad) setLoads(Array.isArray(body.loads) ? body.loads : []);
      setSuggestion(suggestionLine(body.suggestion));
      const filled = body.suggestion.armed ? suggestionInput(body.suggestion.suggestedCents) : "";
      if (filled) setAmount((current) => (current.trim() === "" ? filled : current));
    } catch {
      if (ask === asked.current) setSuggestion(SUGGEST_FAILED);
    }
  }

  function pickDriver(value: string) {
    setDriverId(value);
    setLoadId("");
    setLoads([]);
    void suggest(value, "");
  }

  function pickLoad(value: string) {
    setLoadId(value);
    void suggest(driverId, value);
  }

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
        body: JSON.stringify(loadId ? { driverId, amountCents: cents, category, loadId } : { driverId, amountCents: cents, category }),
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
            onChange={(e) => pickDriver(e.target.value)}
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
      <Field
        id="advance-load"
        label="For load (optional)"
        hint={driverId ? "Loads this driver delivered in the last 45 days, newest first." : "Pick a driver first."}
      >
        {(control) => (
          <select
            {...control}
            value={loadId}
            onChange={(e) => pickLoad(e.target.value)}
            disabled={disabled || pending || !driverId}
            className={cn(controlClass, "h-9")}
          >
            <option value="">No particular load</option>
            {loads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.number}, delivered {formatLocalDate(l.deliveredOn)}
              </option>
            ))}
          </select>
        )}
      </Field>
      {suggestion ? (
        <p className="text-body text-foreground-2" aria-live="polite">
          {suggestion}
        </p>
      ) : null}
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
