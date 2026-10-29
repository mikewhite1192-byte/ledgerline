// Where a note lives on the Memory page: each row carries this anchor, so a trace line can link
// straight to the note it names. Pure, so the browser's trace view can use it.
export function noteAnchor(id: string): string {
  return `note-${id}`;
}

export function noteHref(id: string): string {
  return `/memory#${noteAnchor(encodeURIComponent(id))}`;
}

// The table name a trace ref carries for a note. Not a record table: it links to Memory, never to
// /records.
export const NOTE_REF_TABLE = "carrier_notes";

// A Unicode format character (a zero-width space or joiner, a direction override, a tag character
// and the like): invisible on a page, and able to hide words from the pattern pre-screen. A note
// with one is never written, and one already stored never reaches a model. Pure, so the Memory
// page can say so beside the note.
const FORMAT_CHARACTER = /\p{Cf}/u;

export function hasHiddenCharacter(text: string): boolean {
  return FORMAT_CHARACTER.test(text);
}
