import { stepLabel } from "@/lib/format/labels";
import { countWords, traceLines, type TraceLine } from "./format";
import type { TraceStep, TurnTrace } from "./types";

// The step-through (design-agents-101 3.4): one answer's trace read one model call at a time. Each
// model call is one turn here, in four parts: what it saw (the summary of the carrier's records the
// answer started from, and what the tools it asked for earlier sent back), its own note, what it
// did (the tools it asked for, or the answer), and what came back (each tool's safety check and
// the records it read, a card, the hand-off to the second model, a screening). Pure: it reads the
// stored trace through the same fixed sentences as the list (format.ts) and adds nothing a stored
// row does not hold. Display only: it never pauses or changes a run.

export const NO_NOTE = "No note was returned for this step.";
// A turn from before notes were kept: its note is unknown, not missing.
export const NOTE_NOT_KEPT = "The note for this step was not kept.";

// The summary's own section titles (store/summary.ts, and the notes section's title in
// memory/notes.ts) in the words a person reads. A title this table does not know reads as
// OTHER_PART, never as it was written.
const PART_WORDS: Readonly<Record<string, string>> = {
  Carrier: "Your carrier, its time zone and today's date",
  "Pay rules": "Your pay rules",
  Subject: "Who or what the question is about",
  "Voice note to handle": "The voice note to handle",
  "Earlier in this conversation": "Earlier answers in this conversation",
  "Proposals in this conversation": "Cards in this conversation",
  "Refused tool calls in this conversation": "Requests refused earlier in this conversation",
  "Carrier notes": "Notes from the office",
};

export const OTHER_PART = "Other details";

const has = (map: Readonly<Record<string, string>>, key: string) => Object.prototype.hasOwnProperty.call(map, key);

export type SummaryPart = { title: string; lines: number };
export type SummaryShape = { parts: SummaryPart[]; chars: number };

// The summary's sections and how long each is. The summary is blocks set apart by a blank line,
// each a "Title:" line and then its lines; the opening header and a block cut down to its title
// have no lines and are left out.
export function summaryShape(text: string): SummaryShape {
  const parts: SummaryPart[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const head = lines[0].trim();
    if (!head.endsWith(":")) continue;
    const title = head.slice(0, -1).trim();
    parts.push({ title: has(PART_WORDS, title) ? PART_WORDS[title] : OTHER_PART, lines: lines.length - 1 });
  }
  return { parts, chars: text.length };
}

// One model call and what went with it. model is the call's own row (who, time and cost, and what
// it did in one sentence). before is what was read ahead of the first call (the office's notes, a
// screening), on the first turn only. earlier is what the tools asked for in the turns before this
// one sent back, which this call saw. asked is the tools it asked for, by their step labels, in
// order. got is every row after the call up to the next one.
export type StepTurn = {
  key: string;
  model: TraceLine;
  before: TraceLine[];
  earlier: TraceLine[];
  note: string | null;
  asked: string[];
  answered: boolean;
  got: TraceLine[];
};

export type StepThrough = { summary: SummaryShape | null; summaryText: string | null; turns: StepTurn[] };

// A tool row, as the step-through shows it: the records it read and the size of what it sent back
// join its time and cost.
function toolRow(line: TraceLine, s: TraceStep): TraceLine {
  const meta = [...line.meta];
  if (line.refs.length > 0) meta.push(countWords(line.refs.length, "record", "records"));
  const chars = s.decision?.resultChars;
  if (typeof chars === "number" && Number.isSafeInteger(chars) && chars >= 0) {
    meta.push(`${countWords(chars, "character", "characters")} back`);
  }
  return { ...line, meta };
}

// The whole answer's trace, one turn per model call, in order. A trace with no model call has no
// turns, so it has nothing to step through.
export function turnsOf(trace: TurnTrace): StepThrough {
  const bySeq = new Map<string, TraceStep>(trace.steps.map((s) => [`step:${s.seq}`, s]));
  const turns: StepTurn[] = [];
  const before: TraceLine[] = [];
  const toolRows: TraceLine[] = [];
  for (const line of traceLines(trace)) {
    const s = bySeq.get(line.key);
    if (s?.kind === "model") {
      turns.push({
        key: `turn:${s.seq}`,
        model: line,
        before: turns.length === 0 ? before.splice(0) : [],
        earlier: [...toolRows],
        note: typeof s.reasoningNote === "string" && s.reasoningNote.trim() !== "" ? s.reasoningNote : null,
        asked: [],
        answered: s.state === "done" && (s.toolCalls ?? 0) === 0,
        got: [],
      });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) {
      before.push(line);
      continue;
    }
    if (s?.kind === "tool") {
      const row = toolRow(line, s);
      turn.asked.push(stepLabel(s.label));
      turn.got.push(row);
      toolRows.push(row);
    } else {
      turn.got.push(line);
    }
  }
  const text = typeof trace.contextSummary === "string" && trace.contextSummary.trim() !== "" ? trace.contextSummary : null;
  return { summary: text === null ? null : summaryShape(text), summaryText: text, turns };
}
