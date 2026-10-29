import { parseChecklist } from "../checklist";
import type { TurnEvent } from "../view";

// Server-sent events for one turn (design 2.5). The route encodes; the chat decodes. Event data
// is a step's id, seq, kind, fixed label and state, the turn's id and status, or the answer's
// checklist (short item texts with figures masked like an answer, read back through its schema).
// Never the answer's own text.

export type TurnEmitter = (event: TurnEvent) => void;

const NAMES: ReadonlySet<string> = new Set(["start", "step", "checklist", "done"]);

export function encodeEvent(e: TurnEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

// Splits a buffer into complete events and the unfinished rest. Unknown events and bad data are
// skipped.
export function decodeEvents(buffer: string): { events: TurnEvent[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: TurnEvent[] = [];
  for (const block of blocks) {
    let name = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!NAMES.has(name)) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (name === "checklist") {
        const list = parseChecklist(parsed);
        if (list) events.push({ event: "checklist", data: list });
        continue;
      }
      events.push({ event: name, data: parsed } as TurnEvent);
    } catch {
      // skipped
    }
  }
  return { events, rest };
}
