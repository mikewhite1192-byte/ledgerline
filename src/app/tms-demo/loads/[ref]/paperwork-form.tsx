"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import type { MoveReason } from "@/lib/loads/movement";
import type { BoardResult } from "@/lib/mock-tms/paperwork";
import { sendPaperworkAction, type PaperworkCategory, type PaperworkState } from "../../actions";

// D-098: the driver's phone. One button by LedgerLine's own load status; the line after a tap is
// built here from fixed parts, never from server text.

export const PAPERWORK_MESSAGES: Record<PaperworkCategory, string> = {
  disabled: "The driver's phone is switched off. Nothing was sent.",
  not_started: "The driver's phone starts on a later date. Nothing was sent.",
  not_demo: "This carrier is not a demo carrier. Nothing was sent.",
  not_found: "LedgerLine has no load with this number. Nothing was sent.",
  wrong_stage: "This load moved since the page loaded. Reload the page to see what the driver can send.",
  not_due: "This load's pickup date is still ahead, so its paperwork would not count yet. Nothing was sent.",
  too_soon: "The driver only just got there. Try again in a few minutes. Nothing was sent.",
  cap: "The driver's phone has sent today's limit of paperwork for this carrier. Try again tomorrow.",
  visit_ended: "This demo visit has ended. Sign in again to keep going.",
  visit_used: "This demo visit has used all its turns. Nothing was sent.",
  limit: "LedgerLine has taken today's limit of documents for this carrier. Nothing was read.",
  not_read: "The paperwork was sent, but its read did not finish. Nothing moved. Try again in a moment.",
  not_matched: "The paperwork was read but did not match this load, so nothing moved. It is kept under Documents.",
  moves_off: "The paperwork was read, but moving loads on paperwork is switched off. Nothing moved.",
  not_moved: "The paperwork was read, but it did not move this load. Nothing else changed.",
  bad_request: "That tap was not understood. Nothing was sent.",
  forbidden: "Only a member of this carrier can send its paperwork. Nothing was sent.",
  unreadable: "Could not reach the database. Nothing was sent. Try again in a moment.",
  unknown: "The paperwork did not confirm, so it may have gone through. Reload the page before trying again.",
  failed: "The paperwork failed a check and was undone. Nothing moved.",
};

const REASON_WORDS: Record<MoveReason, string> = {
  no_load_number: "no load number on it",
  ambiguous_load: "more than one load could match",
  wrong_driver: "a different driver",
  unclear_update: "the update was unclear",
  wrong_status: "the load's status does not allow it",
  date_out_of_window: "its date is outside the load's window",
  no_driver: "no driver on the load",
  no_pickup_paper: "no pickup paperwork yet",
  field_differs: "a field on it differs from the load",
  no_date: "no date on it",
  low_confidence: "part of it was hard to read",
  stop_unclear: "the stop times were unclear",
  tms_withdrawn: "the dispatch system withdrew the load",
  tms_gone: "the load is gone from the dispatch system",
  tms_time_unclear: "the dispatch system's times disagree",
};

const BOARD_WORDS: Record<Exclude<BoardResult, "moved">, string> = {
  off: "its switch is off",
  not_found: "this load is not on the sample system",
  cap: "the load's history is full",
  no_open_stop: "that stop was already completed there",
  pickup_first: "its pickup is still open there",
  before_pickup: "its pickup there left later than this stop",
  bad_time: "the times are more than seven days back",
  no_pod: "no proof of delivery on file",
  unknown_driver: "not a stop change",
  same_driver: "not a stop change",
  no_driver: "no driver on the load",
  bad_status: "not a stop change",
  same_status: "the load already had that status",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// A local clock ("2026-11-03T08:05") as ["Nov 3", "8:05 AM"], or null when it is not one.
export function clockParts(local: string): [string, string] | null {
  const m = CLOCK.exec(local);
  if (!m) return null;
  const month = Number(m[2]);
  const h = Number(m[4]);
  if (month < 1 || month > 12 || h > 23) return null;
  return [`${MONTHS[month - 1]} ${Number(m[3])}`, `${h % 12 === 0 ? 12 : h % 12}:${m[5]} ${h < 12 ? "AM" : "PM"}`];
}

const STATUS_WORDS = { in_transit: "In Transit", delivered: "Delivered" } as const;

export function paperworkLine(state: Exclude<PaperworkState, null>): { tone: "success" | "warning" | "destructive"; text: string } {
  if (state.kind === "refused") return { tone: "destructive", text: PAPERWORK_MESSAGES[state.category] };
  if (state.kind === "already") {
    return { tone: "success", text: `Read the paperwork for ${state.loadNumber}: LedgerLine already had this load moved. Nothing changed.` };
  }
  if (state.kind === "card") {
    return {
      tone: "warning",
      text: `Read the paperwork for ${state.loadNumber} but could not move it on my own (${REASON_WORDS[state.reason] ?? "a check did not pass"}). A card waits for a person in LedgerLine.`,
    };
  }
  const who = state.driverFirstName ? `${state.driverFirstName}'s` : "the driver's";
  const paper = state.stage === "pickup" ? "signed bill of lading" : "signed proof of delivery";
  const parts = clockParts(state.atLocal);
  const when = parts ? ` ${parts[0]} at ${parts[1]}` : "";
  const did = state.stage === "pickup" ? `picked up${when}` : `delivered${when}`;
  const status = STATUS_WORDS[state.to];
  const marked =
    state.board === "moved"
      ? `Marked ${status} in LedgerLine and on the dispatch board.`
      : `Marked ${status} in LedgerLine; the dispatch board did not take the change (${BOARD_WORDS[state.board] ?? "a check did not pass"}).`;
  const invoice = state.to === "delivered" ? " The invoice is ready in the invoice queue." : "";
  return { tone: state.board === "moved" ? "success" : "warning", text: `Read ${who} ${paper} for ${state.loadNumber}: ${did}. ${marked}${invoice}` };
}

const DONE_WORDS: Record<string, string> = { delivered: "delivered", invoiced: "invoiced", cancelled: "cancelled" };

export function DriverPaperworkCard({ reference, status }: { reference: string; status: string }) {
  const [state, action, pending] = useActionState<PaperworkState, FormData>(sendPaperworkAction, null);
  const stage = status === "planned" ? "pickup" : status === "in_transit" ? "delivery" : null;
  const line = state === null ? null : paperworkLine(state);
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Driver&apos;s phone</CardTitle>
          <CardDescription>
            {stage === "pickup"
              ? "The driver's signed bill of lading goes to LedgerLine, as the driver app would send it. The coworker reads it and moves the load."
              : stage === "delivery"
                ? "The driver's signed proof of delivery goes to LedgerLine, as the driver app would send it. The coworker reads it and moves the load."
                : `Nothing to send: this load is already ${DONE_WORDS[status] ?? "closed"} in LedgerLine.`}
          </CardDescription>
        </div>
      </CardHeader>
      <CardBody className="grid justify-items-start gap-3">
        {stage !== null ? (
          <form action={action} className="grid justify-items-start gap-3">
            <input type="hidden" name="reference" value={reference} />
            <input type="hidden" name="stage" value={stage} />
            <Button type="submit" pending={pending} pendingLabel="Reading the driver's paperwork">
              {stage === "pickup" ? "Driver sends pickup paperwork" : "Driver sends delivery paperwork"}
            </Button>
          </form>
        ) : null}
        {line !== null ? (
          <InlineAlert tone={line.tone} className="w-full">
            {line.text}
          </InlineAlert>
        ) : null}
      </CardBody>
    </Card>
  );
}
