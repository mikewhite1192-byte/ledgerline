"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { reviewWriteLabel } from "@/lib/invoices/labels";
import { postJson } from "./post-json";

// The two things a person records on an invoice's review. Both write to LedgerLine only: nothing
// here sends an invoice or an email. A second click while one is running does nothing; the server
// writes each fact once, so a repeat says so and changes nothing.

const NOTE_MAX = 240;

function useWrite() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  const inFlight = useRef(false);

  async function write(url: string, body: unknown, done: { changed: string; same: string }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNote("");
    try {
      const reply = await postJson(url, body);
      if (reply.ok && typeof reply.data.changed === "boolean") {
        setNote(reply.data.changed ? done.changed : done.same);
      } else {
        // A success the page cannot read is an outcome not known yet.
        setNote(reviewWriteLabel(reply.ok ? "unknown" : reply.error));
      }
    } finally {
      inFlight.current = false;
      setPending(false);
      router.refresh();
    }
  }
  return { pending, note, setNote, write };
}

// "Mark reviewed", with an optional short note.
export function MarkReviewedForm({ url }: { url: string }) {
  const { pending, note: status, setNote: setStatus, write } = useWrite();
  const [text, setText] = useState("");
  const tooLong = text.trim().length > NOTE_MAX;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (tooLong) return;
    const trimmed = text.trim();
    void write(url, trimmed === "" ? {} : { note: trimmed }, {
      changed: "Marked reviewed.",
      same: "Someone already marked this reviewed.",
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:max-w-md">
      <Field
        id="review-note"
        label="Note (optional)"
        hint="What you checked, in a few words."
        error={tooLong ? `At most ${NOTE_MAX} characters.` : undefined}
      >
        {(p) => (
          <Input
            {...p}
            value={text}
            maxLength={NOTE_MAX + 20}
            onChange={(e) => {
              setStatus("");
              setText(e.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={pending} disabled={tooLong}>
          Mark reviewed
        </Button>
        <p role="status" className="text-small text-foreground-2">
          {status}
        </p>
      </div>
    </form>
  );
}

// "Mark as sent", with the date it went out: on or after the invoice date, never after today. An
// invoice from earlier records (byHand) is never posted from here: the person sends it themselves
// and records the date, so the words say that instead.
export function MarkSentForm({
  url,
  issuedOn,
  today,
  byHand = false,
}: {
  url: string;
  issuedOn: string;
  today: string;
  byHand?: boolean;
}) {
  const { pending, note: status, setNote: setStatus, write } = useWrite();
  const [sentOn, setSentOn] = useState(today);
  const problem =
    sentOn === ""
      ? "Enter the date it was sent."
      : sentOn < issuedOn
        ? "Not before the invoice date."
        : sentOn > today
          ? "Not after today."
          : undefined;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return;
    void write(url, { sentOn }, {
      changed: "Recorded as sent.",
      same: "This was already recorded as sent.",
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:max-w-xs">
      <Field
        id="sent-on"
        label="Date sent"
        hint={
          byHand
            ? "Send it to the customer yourself first. This only records the date here."
            : "Send it from the accounting system first. This only records the date here."
        }
        error={problem}
      >
        {(p) => (
          <Input
            {...p}
            type="date"
            min={issuedOn}
            max={today}
            value={sentOn}
            onChange={(e) => {
              setStatus("");
              setSentOn(e.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={pending} disabled={problem !== undefined}>
          {byHand ? "Record as sent" : "Mark as sent"}
        </Button>
        <p role="status" className="text-small text-foreground-2">
          {status}
        </p>
      </div>
    </form>
  );
}
