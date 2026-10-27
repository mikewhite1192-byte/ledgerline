import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// 16 px text under the md breakpoint, so a phone does not zoom in when the field takes focus.
export const controlClass = cn(
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 text-lead text-foreground md:text-body",
  "placeholder:text-muted-foreground transition-colors duration-150",
  "disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground",
  "aria-invalid:border-destructive",
);

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} className={cn(controlClass, "h-9", className)} {...props} />;
}
