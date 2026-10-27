"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { agreementText, clipMessage, clipStatusText, clipTime } from "@/lib/clips/messages";
import type { RedactionPlan } from "@/lib/clips/redaction";
import type { ClipView, StoredReading } from "@/lib/clips/types";
import { clipFileUrl, getClip, readClip } from "./api";

// Plays a kept clip: the blurred file (the only one there is), the planned boxes as outlines when
// "Show what was blurred" is on, and each value the reading found as a mark that jumps to where it
// was read. The reading is shown next to the stored times; it never changes them.

export type ClipMark = { label: string; atSeconds: number };

// The reading's citations, in clip order.
export function clipMarks(reading: StoredReading | null): ClipMark[] {
  if (!reading) return [];
  const marks: ClipMark[] = [];
  if (reading.arrival) marks.push({ label: `Arrival clock ${reading.arrival.clockText}`, atSeconds: reading.arrival.atSeconds });
  if (reading.departure) {
    marks.push({ label: `Departure clock ${reading.departure.clockText}`, atSeconds: reading.departure.atSeconds });
  }
  if (reading.bolNumber) marks.push({ label: `BOL ${reading.bolNumber.value}`, atSeconds: reading.bolNumber.atSeconds });
  if (reading.sealNumber) marks.push({ label: `Seal ${reading.sealNumber.value}`, atSeconds: reading.sealNumber.atSeconds });
  return marks.sort((a, b) => a.atSeconds - b.atSeconds);
}

const AGREEMENT_TONE: Record<string, BadgeTone> = {
  matches: "success",
  differs: "warning",
  no_clock: "neutral",
  no_times: "neutral",
};

type Loaded = { clip: ClipView; plan: RedactionPlan | null; fileUrl: string | null };

export function ClipViewer({ clipId, onChange }: { clipId: string; onChange?: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(false);
  const [reading, setReading] = useState(false);
  const [version, setVersion] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setLoaded(null);
    setProblem(null);
    (async () => {
      const answer = await getClip(clipId);
      if (!live) return;
      if (!answer.ok) return setProblem(answer.category);
      const { clip, plan } = answer.value;
      if (clip.redactedByteLength !== null) {
        // Fetched whole (it is at most 700 KB) so seeking works without range requests.
        try {
          const response = await fetch(clipFileUrl(clipId), { cache: "no-store", credentials: "same-origin" });
          if (!response.ok) throw new Error("file");
          const blob = await response.blob();
          if (!live) return;
          objectUrl = URL.createObjectURL(blob);
        } catch {
          if (live) setProblem("unavailable");
          return;
        }
      }
      if (live) setLoaded({ clip, plan, fileUrl: objectUrl });
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [clipId, version]);

  // The overlay follows the playing frame.
  useEffect(() => {
    const v = video.current;
    const canvas = overlay.current;
    const plan = loaded?.plan;
    if (!v || !canvas || !plan) return;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!showBoxes) return;
      const frameMs = loaded.clip.durationMs / loaded.clip.frameCount;
      const frame = Math.min(plan.frameCount - 1, Math.max(0, Math.floor((v.currentTime * 1000) / frameMs)));
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 320));
      ctx.strokeStyle = "#f59e0b";
      for (const [x1, y1, x2, y2] of plan.frames[frame] ?? []) ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    };
    draw();
    v.addEventListener("timeupdate", draw);
    v.addEventListener("seeked", draw);
    return () => {
      v.removeEventListener("timeupdate", draw);
      v.removeEventListener("seeked", draw);
    };
  }, [loaded, showBoxes]);

  async function readAgain() {
    setReading(true);
    const answer = await readClip(clipId);
    setReading(false);
    if (!answer.ok) return setProblem(answer.category);
    setVersion((n) => n + 1);
    onChange?.();
  }

  if (problem) return <InlineAlert tone="destructive">{clipMessage(problem)}</InlineAlert>;
  if (!loaded) {
    return (
      <p role="status" className="text-small text-foreground-2">
        Loading the clip...
      </p>
    );
  }
  const { clip, plan, fileUrl } = loaded;
  const marks = clipMarks(clip.reading);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={clip.status === "read" ? "success" : clip.status === "unreadable" ? "warning" : "neutral"}>
          {clipStatusText(clip.status)}
        </Badge>
        {clip.reading ? (
          <Badge tone={AGREEMENT_TONE[clip.reading.agreement.result] ?? "neutral"}>
            {agreementText(clip.reading.agreement)}
          </Badge>
        ) : null}
        {clip.status === "redacted" || clip.status === "budget" ? (
          <Button size="sm" variant="outline" onClick={readAgain} disabled={reading}>
            {reading ? "Reading..." : "Read the clip"}
          </Button>
        ) : null}
      </div>
      {fileUrl ? (
        <div className="relative w-full overflow-hidden rounded-lg border border-border bg-black" style={{ aspectRatio: `${clip.width} / ${clip.height}` }}>
          <video ref={video} src={fileUrl} controls muted playsInline className="absolute inset-0 size-full" />
          <canvas
            ref={overlay}
            width={clip.width}
            height={clip.height}
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full"
          />
        </div>
      ) : (
        <InlineAlert>The blurred clip has not been saved yet. Upload the same file again to finish it.</InlineAlert>
      )}
      {fileUrl && plan ? (
        <label className="flex items-center gap-2 text-body text-foreground">
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
          Show what was blurred
          {clip.coverage ? (
            <span className="text-small text-foreground-2">
              (faces in {clip.coverage.faceFrames} frames, plates in {clip.coverage.plateFrames})
            </span>
          ) : null}
        </label>
      ) : null}
      {marks.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Where each value was read">
          {marks.map((m) => (
            <li key={`${m.label}-${m.atSeconds}`}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (video.current) video.current.currentTime = m.atSeconds;
                }}
              >
                {m.label} at {clipTime(m.atSeconds)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {clip.reading?.doorText ? (
        <p className="text-small text-foreground-2">Door sign: {clip.reading.doorText}</p>
      ) : null}
    </div>
  );
}
