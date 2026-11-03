import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand/wordmark";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { getPreparingVisit, visitLanding } from "@/lib/auth/session";
import { Preparing } from "./preparing";

// Where a demo visit waits while its own copy of the demo carrier is built (flags.visitCopies,
// ./actions.ts). Only a visit whose copy is claimed and not yet built is shown this page; every
// other request goes where it belongs.
export default async function PreparingPage() {
  if (!flags.visitCopies.enabled) redirect("/");
  const visit = await getPreparingVisit();
  if (!visit) redirect(await visitLanding());
  const landing = flags.signInTour.enabled === true ? "/?welcome=1" : "/";
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[400px] gap-6">
        <div className="grid justify-items-center gap-2">
          <Wordmark size="lg" />
        </div>
        <Card className="grid gap-4 p-6 sm:p-8">
          <div className="grid gap-1">
            <h1 className="text-h2 text-foreground">Setting up your carrier</h1>
            <p className="text-body text-foreground-2">
              You get your own copy of the demo carrier, with made-up drivers and loads. Anything you
              do stays in your copy, and the copy is removed after your visit.
            </p>
          </div>
          <Preparing landing={landing} />
        </Card>
      </div>
    </main>
  );
}
