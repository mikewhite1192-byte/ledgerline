// The starting rules for a demo carrier (0070 and 0074 write the same limits for the two invented
// carriers already there; the demo setup writes them for one made later): Auto on the two kinds
// that move no money out of the company and that the autopilot can check, each at or inside its
// ceiling in flags.autopilot, Ask me on a card match (the autopilot cannot check one, so Auto is
// not offered there; 0070 wrote it as Auto), and Auto on the two kinds that pay a driver, with a
// limit for one driver's day too. A money kind is still approved by nobody until its own armed is
// on in flags.autopilot.kinds. Every other kind has no row, which reads as Ask me.
export const DEFAULT_RULES = [
  { kind: "invoice_post", mode: "auto", maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, driverDayMaxCents: null },
  { kind: "card_match", mode: "ask", maxCents: 50_000, dayMaxCents: 300_000, dayMaxCount: 40, driverDayMaxCents: null },
  { kind: "payment_reapply", mode: "auto", maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, driverDayMaxCents: null },
  { kind: "advance_payout", mode: "auto", maxCents: 30_000, dayMaxCents: 150_000, dayMaxCount: 10, driverDayMaxCents: 30_000 },
  { kind: "money_code", mode: "auto", maxCents: 15_000, dayMaxCents: 60_000, dayMaxCount: 4, driverDayMaxCents: 30_000 },
] as const;
