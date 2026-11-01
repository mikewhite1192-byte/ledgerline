"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input, controlClass } from "@/components/ui/input";
import type { NewLoadDraft } from "@/lib/mock-tms/new-load";
import { createLoadAction, type NewLoadCategory, type NewLoadState } from "../../actions";

// A fixed message per category; nothing the server says is shown.
export const NEW_LOAD_MESSAGES: Record<NewLoadCategory, string> = {
  disabled: "New loads are switched off in the sample dispatch system. Nothing was created.",
  forbidden: "Only a member of this carrier can create its loads. Nothing was created.",
  not_demo: "This carrier is not a demo carrier. Nothing was created.",
  bad_request:
    "Check each field: a load number of 2 to 40 letters, digits or dashes, a place from each list, whole miles and a rate in dollars. Nothing was created.",
  unreadable: "Could not reach the database. Nothing was created. Try again in a moment.",
  unknown: "The load did not confirm, so it may have been created. Open the board before trying again.",
  failed: "The load failed a check and was undone. Nothing was created.",
  not_found: "This carrier is not on the sample dispatch system. Nothing was created.",
  cap: "This carrier has reached its limit of new loads; a demo reset clears them. Nothing was created.",
  exists: "A load with that number already exists. Pick another number. Nothing was created.",
  unknown_customer: "Pick a customer from the list. Nothing was created.",
  unknown_driver: "Pick a driver from the list. Nothing was created.",
  bad_date:
    "The pickup must be today or up to 2 days back, and the delivery on or after it, at most 14 days later. Nothing was created.",
};

type Choice = { value: string; label: string };

function StopFields({
  kind,
  defaultOn,
  defaultPlace,
  places,
}: {
  kind: "pickup" | "delivery";
  defaultOn: string;
  defaultPlace: string;
  places: Choice[];
}) {
  const word = kind === "pickup" ? "Pickup" : "Delivery";
  return (
    <fieldset className="grid gap-3">
      <legend className="text-body text-foreground">{word}</legend>
      <div className="flex flex-wrap gap-3">
        <Field id={`${kind}-place`} label="Place">
          {(c) => (
            <select {...c} name={`${kind}Place`} className={controlClass} defaultValue={defaultPlace} required>
              <option value="" disabled>
                Pick a place
              </option>
              {places.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${kind}-on`} label="Date">
          {(c) => <Input {...c} type="date" name={`${kind}On`} required defaultValue={defaultOn} />}
        </Field>
      </div>
    </fieldset>
  );
}

export function NewLoadForm({
  suggestedNumber,
  today,
  customers,
  drivers,
  places,
}: {
  suggestedNumber: string;
  today: string;
  customers: Choice[];
  drivers: Choice[];
  places: Choice[];
}) {
  const [state, action, pending] = useActionState<NewLoadState, FormData>(createLoadAction, null);
  // After a refusal the form starts again from what was entered: keyed on it, so the defaults apply.
  const d: NewLoadDraft = state?.draft ?? {};
  return (
    <form key={JSON.stringify(d)} action={action} className="grid justify-items-start gap-5">
      <div className="flex flex-wrap gap-3">
        <Field id="new-number" label="Load number">
          {(c) => <Input {...c} name="loadNumber" required maxLength={40} defaultValue={d.loadNumber ?? suggestedNumber} />}
        </Field>
        <Field id="new-customer" label="Customer">
          {(c) => (
            <select {...c} name="customer" className={controlClass} defaultValue={d.customer ?? ""} required>
              <option value="" disabled>
                Pick a customer
              </option>
              {customers.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <StopFields kind="pickup" defaultOn={d.pickupOn ?? today} defaultPlace={d.pickupPlace ?? ""} places={places} />
      <StopFields kind="delivery" defaultOn={d.deliveryOn ?? today} defaultPlace={d.deliveryPlace ?? ""} places={places} />
      <div className="flex flex-wrap gap-3">
        <Field id="new-miles" label="Loaded miles">
          {(c) => <Input {...c} name="miles" inputMode="numeric" required maxLength={4} defaultValue={d.miles} />}
        </Field>
        <Field id="new-rate" label="Rate (dollars)">
          {(c) => <Input {...c} name="rate" inputMode="decimal" required maxLength={10} defaultValue={d.rate} />}
        </Field>
        <Field id="new-fuel" label="Fuel surcharge (dollars, optional)">
          {(c) => <Input {...c} name="fuel" inputMode="decimal" maxLength={10} defaultValue={d.fuel} />}
        </Field>
        <Field id="new-driver" label="Driver">
          {(c) => (
            <select {...c} name="driver" className={controlClass} defaultValue={d.driver ?? ""} required>
              <option value="" disabled>
                Pick a driver
              </option>
              {drivers.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Button type="submit" variant="primary" pending={pending} pendingLabel="Creating">
        Create load
      </Button>
      {state !== null ? (
        <InlineAlert tone="destructive" className="w-full">
          {NEW_LOAD_MESSAGES[state.category]}
        </InlineAlert>
      ) : null}
    </form>
  );
}
