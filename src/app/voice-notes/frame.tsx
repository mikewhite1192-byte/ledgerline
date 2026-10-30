import type { ReactNode } from "react";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { FeatureOff } from "@/components/app/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { readShell, type Shell } from "@/lib/advances/read";
import { withRequestTenant } from "@/lib/tenant/context";
import { statusWords } from "@/lib/voice/words";
import { problemOf, ReadFailed, type ReadProblem } from "../advances/frame";

// The frame every voice note page shares: the signed-in shell with Voice notes current.

const signOut = (
  <form action="/api/auth/sign-out" method="post">
    <Button type="submit" variant="ghost" className="w-full justify-start">
      Sign out
    </Button>
  </form>
);

export function VoiceFrame({ shell, title, children }: { shell: Shell; title: string; children: ReactNode }) {
  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone, role: shell.role }}
      nav={appNav("/voice-notes")}
      title={title}
      signOut={signOut}
    >
      <div className="mx-auto grid w-full max-w-[960px] gap-6">{children}</div>
    </AppShell>
  );
}

// A voice note page while the voice switch is off: the shell, the page's title, and the off state.
// It reads only the carrier chip, never a voice note.
export async function VoiceOffPage({ title, description }: { title: string; description?: string }) {
  let shell: Shell | null = null;
  let problem: ReadProblem | null = null;
  try {
    shell = await withRequestTenant((q, session) => readShell(q, session));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!shell) return <ReadFailed problem={problem ?? "unreadable"} />;
  return (
    <VoiceFrame shell={shell} title={title}>
      <PageHeader title={title} description={description} />
      <FeatureOff name="Voice notes" plural />
    </VoiceFrame>
  );
}

export function VoiceStatusBadge({ status }: { status: string }) {
  const { label, tone } = statusWords(status);
  return <Badge tone={tone}>{label}</Badge>;
}
