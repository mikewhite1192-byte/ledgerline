import type { TurnEvent } from "../view";

// Server-sent events for one turn (design 2.5). The route encodes; the chat decodes. Event data
// is a step's id, seq, kind, fixed label and state, or the turn's id and status: never model text.

export type TurnEmitter = (event: TurnEvent) => void;

const NAMES: ReadonlySet<string> = new Set(["start", "step", "done"]);

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
      events.push({ event: name, data: JSON.parse(data) } as TurnEvent);
    } catch {
      // skipped
    }
  }
  return { events, rest };
}
