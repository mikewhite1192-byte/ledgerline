import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatLocalDate } from "@/lib/format/dates";
import { dayOfWeek, type LocalDate } from "@/lib/time/local-date";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

// reload: a plain link (a full page load) in place of the app's own navigation.
export type Shortcut = { label: string; href: string; reload?: boolean };

// hour is the carrier's own wall-clock hour (0 to 23).
export function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// "Good morning, Blue Ridge" and the carrier's date, with the pages a person opens most as
// shortcuts, each only while its page is on. The first one is filled.
export function Greeting({
  name,
  today,
  hour,
  shortcuts,
}: {
  name: string;
  today: LocalDate;
  hour: number;
  shortcuts: readonly Shortcut[];
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="grid min-w-0 gap-0.5">
        <p className="text-h1 text-foreground">
          {greetingFor(hour)}, {name}
        </p>
        <p className="text-body text-foreground-2">
          {WEEKDAYS[dayOfWeek(today)]}, {formatLocalDate(today)}
        </p>
      </div>
      {shortcuts.length > 0 ? (
        <ul aria-label="Shortcuts" className="flex flex-wrap gap-2">
          {shortcuts.map((s, i) => {
            const look = cn(buttonVariants({ variant: i === 0 ? "primary" : "outline", size: "sm" }), "rounded-full");
            return (
              <li key={s.href}>
                {s.reload ? (
                  <a href={s.href} className={look}>
                    {s.label}
                  </a>
                ) : (
                  <Link href={s.href} className={look}>
                    {s.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
