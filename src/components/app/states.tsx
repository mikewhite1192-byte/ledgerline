import { CircleAlert, Inbox, PowerOff, SearchX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { STAFF_ONLY_BODY, STAFF_ONLY_TITLE } from "./staff-only";
import { cn } from "@/lib/cn";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  // A heading when the state is the whole page (its one h1) or a section's title; a plain line otherwise.
  titleAs?: "p" | "h1" | "h2";
  className?: string;
};

// Says what would fill the space and offers the way to fill it.
export function EmptyState({ icon, title, body, action, titleAs: Title = "p", className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center", className)}>
      <span className="mb-1 grid size-10 place-items-center rounded-lg bg-secondary text-foreground-2 [&>svg]:size-5">
        {icon ?? <Inbox aria-hidden />}
      </span>
      <Title className="text-h3 text-foreground">{title}</Title>
      {body ? <p className="max-w-[48ch] text-body text-foreground-2">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

// Keeps the layout at its final size while the read runs.
export function LoadingState({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={cn("grid gap-3 py-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className={i % 2 ? "w-2/5" : "w-3/5"} />
          <Skeleton className="ml-auto w-20" />
        </div>
      ))}
    </div>
  );
}

export const ERROR_CATEGORIES = [
  "unreadable",
  "forbidden",
  "judge",
  "timeout",
  "not_found",
  "budget",
  "job_cap",
  "unknown",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

// A fixed message per category: what failed and what to do. The raw error never reaches a prop.
const ERROR_COPY: Record<ErrorCategory, { title: string; body: string }> = {
  unreadable: {
    title: "Could not read your carrier's data",
    body: "Try again in a moment.",
  },
  forbidden: {
    title: "This login is not linked to a carrier",
    body: "Sign out, then sign in with the login your carrier set up for you.",
  },
  // A demo visitor pressed a button that is for the carrier's staff (src/lib/auth/staff-gate.ts).
  judge: { title: STAFF_ONLY_TITLE, body: STAFF_ONLY_BODY },
  timeout: {
    title: "That took too long to load",
    body: "Nothing on this page changed. Try again in a moment.",
  },
  not_found: {
    title: "That record is not here",
    body: "It may have been removed, or it may belong to another carrier.",
  },
  budget: {
    title: "The demo budget is used up",
    body: "The agent pauses until the budget is raised. Your data and every payout are unchanged.",
  },
  job_cap: {
    title: "This job paused",
    body: "It used more than its hourly budget. Nothing was lost or sent. An admin can resume it under Settings, Models and spend.",
  },
  unknown: {
    title: "Something failed and the cause is not known",
    body: "Try again in a moment. If it keeps failing, tell your administrator when it happened.",
  },
};

export type ErrorStateProps = {
  category: string;
  title?: ReactNode;
  body?: ReactNode;
  retry?: ReactNode;
  // Off only where the error is a specimen on show, never a failure that just happened.
  announce?: boolean;
  className?: string;
};

export function ErrorState({ category, title, body, retry, announce = true, className }: ErrorStateProps) {
  const copy = Object.hasOwn(ERROR_COPY, category)
    ? ERROR_COPY[category as ErrorCategory]
    : ERROR_COPY.unknown;
  return (
    <div role={announce ? "alert" : undefined} className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center", className)}>
      <span className="mb-1 grid size-10 place-items-center rounded-lg bg-destructive-soft text-destructive">
        <CircleAlert aria-hidden className="size-5" />
      </span>
      <p className="text-h3 text-foreground">{title ?? copy.title}</p>
      <p className="max-w-[48ch] text-body text-foreground-2">{body ?? copy.body}</p>
      {retry ? <div className="mt-2">{retry}</div> : null}
    </div>
  );
}

// The one link back from a dead end: Home is always on.
function HomeLink() {
  return (
    <Link href="/" className={buttonVariants({ variant: "outline" })}>
      Go to Home
    </Link>
  );
}

// Every switched-off page says the same thing in the same place: what is off, that nothing changed,
// who can switch it on, and the way back. `name` is the feature as the menu says it ("Voice notes").
export function FeatureOff({ name, plural = false, className }: { name: string; plural?: boolean; className?: string }) {
  return (
    <EmptyState
      icon={<PowerOff aria-hidden />}
      title={`${name} ${plural ? "are" : "is"} off for this carrier`}
      body="Nothing here has changed. Ask your administrator to switch it on."
      action={<HomeLink />}
      titleAs="h2"
      className={className}
    />
  );
}

// An address with no page behind it, or a page switched off before it reads anything. It is the
// page's one heading, so it is the h1.
export function PageNotFound({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={<SearchX aria-hidden />}
      title="That page is not here"
      body="The address may be wrong, or the page may be switched off for this carrier. Nothing changed."
      action={<HomeLink />}
      titleAs="h1"
      className={className}
    />
  );
}
