import { StatCard } from "@/components/app/stat-card";
import { cn } from "@/lib/cn";
import { dayWords, dollars } from "@/lib/cash/explain";
import type { CashHome } from "@/lib/cash/view";

export const OUT_OF_DATE = "Out of date, check again";

// "Friday's pay run: Short by $6,800.00", one click from the Cash page. A check whose pay day is
// before the carrier's today (both carrier-local dates) is out of date: its answer was for a past
// Friday, so the card says so and points to the Cash page instead of repeating it.
export function FridayPay({ home, today, className }: { home: CashHome | null; today: string; className?: string }) {
  const outOfDate = home !== null && home.payDay < today;
  const short = home !== null && !outOfDate && home.gapCents < 0;
  return (
    <section aria-label="Friday's pay run" className={cn("mx-auto mt-12 w-full max-w-[720px]", className)}>
      <StatCard
        label="Friday's pay run"
        value={
          home === null
            ? "Not checked yet"
            : outOfDate
              ? OUT_OF_DATE
              : short
                ? `Short by ${dollars(home.gapCents)}`
                : "Covered"
        }
        hint={
          home === null
            ? "Check it on Friday's cash"
            : outOfDate
              ? `The last check was for ${dayWords(home.payDay)}. Check it on Friday's cash`
              : `For ${dayWords(home.payDay)}. See the figures and ways to cover it`
        }
        href="/cash"
        tone={short ? "destructive" : "neutral"}
      />
    </section>
  );
}
