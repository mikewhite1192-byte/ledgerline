// Where a card sits in the chat thread, so a link elsewhere on Home ("Needs you") can land on it.
// Its own module because the thread runs in the browser and the strip runs on the server.
export function cardAnchor(proposalId: string): string {
  return `card-${proposalId}`;
}

// Where a turn sits in the chat thread, for the "Needs you" row of requests escalated to a person.
export function turnAnchor(turnId: string): string {
  return `turn-${turnId}`;
}
