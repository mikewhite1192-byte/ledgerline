import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { BadgeTone } from "./badge";

const TONE: Record<BadgeTone, { box: string; icon: typeof Info }> = {
  neutral: { box: "border-border bg-secondary [&>svg]:text-foreground-2", icon: Info },
  info: { box: "border-[color-mix(in_srgb,var(--info)_25%,transparent)] bg-info-soft [&>svg]:text-info", icon: Info },
  success: {
    box: "border-[color-mix(in_srgb,var(--success)_25%,transparent)] bg-success-soft [&>svg]:text-success",
    icon: CircleCheck,
  },
  warning: {
    box: "border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-warning-soft [&>svg]:text-warning",
    icon: TriangleAlert,
  },
  destructive: {
    box: "border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-destructive-soft [&>svg]:text-destructive",
    icon: CircleAlert,
  },
};

// A message in the flow of the page. Destructive interrupts a screen reader (role alert); every
// other tone waits its turn (role status).
export function InlineAlert({
  tone = "neutral",
  title,
  children,
  action,
  className,
}: {
  tone?: BadgeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = TONE[tone];
  return (
    <div
      role={tone === "destructive" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-lg border px-4 py-3 text-body", box, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title ? <p className="font-semibold text-foreground">{title}</p> : null}
        {children ? <div className="text-foreground">{children}</div> : null}
        {action ? <div className="mt-1.5">{action}</div> : null}
      </div>
    </div>
  );
}
