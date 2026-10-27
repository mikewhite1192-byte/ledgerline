import { cn } from "@/lib/cn";

export function Separator({ className }: { className?: string }) {
  return <hr className={cn("border-0 border-t border-border", className)} />;
}
