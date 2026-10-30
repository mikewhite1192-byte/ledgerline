import { flags as releaseFlags, type Flags } from "@/config/flags";

export const TEST_MODE_LINE = "Every payout and posting here runs in test mode against a sandbox. Nothing real moves.";

// Whether every payout and posting is test-only, read from the same two values the start-up money
// check refuses production on (src/lib/money/guard.ts): the payout provider is the mock or Stripe
// test mode, and the QuickBooks environment is the sandbox (or unset, which posts nowhere). Any
// other value says false, so the page never claims test mode it cannot show.
export function testModeOnly(
  f: Pick<Flags, "paymentProvider"> = releaseFlags,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const provider: string = f.paymentProvider;
  const payouts = provider === "mock" || provider === "stripe_test";
  const qbo = env.QBO_ENVIRONMENT;
  const books = qbo === undefined || qbo === "" || qbo === "sandbox";
  return payouts && books;
}

// The dark line across the top of every signed-in page while the adapters are test-only. One line
// at laptop width, where it stays put above the top bar; on a phone it wraps and scrolls away.
export function TestModeBanner() {
  return (
    <div
      role="region"
      aria-label="Test mode"
      className="z-40 bg-foreground px-4 py-2 text-center text-small font-medium text-background md:px-6 lg:sticky lg:top-0 lg:flex lg:h-9 lg:items-center lg:justify-center lg:py-0"
    >
      <p className="min-w-0 lg:truncate">{TEST_MODE_LINE}</p>
    </div>
  );
}
