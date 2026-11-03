import { cn } from "@/lib/cn";

// "Start over" opens Home with an empty thread; the next question starts a new conversation in the
// same visit and the same budget (it never starts a new visit). "Leave" is the normal sign-out,
// which clears both cookies.
function VisitControls({ linkClass }: { linkClass: string }) {
  return (
    <div className="flex shrink-0 items-center gap-4">
      {/* A plain GET form, so the page loads fresh and the chat starts with no thread. */}
      <form action="/" method="get">
        <input type="hidden" name="new" value="1" />
        <button type="submit" className={linkClass}>
          Start over
        </button>
      </form>
      <form action="/api/auth/sign-out" method="post">
        <button type="submit" className={linkClass}>
          Leave
        </button>
      </form>
    </div>
  );
}

// The thin line on every page of a demo visit (a judge login, src/app/sign-in/try-demo-action.ts).
// The visit's budget is still enforced; the line does not print it. A visit with its own copy of
// the demo carrier (flags.visitCopies) says so instead, in plain words with no amounts.
export function DemoBanner({ carrier, copy = false }: { carrier: string; copy?: boolean }) {
  return (
    <div
      role="region"
      aria-label="Demo visit"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-secondary px-4 py-2 text-small text-secondary-foreground md:px-6"
    >
      {copy ? (
        <p className="min-w-0 flex-1">
          This is your own copy of {carrier}, a demo carrier with made-up data. Nothing real is paid or
          sent, and your copy is removed after your visit.
        </p>
      ) : (
        <p className="min-w-0 flex-1">
          You are visiting {carrier}, a demo carrier with made-up data.
        </p>
      )}
      <VisitControls linkClass="font-medium text-link underline-offset-4 hover:underline" />
    </div>
  );
}

// Under the simple shape (flags.simpleShape) a demo visit gets this one line instead of the
// test-mode line and the demo line: who you are visiting, that the data is made up, and, only
// while every payout and posting is test-only, that nothing real moves. A visit's own copy says
// it is the visitor's own.
export function visitorLine(carrier: string, testMode: boolean, copy = false): string {
  if (copy) return `Your own copy of ${carrier}, made-up data. Nothing real moves.`;
  return testMode
    ? `Demo of ${carrier}, made-up data. Nothing real moves.`
    : `Demo of ${carrier}, made-up data.`;
}

// It takes the test-mode line's place across the top: one line at laptop width, where it stays
// put above the top bar; on a phone it wraps and scrolls away.
export function VisitorNotice({
  carrier,
  testMode,
  copy = false,
}: {
  carrier: string;
  testMode: boolean;
  copy?: boolean;
}) {
  return (
    <div
      role="region"
      aria-label="Demo visit"
      className={cn(
        "z-40 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-foreground px-4 py-2 text-small font-medium text-background md:px-6",
        "lg:sticky lg:top-0 lg:h-9 lg:flex-nowrap lg:py-0",
      )}
    >
      <p className="min-w-0 lg:truncate">{visitorLine(carrier, testMode, copy)}</p>
      <VisitControls linkClass="font-medium underline underline-offset-4 hover:no-underline" />
    </div>
  );
}
