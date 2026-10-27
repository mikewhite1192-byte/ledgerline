"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass } from "@/components/ui/input";
import { encoderSupports, redactClip, webCodecsReady, type ClipTiming } from "@/lib/clips/encode";
import { clipMessage } from "@/lib/clips/messages";
import { MP4_LIMITS, readMp4Header } from "@/lib/clips/mp4";
import type { ClipView } from "@/lib/clips/types";
import { readClip, sendRedacted, uploadRaw } from "./api";

// Upload a dock clip: the server finds faces and plates, this browser blurs them and sends back
// the blurred file, then the server reads it. The chosen file never leaves this page except in
// the one upload request; nothing here keeps it or shows it.

export type LoadOption = { id: string; loadNumber: string; label: string };

type Phase =
  | { kind: "idle" }
  | { kind: "finding" }
  | { kind: "blurring"; done: number; total: number }
  | { kind: "saving" }
  | { kind: "reading" }
  | { kind: "error"; category: string; retry: "save" | "read" | null };

const timingOf = (clip: ClipView): ClipTiming => ({
  width: clip.width,
  height: clip.height,
  fps: clip.fps,
  frameCount: clip.frameCount,
  durationMs: clip.durationMs,
});

export function ClipUploader({ loads, onDone }: { loads: LoadOption[]; onDone: (clipId: string) => void }) {
  const [loadId, setLoadId] = useState(loads[0]?.id ?? "");
  const [stop, setStop] = useState("delivery");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // The blurred file and its clip, held only so a failed save or read can be tried again.
  const pending = useRef<{ clipId: string; bytes: Uint8Array | null } | null>(null);
  const busy = phase.kind !== "idle" && phase.kind !== "error";

  async function read(clipId: string) {
    setPhase({ kind: "reading" });
    const answer = await readClip(clipId);
    if (!answer.ok) {
      setPhase({ kind: "error", category: answer.category, retry: answer.retryable ? "read" : null });
      return;
    }
    pending.current = null;
    setPhase({ kind: "idle" });
    setFile(null);
    onDone(clipId);
  }

  async function save(clipId: string, bytes: Uint8Array) {
    setPhase({ kind: "saving" });
    const answer = await sendRedacted(clipId, bytes);
    if (!answer.ok) {
      setPhase({ kind: "error", category: answer.category, retry: answer.retryable ? "save" : null });
      return;
    }
    pending.current = { clipId, bytes: null };
    await read(clipId);
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!file || !loadId || busy) return;
    pending.current = null;
    // Everything this browser can check is checked before the upload, so no model call is paid
    // for a clip it could not blur.
    if (!webCodecsReady()) return setPhase({ kind: "error", category: "no_webcodecs", retry: null });
    if (file.size > MP4_LIMITS.maxBytes) return setPhase({ kind: "error", category: "too_large", retry: null });
    const header = readMp4Header(new Uint8Array(await file.arrayBuffer()));
    if (!header.ok) {
      const category = header.reason === "too_large" ? "too_large" : header.reason === "too_long" ? "too_long" : "unsupported";
      return setPhase({ kind: "error", category, retry: null });
    }
    if (!(await encoderSupports(header.header))) return setPhase({ kind: "error", category: "no_webcodecs", retry: null });

    setPhase({ kind: "finding" });
    const uploaded = await uploadRaw(file, loadId, stop);
    if (!uploaded.ok) return setPhase({ kind: "error", category: uploaded.category, retry: null });
    const { clip, plan } = uploaded.value;
    if (clip.status !== "redacting") return read(clip.id);

    setPhase({ kind: "blurring", done: 0, total: clip.frameCount });
    const result = await redactClip(file, plan, timingOf(clip), (done, total) =>
      setPhase({ kind: "blurring", done, total }),
    );
    if (!result.ok) return setPhase({ kind: "error", category: result.reason, retry: null });
    pending.current = { clipId: clip.id, bytes: result.bytes };
    await save(clip.id, result.bytes);
  }

  function retry() {
    const held = pending.current;
    if (!held || phase.kind !== "error") return;
    if (phase.retry === "save" && held.bytes) void save(held.clipId, held.bytes);
    else if (phase.retry === "read") void read(held.clipId);
  }

  return (
    <form onSubmit={start} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="clip-load" label="Load">
          {(control) => (
            <select
              {...control}
              className={`${controlClass} h-9`}
              value={loadId}
              disabled={busy}
              onChange={(e) => setLoadId(e.target.value)}
            >
              {loads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="clip-stop" label="Stop">
          {(control) => (
            <select
              {...control}
              className={`${controlClass} h-9`}
              value={stop}
              disabled={busy}
              onChange={(e) => setStop(e.target.value)}
            >
              <option value="pickup">Pickup</option>
              <option value="delivery">Delivery</option>
            </select>
          )}
        </Field>
      </div>
      <Field id="clip-file" label="Dock clip" hint="An MP4 of at most 20 seconds and 700 KB. Faces and plates are blurred before it is kept.">
        {(control) => (
          <input
            {...control}
            type="file"
            accept="video/mp4"
            disabled={busy}
            className="text-body text-foreground-2 file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-body file:text-foreground"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!file || !loadId || busy}>
          Upload and blur
        </Button>
        <p role="status" aria-live="polite" className="text-small text-foreground-2">
          {phase.kind === "finding" && "Finding faces and plates..."}
          {phase.kind === "blurring" && `Blurring in this browser, frame ${phase.done} of ${phase.total}`}
          {phase.kind === "saving" && "Saving the blurred clip..."}
          {phase.kind === "reading" && "Reading clocks and paperwork..."}
        </p>
      </div>
      {phase.kind === "error" ? (
        <InlineAlert
          tone="destructive"
          action={
            phase.retry ? (
              <Button type="button" size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {clipMessage(phase.category)}
        </InlineAlert>
      ) : null}
    </form>
  );
}
