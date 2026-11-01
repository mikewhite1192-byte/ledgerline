"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import {
  CHECK_FIELDS,
  PAY_BASES,
  RATE_SENTENCES,
  readDriverForm,
  WORKER_TYPES,
  type DriverFormErrors,
  type DriverFormText,
  type PayBasis,
} from "@/lib/drivers/draft";

// The Add driver form: who the driver is, how they are paid, and when they start. The browser checks
// each field with the route's own rules first; the route checks the role, the switch and the body
// again. On success the page moves to the new driver's record, where an admin adds a card and arms
// them. A fixed sentence per refusal; nothing from the server is shown but these.

export type DriverSend = (body: Record<string, unknown>) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;

async function postDriver(body: Record<string, unknown>): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/drivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let out: { id?: unknown; error?: unknown } = {};
    try {
      out = (await res.json()) as { id?: unknown; error?: unknown };
    } catch {
      out = {};
    }
    if (res.ok && typeof out.id === "string") return { ok: true, id: out.id };
    return { ok: false, error: typeof out.error === "string" ? out.error : "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

const NOTICES: Readonly<Record<string, string>> = {
  disabled: "Adding a driver is switched off. Nothing was added.",
  role: "Only an admin adds a driver. Nothing was added.",
  judge: "This step is for the carrier's staff. Nothing was added.",
  forbidden: "This login cannot add drivers for this carrier. Nothing was added.",
  unauthenticated: "Your sign-in ended. Sign in again, then retry.",
  bad_request: CHECK_FIELDS,
};
// Anything else (a timeout, a server error) is not known to have failed: the driver may be saved.
const UNKNOWN = "The driver may or may not have been saved. Search the drivers list for the code before trying again.";

const WORKER_LABELS: Readonly<Record<(typeof WORKER_TYPES)[number], string>> = {
  company: "Company driver",
  owner_operator: "Owner-operator",
};
const BASIS_LABELS: Readonly<Record<PayBasis, string>> = {
  per_mile: "Per mile",
  percent: "Percent of linehaul",
  flat: "Flat per load",
};
const RATE_LABELS: Readonly<Record<PayBasis, string>> = {
  per_mile: "Dollars per mile",
  percent: "Percent of linehaul",
  flat: "Dollars per load",
};

const EMPTY = (today: string): DriverFormText => ({
  code: "",
  firstName: "",
  lastName: "",
  email: "",
  workerType: "company",
  payBasis: "per_mile",
  rate: "",
  advanceLimit: "",
  truckUnit: "",
  tankGallons: "200",
  activeFrom: today,
  ownInsurance: false,
  preferredLanguage: "en",
});

export function DriverForm({ today, send = postDriver }: { today: string; send?: DriverSend }) {
  const router = useRouter();
  const uid = useId();
  const [text, setText] = useState<DriverFormText>(() => EMPTY(today));
  const [errors, setErrors] = useState<Omit<DriverFormErrors, "code"> & { code?: ReactNode }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof DriverFormText>(key: K, value: DriverFormText[K]) =>
    setText((t) => ({ ...t, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setNotice(null);
    const read = readDriverForm(text);
    if (!read.ok) {
      setErrors(read.errors);
      if (read.errors.form) setNotice(read.errors.form);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const out = await send(read.body);
      if (out.ok) {
        router.push(`/records/drivers/${encodeURIComponent(out.id)}`);
        return;
      }
      if (out.error === "code_taken") {
        const code = read.body.code;
        setErrors({
          code: (
            <>
              A driver with code {code} already exists.{" "}
              <Link href={`/drivers?status=all&q=${encodeURIComponent(code)}`} className="underline">
                Find them
              </Link>
            </>
          ),
        });
      } else if (out.error === "email_taken") {
        setErrors({ email: "Another driver on file already uses this email." });
      } else {
        setNotice(NOTICES[out.error] ?? UNKNOWN);
      }
    } finally {
      setPending(false);
    }
  }

  const field = (key: "code" | "firstName" | "lastName" | "email" | "truckUnit", label: string, hint?: string) => (
    <Field id={`${uid}-${key}`} label={label} hint={hint} error={errors[key]}>
      {(control) => (
        <Input
          {...control}
          autoComplete="off"
          value={text[key]}
          onChange={(e) => set(key, e.target.value)}
          disabled={pending}
        />
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {field("code", "Driver code", "Letters, digits and dashes, like BR-D27.")}
        {field("email", "Email")}
        {field("firstName", "First name")}
        {field("lastName", "Last name")}
        <Field id={`${uid}-worker`} label="Type" error={errors.workerType}>
          {(control) => (
            <select
              {...control}
              value={text.workerType}
              onChange={(e) => set("workerType", e.target.value === "owner_operator" ? "owner_operator" : "company")}
              disabled={pending}
              className={cn(controlClass, "h-9")}
            >
              {WORKER_TYPES.map((w) => (
                <option key={w} value={w}>
                  {WORKER_LABELS[w]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${uid}-basis`} label="Paid by" error={errors.payBasis}>
          {(control) => (
            <select
              {...control}
              value={text.payBasis}
              onChange={(e) => {
                const basis = PAY_BASES.find((b) => b === e.target.value) ?? "per_mile";
                setText((t) => ({ ...t, payBasis: basis, rate: "" }));
              }}
              disabled={pending}
              className={cn(controlClass, "h-9")}
            >
              {PAY_BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABELS[b]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${uid}-rate`} label={RATE_LABELS[text.payBasis]} hint={RATE_SENTENCES[text.payBasis]} error={errors.rate}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={text.rate}
              onChange={(e) => set("rate", e.target.value)}
              disabled={pending}
            />
          )}
        </Field>
        <Field
          id={`${uid}-limit`}
          label="Advance limit (optional)"
          hint="Dollars. Empty uses the carrier's default."
          error={errors.advanceLimit}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={text.advanceLimit}
              onChange={(e) => set("advanceLimit", e.target.value)}
              disabled={pending}
            />
          )}
        </Field>
        {field("truckUnit", "Truck (optional)")}
        <Field id={`${uid}-tank`} label="Tank gallons" error={errors.tankGallons}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              value={text.tankGallons}
              onChange={(e) => set("tankGallons", e.target.value)}
              disabled={pending}
            />
          )}
        </Field>
        <Field id={`${uid}-from`} label="Starts on" error={errors.activeFrom}>
          {(control) => (
            <Input {...control} type="date" value={text.activeFrom} onChange={(e) => set("activeFrom", e.target.value)} disabled={pending} />
          )}
        </Field>
        <Field id={`${uid}-lang`} label="Notes language" error={errors.preferredLanguage}>
          {(control) => (
            <select
              {...control}
              value={text.preferredLanguage}
              onChange={(e) => set("preferredLanguage", e.target.value === "es" ? "es" : "en")}
              disabled={pending}
              className={cn(controlClass, "h-9")}
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select>
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-body text-foreground">
        <input
          type="checkbox"
          checked={text.ownInsurance}
          onChange={(e) => set("ownInsurance", e.target.checked)}
          disabled={pending}
          className="size-4"
        />
        Carries their own insurance
      </label>
      <p className="text-small text-muted-foreground">
        A new driver starts not armed and with no card. Add a card and arm them on their page before an advance can be paid.
      </p>
      {notice ? <InlineAlert tone="destructive">{notice}</InlineAlert> : null}
      <div>
        <Button type="submit" pending={pending} pendingLabel="Adding">
          Add driver
        </Button>
      </div>
    </form>
  );
}
