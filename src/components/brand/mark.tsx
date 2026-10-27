import { cn } from "@/lib/cn";

// The mark: a sign-green tile with three paper bars that widen toward the bottom, like a road's
// center line seen from the cab and like the rules of a ledger. The same in both modes (a badge,
// not a themed element), so its colors are fixed here and in src/app/icon.svg.
export function Mark({
  size = 24,
  label,
  className,
}: {
  size?: number;
  // Set when the mark stands alone; next to the wordmark it is decoration.
  label?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <rect width="32" height="32" rx="8" fill="#0E6B4D" />
      <rect x="13" y="6" width="6" height="4" rx="2" fill="#F6F6F3" />
      <rect x="11" y="14" width="10" height="4" rx="2" fill="#F6F6F3" />
      <rect x="8" y="22" width="16" height="4" rx="2" fill="#F6F6F3" />
    </svg>
  );
}
