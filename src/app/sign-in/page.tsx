import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { signInAction } from "./actions";
import { tryDemoAction } from "./try-demo-action";

// Logins are created only by the demo script: no sign-up link, no password reset. While
// flags.judgeAccess is on, a second card signs a visitor in to the demo carrier
// (./try-demo-action.ts); ?demo= carries its one fixed line back.
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; demo?: string | string[] }>;
}) {
  if (await getSession()) redirect("/");
  const { error, demo } = await searchParams;
  const message =
    error === "invalid"
      ? "Email or password is wrong"
      : error === "unavailable"
        ? "Sign-in is unavailable right now"
        : null;
  const demoOn = flags.judgeAccess.enabled;
  const demoMessage =
    demo === "unavailable"
      ? "The demo sign-in is not available right now. The video shows the full flow."
      : demo === "expired"
        ? "Your demo visit ended. Start another any time."
        : null;

  return (
    <main className="relative isolate flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      {/* A photo behind the cards, decoration only. The wash fades from the page color at the top so the
          wordmark reads in either theme; the cards stay solid. Anchored low and right to keep the truck.
          Two pre-sized WebP files and srcSet do what the image optimizer would, with no server work. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/sign-in/background-1614.webp"
        srcSet="/sign-in/background-960.webp 960w, /sign-in/background-1614.webp 1614w"
        sizes="100vw"
        alt=""
        aria-hidden="true"
        decoding="async"
        fetchPriority="high"
        className="absolute inset-0 -z-10 h-full w-full object-cover object-[70%_100%]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-linear-to-b from-background/75 via-background/25 to-background/10"
      />
      <div className="grid w-full max-w-[400px] gap-6">
        <Wordmark size="lg" className="justify-self-center" />
        <Card className="grid gap-5 p-6 sm:p-8">
          <div className="grid gap-1">
            <h1 className="text-h2 text-foreground">Sign in</h1>
            <p className="text-body text-foreground-2">Your carrier&apos;s pay desk.</p>
          </div>
          {message ? <InlineAlert tone="destructive">{message}</InlineAlert> : null}
          <form action={signInAction} className="grid gap-4">
            <Field id="email" label="Email">
              {(c) => (
                <Input {...c} name="email" type="email" autoComplete="username" required maxLength={254} />
              )}
            </Field>
            <Field id="password" label="Password">
              {(c) => (
                <Input
                  {...c}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                />
              )}
            </Field>
            <Button type="submit" size="lg" className="mt-1 w-full">
              Sign in
            </Button>
          </form>
        </Card>
        {demoOn || demoMessage ? (
          <Card className="grid gap-4 p-6 sm:p-8">
            {demoOn ? (
              <div className="grid gap-1">
                <h2 className="text-h3 text-foreground">Try the demo carrier</h2>
                <p className="text-body text-foreground-2">
                  A fictional carrier with made-up drivers and loads. You can ask the agent and watch
                  every check. Nothing is paid or sent.
                </p>
                <p className="text-body text-foreground-2">
                  The data is made up, so please do not upload real documents.
                </p>
              </div>
            ) : null}
            {demoMessage ? <InlineAlert tone="neutral">{demoMessage}</InlineAlert> : null}
            {demoOn ? (
              <form action={tryDemoAction}>
                <Button type="submit" variant="outline" size="lg" className="w-full">
                  Try the demo carrier
                </Button>
              </form>
            ) : null}
          </Card>
        ) : null}
        <p className="justify-self-center rounded-full bg-card/90 px-4 py-2 text-center text-body text-foreground-2 shadow-sm">
          New to trucking pay?{" "}
          <Link href="/help/how-pay-works" className="text-link underline-offset-4 hover:underline">
            How trucking pay works
          </Link>
        </p>
      </div>
    </main>
  );
}
