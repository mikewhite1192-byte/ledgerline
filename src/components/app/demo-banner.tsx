// The thin line on every page of a demo visit (a judge login, src/app/sign-in/try-demo-action.ts).
// "Start over" opens Home with an empty thread; the next question starts a new conversation in the
// same visit and the same budget (it never starts a new visit). "Leave" is the normal sign-out,
// which clears both cookies. The visit's budget is still enforced; the line does not print it.
export function DemoBanner({ carrier }: { carrier: string }) {
  return (
    <div
      role="region"
      aria-label="Demo visit"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-secondary px-4 py-2 text-small text-secondary-foreground md:px-6"
    >
      <p className="min-w-0 flex-1">
        You are visiting {carrier}, a demo carrier with made-up data.
      </p>
      <div className="flex shrink-0 items-center gap-4">
        {/* A plain GET form, so the page loads fresh and the chat starts with no thread. */}
        <form action="/" method="get">
          <input type="hidden" name="new" value="1" />
          <button type="submit" className="font-medium text-link underline-offset-4 hover:underline">
            Start over
          </button>
        </form>
        <form action="/api/auth/sign-out" method="post">
          <button type="submit" className="font-medium text-link underline-offset-4 hover:underline">
            Leave
          </button>
        </form>
      </div>
    </div>
  );
}
