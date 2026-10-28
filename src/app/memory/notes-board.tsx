"use client";

import { Brain } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { DataTable, type Column } from "@/components/app/data-table";
import { useToast } from "@/components/app/toast";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { cn } from "@/lib/cn";
import { formatInstant } from "@/lib/format/dates";
import { noteAnchor } from "@/lib/memory/links";
import type { NoteRow, NoteSubject } from "@/lib/memory/notes";
import { recordHref } from "@/lib/records/href";
import {
  addNoteAction,
  editNoteAction,
  keepNoteAction,
  removeNoteAction,
  type NoteActionCategory,
  type NoteActionResult,
} from "./actions";

// Fixed words per category; nothing from the server is shown as it is.
const MESSAGES: Record<NoteActionCategory | "unknown", string> = {
  off: "Memory is switched off for this carrier. Nothing was saved.",
  invalid: "A note is 1 to 300 characters of plain words, with no web address. Nothing was saved.",
  subject_not_found: "That customer or driver is not on file for this carrier. Pick another and try again.",
  full: "This carrier keeps the most notes it can. Remove a note first.",
  duplicate: "That note is already on file, word for word, for the same customer, driver or carrier. Nothing new was saved.",
  not_found: "That note is not here anymore. Someone may have changed it. Reload the page.",
  forbidden: "This login cannot change notes for this carrier.",
  unreadable: "Could not reach your records. Nothing was lost or sent. Try again in a moment.",
  unknown: "Something failed and the cause is not known. Nothing was lost or sent. Try again in a moment.",
};

function messageOf(result: NoteActionResult | null): string | null {
  if (result === null) return MESSAGES.unknown;
  return result.ok ? null : MESSAGES[result.category];
}

// A server action that fails in transit (the network, a deploy) reads as unknown, never as done.
async function settle(call: Promise<NoteActionResult>): Promise<NoteActionResult | null> {
  try {
    return await call;
  } catch {
    return null;
  }
}

// Who or what a note is about, as words, linking to the record page when the record exists.
function About({ note }: { note: NoteRow }) {
  if (note.subjectKind === "carrier") return <span className="text-foreground-2">Whole carrier</span>;
  if (note.subjectId === null || note.subjectName === null) {
    return <span className="text-muted-foreground">No longer on file</span>;
  }
  const table = note.subjectKind === "customer" ? "customers" : "drivers";
  return (
    <Link
      href={recordHref({ table, id: note.subjectId })}
      className="text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
    >
      {note.subjectName}
    </Link>
  );
}

function aboutWords(note: NoteRow): string {
  if (note.subjectKind === "carrier") return "the whole carrier";
  return note.subjectName ?? "someone no longer on file";
}

function addedBy(note: NoteRow): string {
  if (note.createdByKind === "seed") return "Sample";
  if (note.createdByKind === "agent") return "The agent";
  return note.createdByEmail ?? "A past member";
}

function addedAt(iso: string, timeZone: string): string {
  try {
    return formatInstant(iso, timeZone);
  } catch {
    return "Date not known";
  }
}

const CARD_OR_BANK = "Do not put card or bank numbers in a note.";

