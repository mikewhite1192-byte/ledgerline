import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { isReportPath } from "@/lib/reports/types";

const HINT_TONE = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
} as const;

function hintLink(tone: keyof typeof HINT_TONE): string {
  return cn("w-fit text-small underline-offset-4 hover:underline", tone === "neutral" ? "text-link" : HINT_TONE[tone]);
}

// A label, one figure, and one hint line that links to the records behind it when href is set.
export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "neutral",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: keyof typeof HINT_TONE;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-col gap-1 px-4 py-4 sm:px-5", className)}>
      <p className="text-small text-foreground-2">{label}</p>
      <p className="truncate text-figure text-foreground tabular-nums">{value}</p>
      {hint ? (
        href ? (
          isReportPath(href) ? (
            <a href={href} download className={hintLink(tone)}>
              {hint}
            </a>
          ) : (
            <Link href={href} className={hintLink(tone)}>
              {hint}
            </Link>
          )
        ) : (
          <p className={cn("text-small", HINT_TONE[tone])}>{hint}</p>
        )
      ) : null}
    </Card>
  );
}
