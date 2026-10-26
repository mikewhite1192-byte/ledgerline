import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { EmptyState, ErrorState, type EmptyStateProps, type ErrorStateProps } from "./states";

export type Column<T> = {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  width?: string;
  // Long text (a lane, a description) may wrap; everything else stays on one line.
  wrap?: boolean;
};

export type DataTableProps<T> = {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  state?: "ready" | "loading" | "empty" | "error";
  empty?: EmptyStateProps;
  error?: ErrorStateProps;
  dense?: boolean;
  pinFirstColumn?: boolean;
  // Off when the table sits inside something that already has a border.
  framed?: boolean;
  rowId?: (row: T) => string | undefined;
  className?: string;
};

// A failed read shows the error, never the empty copy: unknown is not zero.
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  state = "ready",
  empty,
  error,
  dense = false,
  pinFirstColumn = true,
  framed = true,
  rowId,
  className,
}: DataTableProps<T>) {
  const resolved = state === "ready" && rows.length === 0 ? "empty" : state;
  const pin = (i: number) =>
    pinFirstColumn && i === 0
      ? "max-md:sticky max-md:left-0 max-md:z-10 max-md:bg-card max-md:shadow-[1px_0_0_var(--border)]"
      : "";
  const cellPad = dense ? "py-1.5" : "";
  // The empty and failed messages sit under the scroll area, not inside it, so they stay centered
  // on the visible width when a phone scrolls the columns sideways.
  return (
    <div className={cn("min-w-0 overflow-hidden bg-card", framed && "rounded-lg border border-border", className)}>
      <div className="scroll-edges overflow-x-auto">
        <Table aria-busy={resolved === "loading" || undefined}>
          <caption className="px-3 pt-3 pb-1 text-left text-caption text-muted-foreground">
            {caption}
            {resolved === "loading" ? <span className="sr-only">, loading</span> : null}
          </caption>
          <THead>
            <Tr>
              {columns.map((c, i) => (
                <Th key={c.key} align={c.align} style={c.width ? { width: c.width } : undefined} className={pin(i)}>
                  {c.header}
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {resolved === "ready"
              ? rows.map((row) => (
                  <Tr key={rowKey(row)} id={rowId?.(row)} className="scroll-mt-20 target:bg-success-soft">
                    {columns.map((c, i) => (
                      <Td
                        key={c.key}
                        align={c.align}
                        className={cn(cellPad, pin(i), c.wrap ? "min-w-40" : "whitespace-nowrap")}
                      >
                        {c.cell(row)}
                      </Td>
                    ))}
                  </Tr>
                ))
              : null}
            {resolved === "loading"
              ? Array.from({ length: 5 }, (_, r) => (
                  <Tr key={r}>
                    {columns.map((c, i) => (
                      <Td key={c.key} align={c.align} className={cn(cellPad, pin(i))}>
                        <Skeleton className={cn("w-12", c.align === "right" && "ml-auto", i === 0 && "w-20")} />
                      </Td>
                    ))}
                  </Tr>
                ))
              : null}
          </TBody>
        </Table>
      </div>
      {resolved === "empty" ? <EmptyState title="Nothing here yet" {...empty} /> : null}
      {resolved === "error" ? <ErrorState category="unknown" {...error} /> : null}
    </div>
  );
}
