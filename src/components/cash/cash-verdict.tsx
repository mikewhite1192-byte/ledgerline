import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/format/money";

// The Cash page's answer in one line: short by how much, or covered with how much to spare, for
// the pay day in words ("Friday, Nov 6"). The amount is the engine's gap; the line under it says
// when it was checked and what to do next.
export function CashVerdict({ gapCents, day, children }: { gapCents: number; day: string; children?: ReactNode }) {
  const short = gapCents < 0;
  return (
    <Card
      className={cn(
        "grid gap-1 px-4 py-4 sm:px-5",
        short ? "border-destructive/40 bg-destructive-soft" : "border-success/40 bg-success-soft",
      )}
    >
      <p className={cn("text-h2", short ? "text-destructive" : "text-success")}>
        {short
          ? `Short by ${formatCents(Math.abs(gapCents))} for ${day}`
          : `Covered, ${formatCents(gapCents)} to spare for ${day}`}
      </p>
      {children ? <p className="text-small text-foreground-2">{children}</p> : null}
    </Card>
  );
}
