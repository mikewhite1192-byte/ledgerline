import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// The page's one visible title, so it is the page's h1; sections under it start at h2.
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="grid max-w-[72ch] gap-1">
        <h1 className="text-h1 text-foreground">{title}</h1>
        {description ? <p className="text-lead text-foreground-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
