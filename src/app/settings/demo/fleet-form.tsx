"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { moveFleetAction, type FleetCategory, type FleetState } from "./fleet-action";

// A fixed message per category; nothing from the database is shown.
export const FLEET_MESSAGES: Record<FleetCategory, string> = {
  disabled: "Moving the fleet is switched off. Nothing was changed.",
  forbidden: "Only staff of this carrier can move the fleet. Nothing was changed.",
  not_demo: "This carrier is not a demo carrier. Nothing was changed.",
  unreadable: "Could not reach the database. Nothing was changed. Try again in a moment.",
  unknown:
    "The database did not confirm the moves, so they may have gone through. Check the load statuses before pressing again.",
  failed: "The move failed a check and was undone. Nothing was changed.",
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function MoveFleetForm() {
  const [state, action, pending] = useActionState<FleetState, FormData>(moveFleetAction, null);
  return (
    <form action={action} className="grid justify-items-start gap-3">
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Moving the fleet">
        Move the fleet
      </Button>
      {state?.ok ? (
        <InlineAlert tone="success" className="w-full">
          {state.pickedUp + state.delivered === 0
            ? "No load was due to move."
            : `${plural(state.pickedUp, "load")} picked up, ${plural(state.delivered, "load")} delivered.`}
        </InlineAlert>
      ) : state ? (
        <InlineAlert tone="destructive" className="w-full">
          {FLEET_MESSAGES[state.category]}
        </InlineAlert>
      ) : null}
    </form>
  );
}
