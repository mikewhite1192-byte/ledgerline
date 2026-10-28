// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/app/toast";
import type { NoteRow, NoteSubject } from "@/lib/memory/notes";
import { NotesBoard } from "./notes-board";

// The Memory page's board: one main button, plain words, the empty state that says what to do,
// suggestions that wait for a person's Keep, and a remove that asks first.

const actions = vi.hoisted(() => ({
  addNoteAction: vi.fn(),
  editNoteAction: vi.fn(),
  keepNoteAction: vi.fn(),
  removeNoteAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const DRIVER = "44444444-4444-4444-8444-444444444444";

function note(id: string, over: Partial<NoteRow> = {}): NoteRow {
  return {
    id,
    subjectKind: "customer",
    subjectId: CUSTOMER,
    subjectName: "Harbor Foods",
    subjectCode: "BR-C03",
    text: "Pays about 45 days after due; send reminders early",
    status: "active",
    sourceKind: "seed",
    sourceTurnId: null,
    createdByKind: "seed",
    createdByEmail: null,
    createdAt: "2026-10-20T17:00:00.000Z",
    updatedAt: "2026-10-20T17:00:00.000Z",
    ...over,
  };
}

const SUBJECTS: NoteSubject[] = [
  { kind: "customer", id: CUSTOMER, name: "Harbor Foods", code: "BR-C03" },
  { kind: "driver", id: DRIVER, name: "Monique Vasquez", code: "BR-D07" },
];

const ACTIVE = note("33333333-3333-4333-8333-000000000001");
const WIDE = note("33333333-3333-4333-8333-000000000002", {
  subjectKind: "carrier",
  subjectId: null,
  subjectName: null,
  subjectCode: null,
  text: "Owner wants every detention charge billed the same week",
  createdByKind: "person",
  createdByEmail: "desk@example.test",
});
const SUGGESTED = note("33333333-3333-4333-8333-000000000003", {
  subjectKind: "driver",
  subjectId: DRIVER,
  subjectName: "Monique Vasquez",
  subjectCode: "BR-D07",
  text: "Prefers texts in Spanish",
  status: "suggested",
  sourceKind: "chat",
  createdByKind: "agent",
});

function board(notes: NoteRow[], maxNotes = 500) {
  return render(
    <ToastProvider>
      <NotesBoard notes={notes} subjects={SUBJECTS} timeZone="America/Chicago" maxChars={300} maxNotes={maxNotes} />
    </ToastProvider>,
  );
}

const filled = () => document.querySelectorAll("button.bg-primary");
const BANNED = /\b(tenant|prompt|token|trace id|proposal|ledger|auditor|gateway)\b/i;

describe("NotesBoard", () => {
  it("says what to do when there are no notes, with one main button", () => {
    board([]);
    expect(screen.getByText("No notes yet")).toBeTruthy();
    expect(screen.getByText(/Add one about a customer, a driver or the whole carrier/)).toBeTruthy();
    expect(filled()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
  });

  it("lists each note with who or what it is about, who added it and when, in plain words", () => {
    board([ACTIVE, WIDE, SUGGESTED]);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(table).getByRole("link", { name: "Harbor Foods" }).getAttribute("href")).toBe(`/records/customers/${CUSTOMER}`);
    expect(within(table).getByText("Whole carrier")).toBeTruthy();
    expect(within(table).getByText("Sample")).toBeTruthy();
    expect(within(table).getByText("desk@example.test")).toBeTruthy();
    expect(within(table).getAllByText("Oct 20, 2026, 12:00 PM CDT")).toHaveLength(2);
    expect(document.getElementById(`note-${ACTIVE.id}`)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(BANNED);
    expect(filled()).toHaveLength(1);
  });

  it("shows the agent's suggestions apart, waiting for a person's Keep", async () => {
    actions.keepNoteAction.mockResolvedValue({ ok: true });
    board([ACTIVE, SUGGESTED]);
    expect(screen.getByRole("heading", { name: "The agent suggested 1 note" })).toBeTruthy();
    expect(within(screen.getByRole("table")).queryByText("Prefers texts in Spanish")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep the note about Monique Vasquez" }));
    });
    expect(actions.keepNoteAction).toHaveBeenCalledWith(SUGGESTED.id);
    expect(filled()).toHaveLength(1);
  });

  it("asks before removing a note, and removes only on confirm", async () => {
    actions.removeNoteAction.mockResolvedValue({ ok: true });
    board([ACTIVE]);
    fireEvent.click(screen.getByRole("button", { name: "Remove the note about Harbor Foods" }));
    const panel = screen.getByRole("group", { name: "Remove this note?" });
    expect(within(panel).getByText("The agent stops seeing it on the next question.")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Keep reviewing" }));
    expect(screen.queryByRole("group", { name: "Remove this note?" })).toBeNull();
    expect(actions.removeNoteAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove the note about Harbor Foods" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("group", { name: "Remove this note?" })).getByRole("button", { name: "Remove" }));
    });
    expect(actions.removeNoteAction).toHaveBeenCalledWith(ACTIVE.id);
  });

  it("adds a note about the subject picked, keeping one main button on screen", async () => {
    actions.addNoteAction.mockResolvedValue({ ok: true });
    board([]);
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    expect(screen.queryByRole("button", { name: "Add a note" })).toBeNull();
    expect(filled()).toHaveLength(1);
    expect(screen.getByText("Do not put card or bank numbers in a note.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("About"), { target: { value: `driver:${DRIVER}` } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Asks for advances on Thursdays" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    });
    expect(actions.addNoteAction).toHaveBeenCalledWith(`driver:${DRIVER}`, "Asks for advances on Thursdays");
  });

  it("shows fixed words for a refusal, never the server's text", async () => {
    actions.addNoteAction.mockResolvedValue({ ok: false, category: "invalid" });
    board([]);
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "See the site" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    });
    expect(screen.getByText("A note is 1 to 300 characters of plain words, with no web address. Nothing was saved.")).toBeTruthy();
  });

  it("asks for words before sending an empty note", () => {
    board([]);
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(screen.getByText("Write the note first.")).toBeTruthy();
    expect(actions.addNoteAction).not.toHaveBeenCalled();
  });

  it("says to remove a note first when the carrier keeps the most it can", () => {
    board([ACTIVE, WIDE], 2);
    expect(screen.getByText("Remove a note first")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add a note" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
