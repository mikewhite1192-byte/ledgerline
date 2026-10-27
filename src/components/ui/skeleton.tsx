import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      className={cn("block h-4 rounded-sm bg-secondary motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}
