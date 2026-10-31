// The starting rules for a demo carrier (0070 writes the same values for the two invented
// carriers already there; the demo setup writes them for one made later): Auto on the three kinds
// that move no money out of the company, each at or inside its ceiling in flags.autopilot. Every
// other kind has no row, which reads as Ask me.
export const DEFAULT_RULES = [
  { kind: "invoice_post", mode: "auto", maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25 },
  { kind: "card_match", mode: "auto", maxCents: 50_000, dayMaxCents: 300_000, dayMaxCount: 40 },
  { kind: "payment_reapply", mode: "auto", maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25 },
] as const;
