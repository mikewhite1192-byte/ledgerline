import { cn } from "@/lib/cn";
import { formatCents, type SignMode } from "@/lib/format/money";

// One amount. The minus sign is the signal and the color is its echo, so a negative is never
// told by color alone. Alignment belongs to the column, not to this span.
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
    >
      {text}
    </span>
  );
}
