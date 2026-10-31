// The card's greeting, by the carrier's name (the only name the app holds for a signed-in person),
// or a plain hello when it has none.
export function greetingLine(name: string | null | undefined): string {
  const n = name?.trim();
  return n ? `Hey, ${n}. How can I be helpful?` : "Hey there. How can I be helpful?";
}

// The product's promise, under the greeting.
export const TRUST_LINE = "Every number comes from your records, and nothing is paid or sent until you approve it.";
