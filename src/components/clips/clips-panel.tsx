"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@/components/app/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { agreementText, clipStatusText } from "@/lib/clips/messages";
import type { ClipView } from "@/lib/clips/types";
import { cn } from "@/lib/cn";
import { ClipViewer } from "./clip-viewer";
import { ClipUploader, type LoadOption } from "./redactor";

// The dock clips page body: upload on top, the carrier's clips on the left, the chosen clip on
// the right.
export function ClipsPanel({ clips, loads }: { clips: ClipView[]; loads: LoadOption[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(clips[0]?.id ?? null);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <div className="grid gap-1">
            <CardTitle>Add a dock clip</CardTitle>
            <CardDescription>
              Faces and license plates are found by the video model and blurred in this browser before the clip is
              kept. The document model then reads the camera clock and the paperwork from the blurred clip.
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {loads.length > 0 ? (
            <ClipUploader
              loads={loads}
              onDone={(id) => {
                setSelected(id);
                router.refresh();
              }}
            />
          ) : (
            <EmptyState title="No loads to attach a clip to" body="A clip belongs to a load's pickup or delivery." />
          )}
        </CardBody>
      </Card>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Clips</CardTitle>
          </CardHeader>
          <CardBody>
            {clips.length === 0 ? (
              <EmptyState title="No clips yet" body="Upload a short clip of a stop to check its times." />
            ) : (
              <ul className="grid gap-2">
                {clips.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-current={c.id === selected ? "true" : undefined}
                      onClick={() => setSelected(c.id)}
                      className={cn(
                        "grid w-full gap-1 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent",
                        c.id === selected && "border-primary",
                      )}
                    >
                      <span className="flex flex-wrap items-center gap-2 text-body text-foreground">
                        Load {c.loadNumber}, {c.stop === "pickup" ? "pickup" : "delivery"}
                        <Badge tone={c.status === "read" ? "success" : c.status === "unreadable" ? "warning" : "neutral"}>
                          {clipStatusText(c.status)}
                        </Badge>
                      </span>
                      <span className="text-small text-foreground-2">
                        {c.reading ? agreementText(c.reading.agreement) : `${(c.durationMs / 1000).toFixed(0)} seconds`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Clip</CardTitle>
          </CardHeader>
          <CardBody>
            {selected ? (
              <ClipViewer key={selected} clipId={selected} onChange={() => router.refresh()} />
            ) : (
              <p className="text-small text-foreground-2">Pick a clip to play it.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
