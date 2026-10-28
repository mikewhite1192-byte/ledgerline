import { CreditCard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

// The driver's fuel card on file, by its last four only ("Fuel card ending 4417"): a generic card
// glyph, plain words and a "Test mode" badge while the card rail is simulated. No brand, no logo,
// no card network, no card artwork.
export function FuelCardChip({
  last4,
  status = "active",
  testMode = true,
  className,
}: {
  last4: string;
  status?: "active" | "closed";
  testMode?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2 text-body text-foreground", className)}>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <CreditCard aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        Fuel card ending {last4}
        {status === "closed" ? ", closed" : ""}
      </span>
      {testMode ? <Badge tone="neutral">Test mode</Badge> : null}
    </span>
  );
}
