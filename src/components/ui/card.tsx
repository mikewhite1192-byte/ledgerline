import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// A border on paper and no shadow: shadows belong only to things that float.
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5 sm:pt-5", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-h3 text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-body text-foreground-2", className)} {...props} />;
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4 sm:p-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5", className)}
      {...props}
    />
  );
}
