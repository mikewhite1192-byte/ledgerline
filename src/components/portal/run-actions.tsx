"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass } from "@/components/ui/input";

// Start a run for one delivered load, or get a one-time code to open the portal yourself. The
// code is shown once, here, and never again.

export type LoadChoice = { loadId: string; loadNumber: string; reference: string };
type Access = { carrierNumber: string; code: string; expiresAt: string; signInPath: string };

const START_ERRORS: Record<string, string> = {
  disabled: "Portal runs cannot start here: no runner is set up for this environment.",
  no_portal_load: "The portal has no record of that load.",
  unavailable: "Could not start the run. Try again in a moment.",
};

export function PortalRunActions({ choices }: { choices: LoadChoice[] }) {
  const router = useRouter();
  const [loadId, setLoadId] = useState(choices[0]?.loadId ?? "");
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [opening, setOpening] = useState(false);

  async function start() {
    setStarting(true);
    setProblem(null);
    try {
      const res = await fetch("/api/portal-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loadId, refresh: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; reason?: string; error?: string };
      if (body.runId) {
        router.push(`/portal-runs/${body.runId}`);
        return;
      }
      setProblem(START_ERRORS[body.reason ?? body.error ?? "unavailable"] ?? START_ERRORS.unavailable);
    } catch {
      setProblem(START_ERRORS.unavailable);
    } finally {
      setStarting(false);
    }
  }

  async function openPortal() {
    setOpening(true);
    setProblem(null);
    try {
      const res = await fetch("/api/portal-access", { method: "POST" });
      if (!res.ok) throw new Error("access");
      setAccess((await res.json()) as Access);
    } catch {
      setProblem("Could not make a portal code. Try again in a moment.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New run</CardTitle>
        <CardDescription>Pick a delivered load the broker&apos;s portal knows. A run takes about a minute.</CardDescription>
      </CardHeader>
      <CardBody className="grid gap-4">
        {choices.length === 0 ? (
          <p className="text-body text-foreground-2">No delivered loads are on the portal yet.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid min-w-[240px] flex-1 gap-1 text-small font-medium">
              Load
              <select className={controlClass} value={loadId} onChange={(e) => setLoadId(e.target.value)}>
                {choices.map((c) => (
                  <option key={c.loadId} value={c.loadId}>
                    {c.loadNumber} ({c.reference})
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={start} pending={starting} pendingLabel="Starting" disabled={!loadId}>
              Start run
            </Button>
            <Button variant="outline" onClick={openPortal} pending={opening} pendingLabel="Making a code">
              Open the portal yourself
            </Button>
          </div>
        )}
        {problem ? <InlineAlert tone="destructive">{problem}</InlineAlert> : null}
        {access ? (
          <InlineAlert tone="info" title="Your portal code (shown once)">
            Carrier number <strong>{access.carrierNumber}</strong>, access code{" "}
            <strong className="font-mono">{access.code}</strong>. It signs in once and expires in 20 minutes.{" "}
            <a href={access.signInPath} target="_blank" rel="noreferrer" className="text-link underline">
              Open the sign-in page
            </a>
          </InlineAlert>
        ) : null}
      </CardBody>
    </Card>
  );
}
