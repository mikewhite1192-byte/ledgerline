import { CircleAlert, MessageCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

const LINK = "text-small text-link underline-offset-4 hover:underline";

// One card on Home: its title, the page behind it, and "Ask about this" while the agent is on,
// which opens Home's chat with the card's question in the box (never sent until the person does).
export function HomeCard({
  title,
  link,
  askHref,
  children,
  className,
}: {
  title: string;
  link?: { href: string; label: string };
  askHref?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("min-w-0", className)}>
      <Card className="flex h-full flex-col">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4 sm:px-5">
          <h3 className="text-h3 text-foreground">{title}</h3>
          {link ? (
            <Link href={link.href} className={LINK}>
              {link.label}
            </Link>
          ) : null}
        </div>
        <div className="grid flex-1 content-start gap-3 px-4 pt-2 pb-4 sm:px-5">{children}</div>
        {askHref ? (
          <div className="border-t border-border px-4 py-2.5 sm:px-5">
            <a href={askHref} className={cn(LINK, "inline-flex items-center gap-1.5")}>
              <MessageCircle aria-hidden className="size-4" />
              Ask about this<span className="sr-only">: {title}</span>
            </a>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

// A card whose read failed: it says so in place of its figures, so it never reads as zero.
export function Unavailable({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 text-body text-foreground-2">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span>{children}</span>
    </p>
  );
}

// A card with nothing to show yet: what would fill it.
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-body text-foreground-2">{children}</p>;
}
