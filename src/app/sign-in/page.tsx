import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { getSession } from "@/lib/auth/session";
import { signInAction } from "./actions";

// Logins are created only by the demo script: no sign-up link, no password reset.
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (await getSession()) redirect("/");
  const { error } = await searchParams;
  const message =
    error === "invalid"
      ? "Email or password is wrong"
      : error === "unavailable"
        ? "Sign-in is unavailable right now"
        : null;

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
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
      </div>
    </main>
  );
}
