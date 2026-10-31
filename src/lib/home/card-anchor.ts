// Where a card sits in the chat thread, so a link elsewhere on Home ("Needs you") can land on it.
// Its own module because the thread runs in the browser and the strip runs on the server.
export function cardAnchor(proposalId: string): string {
  return `card-${proposalId}`;
}

// A whole "#card-<id>" address hash and nothing else, so a stray hash never scrolls anywhere.
export function isCardAnchor(hash: string): boolean {
  return /^#card-[0-9a-f-]{36}$/.test(hash);
}
