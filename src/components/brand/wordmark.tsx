import { cn } from "@/lib/cn";
import { Mark } from "./mark";

// The name set in the UI face at weight 600, in one weight and color.
export function Wordmark({ size = "sm", className }: { size?: "sm" | "lg"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-semibold tracking-[-0.01em] text-foreground",
        size === "lg" ? "gap-3 text-h2" : "gap-2.5 text-h3",
        className,
      )}
    >
      <Mark size={size === "lg" ? 32 : 24} />
      LedgerLine
    </span>
  );
}
