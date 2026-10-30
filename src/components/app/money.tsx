import { cn } from "@/lib/cn";
import { formatCents, type SignMode } from "@/lib/format/money";

// The amounts the hide-amounts eye blurs: a Money span under data-amounts="hidden" and under no
// data-amounts="shown". globals.css holds the rule; a test keeps the two selectors equal.
export const MASKED_AMOUNT = '[data-amounts="hidden"] [data-money]:not([data-amounts="shown"] *)';

// One amount. The minus sign is the signal and the color is its echo, so a negative is never
// told by color alone. Alignment belongs to the column, not to this span.
//
// The span carries its own text in data-money, which is what the hide-amounts rule blurs; the
// page's text is the same either way. A number a person must approve sits inside
// data-amounts="shown", which keeps every amount under it in plain view.
export function Money({
  cents,
  sign = "auto",
  tone = "auto",
  className,
}: {
  cents: number;
  sign?: SignMode;
  tone?: "auto" | "plain";
  className?: string;
}) {
  const text = formatCents(cents, { sign });
  const negative = cents < 0;
  return (
    <span
      className={cn(
        "tabular-nums whitespace-nowrap",
        negative && sign !== "never" && tone === "auto" && "text-destructive",
        className,
      )}
      data-negative={negative ? "" : undefined}
      data-money={text}
    >
      {text}
    </span>
  );
}
