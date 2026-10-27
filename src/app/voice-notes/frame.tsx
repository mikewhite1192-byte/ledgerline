import type { ReactNode } from "react";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Shell } from "@/lib/advances/read";
import { statusWords } from "@/lib/voice/words";

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
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone }}
      nav={appNav("/voice-notes")}
      title={title}
      signOut={signOut}
    >
      <div className="mx-auto grid w-full max-w-[960px] gap-6">{children}</div>
    </AppShell>
  );
}

export function VoiceStatusBadge({ status }: { status: string }) {
  const { label, tone } = statusWords(status);
  return <Badge tone={tone}>{label}</Badge>;
}
