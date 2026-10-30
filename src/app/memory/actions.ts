"use server";

import { revalidatePath } from "next/cache";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { requireStaff } from "@/lib/auth/role";
import { DbError, type Queryable } from "@/lib/db";
import { createNote, deleteNote, keepNote, updateNoteText, type NoteWrite } from "@/lib/memory/notes";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";

// What a note action reports back: done, or one category. The page shows fixed words per category;
// nothing from the database or the server reaches it.
export type NoteActionCategory =
  | "off"
  | "invalid"
  | "subject_not_found"
  | "full"
  | "duplicate"
  | "not_found"
  | "forbidden"
  | "unreadable";

export type NoteActionResult = { ok: true } | { ok: false; category: NoteActionCategory };

// The Memory page's writes: add, edit, keep a suggestion, and remove (or discard). Each one checks
// carrierMemoryEnabled itself before it reads anything, and the store checks it again inside the
// carrier's own transaction, where row security limits every row to this carrier. Any staff or
// admin member of the carrier may manage its notes; a demo visitor (the judge role) is refused
// first inside the transaction and answers "forbidden", writing nothing. Signed out: withRequestTenant redirects to /sign-in, and that
// redirect is rethrown. The arguments come from the browser, so each is checked as unknown.

// A unique violation: the words are already on file for that subject (carrier_notes_one_text), as
// when an edit gives a note the words of another. The transaction has ended; nothing changed.
const UNIQUE_VIOLATION = "23505";

async function run(write: (q: Queryable, session: Session) => Promise<NoteWrite>): Promise<NoteActionResult> {
  try {
    const result = await withRequestTenant(write);
    return result.ok ? { ok: true } : { ok: false, category: result.refusal };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof DbError && err.sqlState === UNIQUE_VIOLATION) return { ok: false, category: "duplicate" };
    if (err instanceof DbError) return { ok: false, category: "unreadable" };
    throw err;
  } finally {
    revalidatePath("/memory");
  }
}

// subject is "carrier", "customer:<id>" or "driver:<id>", as the page's picker writes it.
function subjectOf(subject: unknown): { subjectKind: string; subjectId: string | null } | null {
  if (subject === "carrier") return { subjectKind: "carrier", subjectId: null };
  if (typeof subject !== "string") return null;
  const [kind, id, ...rest] = subject.split(":");
  if (rest.length > 0 || (kind !== "customer" && kind !== "driver") || !isUuid(id)) return null;
  return { subjectKind: kind, subjectId: id };
}

export async function addNoteAction(subject: unknown, text: unknown): Promise<NoteActionResult> {
  if (!flags.carrierMemoryEnabled) return { ok: false, category: "off" };
  const about = subjectOf(subject);
  if (!about || typeof text !== "string") return { ok: false, category: "invalid" };
  return run(async (q, session) => {
    await requireStaff(q, session);
    return createNote(q, session, { ...about, text }, new Date());
  });
}

export async function editNoteAction(id: unknown, text: unknown): Promise<NoteActionResult> {
  if (!flags.carrierMemoryEnabled) return { ok: false, category: "off" };
  if (typeof id !== "string" || !isUuid(id) || typeof text !== "string") return { ok: false, category: "invalid" };
  return run(async (q, session) => {
    await requireStaff(q, session);
    return updateNoteText(q, session, id, text, new Date());
  });
}

export async function keepNoteAction(id: unknown): Promise<NoteActionResult> {
  if (!flags.carrierMemoryEnabled) return { ok: false, category: "off" };
  if (typeof id !== "string" || !isUuid(id)) return { ok: false, category: "invalid" };
  return run(async (q, session) => {
    await requireStaff(q, session);
    return keepNote(q, session, id, new Date());
  });
}

export async function removeNoteAction(id: unknown): Promise<NoteActionResult> {
  if (!flags.carrierMemoryEnabled) return { ok: false, category: "off" };
  if (typeof id !== "string" || !isUuid(id)) return { ok: false, category: "invalid" };
  return run(async (q, session) => {
    await requireStaff(q, session);
    return deleteNote(q, session, id);
  });
}