export function NotesBoard({
  notes,
  subjects,
  timeZone,
  maxChars,
  maxNotes,
}: {
  notes: NoteRow[];
  subjects: NoteSubject[];
  timeZone: string;
  maxChars: number;
  maxNotes: number;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [subject, setSubject] = useState("carrier");
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<NoteRow | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const suggested = notes.filter((n) => n.status === "suggested");
  const active = notes.filter((n) => n.status === "active");
  const full = notes.length >= maxNotes;
  const customers = subjects.filter((s) => s.kind === "customer");
  const drivers = subjects.filter((s) => s.kind === "driver");

  const add = () => {
    if (draft.trim() === "") {
      setAddError("Write the note first.");
      return;
    }
    setAddError(null);
    startTransition(async () => {
      const result = await settle(addNoteAction(subject, draft));
      const error = messageOf(result);
      if (error) {
        setAddError(error);
        return;
      }
      setAdding(false);
      setDraft("");
      setSubject("carrier");
      toast({ title: "Note added", body: "The agent sees it from the next question.", tone: "success" });
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    if (editing.text.trim() === "") {
      setEditError("Write the note first, or remove it.");
      return;
    }
    setEditError(null);
    const { id, text } = editing;
    startTransition(async () => {
      const error = messageOf(await settle(editNoteAction(id, text)));
      if (error) {
        setEditError(error);
        return;
      }
      setEditing(null);
      toast({ title: "Note saved", tone: "success" });
    });
  };

  const keep = (note: NoteRow) => {
    setRowError(null);
    startTransition(async () => {
      const error = messageOf(await settle(keepNoteAction(note.id)));
      if (error) setRowError(error);
      else toast({ title: "Note kept", body: "The agent sees it from the next question.", tone: "success" });
    });
  };

  const remove = (note: NoteRow, after: { title: string; body?: string }) => {
    setRowError(null);
    startTransition(async () => {
      const error = messageOf(await settle(removeNoteAction(note.id)));
      if (error) {
        setRowError(error);
        return;
      }
      setRemoving(null);
      toast({ ...after, tone: "success" });
    });
  };

  const columns: Column<NoteRow>[] = [
    {
      key: "note",
      header: "Note",
      wrap: true,
      cell: (note) =>
        editing?.id === note.id ? (
          <div className="grid min-w-[16rem] gap-2">
            <Field
              id={`edit-${note.id}`}
              label={<VisuallyHidden>Note about {aboutWords(note)}</VisuallyHidden>}
              hint={`${editing.text.length} of ${maxChars} characters. ${CARD_OR_BANK}`}
              error={editError ?? undefined}
            >
              {(control) => (
                <Textarea
                  {...control}
                  value={editing.text}
                  maxLength={maxChars}
                  disabled={pending}
                  onChange={(e) => setEditing({ id: note.id, text: e.target.value })}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" pending={pending} pendingLabel="Saving" onClick={saveEdit}>
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setEditing(null);
                  setEditError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <span className="text-foreground">{note.text}</span>
        ),
    },
    { key: "about", header: "About", cell: (note) => <About note={note} /> },
    { key: "by", header: "Added by", cell: (note) => <span className="text-foreground-2">{addedBy(note)}</span> },
    {
      key: "added",
      header: "Added",
      cell: (note) => <span className="text-foreground-2 tabular-nums">{addedAt(note.createdAt, timeZone)}</span>,
    },
    {
      key: "actions",
      header: <VisuallyHidden>Change</VisuallyHidden>,
      align: "right",
      cell: (note) =>
        editing?.id === note.id ? null : (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              aria-label={`Edit the note about ${aboutWords(note)}`}
              onClick={() => {
                setEditing({ id: note.id, text: note.text });
                setEditError(null);
                setRemoving(null);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              aria-label={`Remove the note about ${aboutWords(note)}`}
              onClick={() => {
                setRemoving(note);
                setRowError(null);
              }}
            >
              Remove
            </Button>
          </div>
        ),
    },
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[60ch] text-small text-foreground-2">
          On each question the agent reads the notes about the customers and drivers in that chat, plus
          the three newest notes about the whole carrier.
        </p>
        {adding ? null : (
          <Button disabled={full} onClick={() => setAdding(true)}>
            Add a note
          </Button>
        )}
      </div>

      {full ? (
        <InlineAlert tone="warning" title="Remove a note first">
          This carrier keeps {maxNotes.toLocaleString("en-US")} notes, the most it can.
        </InlineAlert>
      ) : null}

      {adding ? (
        <Card>
          <CardHeader className="grid gap-1">
            <h2 className="text-h3 text-foreground">Add a note</h2>
            <CardDescription>{CARD_OR_BANK}</CardDescription>
          </CardHeader>
          <CardBody className="grid gap-4">
            <Field id="note-subject" label="About">
              {(control) => (
                <select
                  {...control}
                  value={subject}
                  disabled={pending}
                  onChange={(e) => setSubject(e.target.value)}
                  className={cn(controlClass, "h-9")}
                >
                  <option value="carrier">The whole carrier</option>
                  {customers.length > 0 ? (
                    <optgroup label="Customers">
                      {customers.map((c) => (
                        <option key={c.id} value={`customer:${c.id}`}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {drivers.length > 0 ? (
                    <optgroup label="Drivers">
                      {drivers.map((d) => (
                        <option key={d.id} value={`driver:${d.id}`}>
                          {d.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              )}
            </Field>
            <Field
              id="note-text"
              label="Note"
              hint={`${draft.length} of ${maxChars} characters. One line of plain words, like "Pays about 45 days after due".`}
              error={addError ?? undefined}
            >
              {(control) => (
                <Textarea
                  {...control}
                  value={draft}
                  maxLength={maxChars}
                  disabled={pending}
                  onChange={(e) => setDraft(e.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setAdding(false);
                  setAddError(null);
                }}
              >
                Cancel
              </Button>
              <Button pending={pending} pendingLabel="Saving" onClick={add}>
                Save note
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {suggested.length > 0 ? (
        <section aria-labelledby="suggested-title" className="grid gap-3">
          <div className="grid gap-1">
            <h2 id="suggested-title" className="text-h3 text-foreground">
              The agent suggested {suggested.length === 1 ? "1 note" : `${suggested.length.toLocaleString("en-US")} notes`}
            </h2>
            <p className="text-small text-foreground-2">
              The agent reads a suggestion only after someone keeps it.
            </p>
          </div>
          <ul className="grid gap-3">
            {suggested.map((note) => (
              <li key={note.id} id={noteAnchor(note.id)} className="scroll-mt-20">
                <Card>
                  <CardBody className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="grid min-w-0 gap-1">
                      <p className="text-body text-foreground">{note.text}</p>
                      <p className="text-small text-foreground-2">
                        About <About note={note} />. From the chat on {addedAt(note.createdAt, timeZone)}.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        aria-label={`Keep the note about ${aboutWords(note)}`}
                        onClick={() => keep(note)}
                      >
                        Keep
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label={`Discard the note about ${aboutWords(note)}`}
                        onClick={() => remove(note, { title: "Suggestion discarded" })}
                      >
                        Discard
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rowError ? (
        <p role="alert" className="text-small text-destructive">
          {rowError}
        </p>
      ) : null}

      {removing ? (
        <ConfirmPanel
          question="Remove this note?"
          summary={`About ${aboutWords(removing)}: "${removing.text}"`}
          next="The agent stops seeing it on the next question."
          confirmLabel="Remove"
          tone="destructive"
          pending={pending}
          pendingLabel="Removing"
          onConfirm={() => remove(removing, { title: "Note removed" })}
          onCancel={() => setRemoving(null)}
        />
      ) : null}

      <DataTable
        caption="Notes the agent reads"
        columns={columns}
        rows={active}
        rowKey={(note) => note.id}
        rowId={(note) => noteAnchor(note.id)}
        empty={{
          icon: <Brain aria-hidden />,
          title: "No notes yet",
          body: "Add one about a customer, a driver or the whole carrier, and the agent reads it from the next question.",
        }}
      />
    </div>
  );
}
