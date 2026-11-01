"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input, controlClass } from "@/components/ui/input";
import type { HookResult } from "@/lib/mock-tms/hook";
import {
  assignDriverAction,
  completeDeliveryAction,
  completePickupAction,
  setStatusAction,
  type MockActionCategory,
  type MockActionState,
} from "../../actions";

// A fixed message per category; nothing the server says is shown.
export const MOCK_MESSAGES: Record<MockActionCategory, string> = {
  disabled: "The sample dispatch system is switched off. Nothing was changed.",
  forbidden: "Only a member of this carrier can change its loads. Nothing was changed.",
  not_demo: "This carrier is not a demo carrier. Nothing was changed.",
  bad_request: "That change was not understood. Nothing was changed.",
  unreadable: "Could not reach the database. Nothing was changed. Try again in a moment.",
  unknown: "The change did not confirm, so it may have gone through. Reload the page before trying again.",
  failed: "The change failed a check and was undone. Nothing was changed.",
  not_found: "This load is not in the sample dispatch system. Nothing was changed.",
  cap: "This load has reached its history limit. Nothing was changed.",
  unknown_driver: "Pick a driver from the list. Nothing was changed.",
  same_driver: "That driver is already on this load. Nothing was changed.",
  no_driver: "Booked needs a driver on the load. Assign one first.",
  no_pod: "Delivered needs a proof of delivery on file. Complete the delivery instead.",
  no_open_stop: "That stop is already completed. Nothing was changed.",
  pickup_first: "Complete the pickup before the delivery. Nothing was changed.",
  bad_time: "Arrival must be at or before departure, departure no later than now, and neither more than seven days back.",
  bad_status: "Pick a status from the list. Nothing was changed.",
  same_status: "The load already has that status. Nothing was changed.",
};

export const HOOK_WORDS: Record<string, string> = {
  sent: "LedgerLine was told about the change.",
  hook_off: "The webhook is switched off; LedgerLine finds the change on its next read.",
  not_configured: "The webhook is not set up here; LedgerLine finds the change on its next read.",
  timeout: "The webhook did not answer in time; LedgerLine finds the change on its next read.",
  unreachable: "The webhook could not be reached; LedgerLine finds the change on its next read.",
};

export function hookWords(result: HookResult | string): string {
  return HOOK_WORDS[result] ?? "The webhook refused the call; LedgerLine finds the change on its next read.";
}

function Outcome({ state }: { state: MockActionState }) {
  if (state === null) return null;
  if (state.ok) {
    return (
      <InlineAlert tone="success" className="w-full">
        {`Saved. ${hookWords(state.hook)}`}
      </InlineAlert>
    );
  }
  return (
    <InlineAlert tone="destructive" className="w-full">
      {MOCK_MESSAGES[state.category]}
    </InlineAlert>
  );
}

type Choice = { value: string; label: string };

export function AssignDriverForm({ reference, drivers }: { reference: string; drivers: Choice[] }) {
  const [state, action, pending] = useActionState<MockActionState, FormData>(assignDriverAction, null);
  return (
    <form action={action} className="grid justify-items-start gap-3">
      <input type="hidden" name="reference" value={reference} />
      <Field id="assign-driver" label="Driver">
        {(c) => (
          <select {...c} name="driver" className={controlClass} defaultValue="">
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
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Assigning">
        Assign driver
      </Button>
      <Outcome state={state} />
    </form>
  );
}

export function CompleteStopForm({ reference, kind, defaultLocal }: { reference: string; kind: "pickup" | "delivery"; defaultLocal: string }) {
  const [state, action, pending] = useActionState<MockActionState, FormData>(
    kind === "pickup" ? completePickupAction : completeDeliveryAction,
    null,
  );
  const word = kind === "pickup" ? "pickup" : "delivery";
  return (
    <form action={action} className="grid justify-items-start gap-3">
      <input type="hidden" name="reference" value={reference} />
      <div className="flex flex-wrap gap-3">
        <Field id={`${word}-arrived`} label="Arrived (carrier's local time)">
          {(c) => <Input {...c} type="datetime-local" name="arrived" defaultValue={defaultLocal} />}
        </Field>
        <Field id={`${word}-departed`} label="Departed (carrier's local time)">
          {(c) => <Input {...c} type="datetime-local" name="departed" defaultValue={defaultLocal} />}
        </Field>
      </div>
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Completing">
        {kind === "pickup" ? "Complete pickup" : "Complete delivery"}
      </Button>
      <Outcome state={state} />
    </form>
  );
}

export function SetStatusForm({ reference, current, choices }: { reference: string; current: string; choices: Choice[] }) {
  const [state, action, pending] = useActionState<MockActionState, FormData>(setStatusAction, null);
  return (
    <form action={action} className="grid justify-items-start gap-3">
      <input type="hidden" name="reference" value={reference} />
      <Field id="set-status" label="Status">
        {(c) => (
          <select {...c} name="status" className={controlClass} defaultValue={choices.find((x) => x.label === current)?.value ?? ""}>
            {choices.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving">
        Set status
      </Button>
      <Outcome state={state} />
    </form>
  );
}
