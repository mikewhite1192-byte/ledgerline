import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type Align = { align?: "left" | "right" };

// Right-aligned cells are the money rail: tabular figures on one shared right edge.
const alignClass = (align: Align["align"]) => (align === "right" ? "text-right tabular-nums" : "text-left");

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full border-collapse text-small", className)} {...props} />;
}

export function THead({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("border-b border-border", className)} {...props} />;
}

export function TBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&>tr:last-child]:border-0", className)} {...props} />;
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border", className)} {...props} />;
}

export function Th({ className, align, ...props }: ComponentProps<"th"> & Align) {
  return (
    <th
      scope="col"
      className={cn(
        "h-9 px-3 align-middle text-caption whitespace-nowrap text-muted-foreground",
        alignClass(align),
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, align, ...props }: ComponentProps<"td"> & Align) {
  return <td className={cn("px-3 py-2.5 align-middle", alignClass(align), className)} {...props} />;
}
