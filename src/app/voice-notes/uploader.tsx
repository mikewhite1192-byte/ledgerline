"use client";

import { Mic, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass } from "@/components/ui/input";
import type { DriverOption } from "@/lib/advances/read";
import { cn } from "@/lib/cn";
import { isVoiceMime, voiceMime } from "@/lib/voice/mime";
import { encodeWav, VOICE_SAMPLE_RATE } from "@/lib/voice/wav-encode";
import { noticeFor } from "@/lib/voice/words";

// Adds a voice note: record in the browser or pick a clip, turn it into 16 kHz mono WAV here, then
// run the steps one after another with a line per step: transcribe, screen and translate, hand to
// the agent. Each step is its own request, so a slow one never times out the others, and the note's
// page can resume any step that stopped. Only fixed sentences are shown, never server text.

export type UploaderLimits = { maxWavBytes: number; maxOriginalBytes: number; maxDurationMs: number };

type Stage = "converting" | "transcribing" | "preparing" | "handing_off";
const STAGES: { key: Stage; label: string }[] = [
  { key: "converting", label: "Getting the clip ready" },
  { key: "transcribing", label: "Transcribing (Muse Voice Transcribe)" },
  { key: "preparing", label: "Screening, translating and sorting (Muse Spark Open, Muse Spark)" },
  { key: "handing_off", label: "Handing to the agent" },
];

type Answer = { ok: boolean; body: Record<string, unknown> };

async function post(url: string, body?: FormData): Promise<Answer> {
  const res = await fetch(url, { method: "POST", body });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { ok: res.ok, body: parsed };
}

const category = (a: Answer) => (typeof a.body.error === "string" ? a.body.error : null);

async function toWav(clip: Blob): Promise<{ wav: Uint8Array; durationMs: number }> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await clip.arrayBuffer());
  } finally {
    await context.close().catch(() => undefined);
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return { wav: encodeWav(rendered.getChannelData(0), VOICE_SAMPLE_RATE), durationMs: Math.round(decoded.duration * 1000) };
}

const noSubscribe = () => () => undefined;
const browserCanRecord = () => typeof window.MediaRecorder !== "undefined" && navigator.mediaDevices !== undefined;

export function Uploader({
  drivers,
  disabled,
  agentOn,
  limits,
}: {
  drivers: DriverOption[];
  disabled: boolean;
  agentOn: boolean;
  limits: UploaderLimits;
}) {
  const router = useRouter();
  const [driverId, setDriverId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [recorded, setRecorded] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ driver?: string; clip?: string }>({});
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<number | null>(null);
  // False on the server and in the first paint, so the markup matches; true once the browser says so.
  const canRecord = useSyncExternalStore(noSubscribe, browserCanRecord, () => false);
  // The longest clip both caps allow: 16 kHz 16-bit mono is 32 bytes a millisecond after the header.
  const longestMs = Math.min(limits.maxDurationMs, Math.floor((limits.maxWavBytes - 44) / 32));

  useEffect(
    () => () => {
      if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function startRecording() {
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecorded(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
        setFile(null);
        setRecording(false);
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      stopTimer.current = window.setTimeout(() => rec.state === "recording" && rec.stop(), longestMs);
    } catch {
      setNotice("The microphone could not be opened. Pick a clip instead.");
    }
  }

  function stopRecording() {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage !== null || disabled) return;
    const clip: Blob | null = recorded ?? file;
    const next = { driver: driverId ? undefined : "Pick a driver.", clip: clip ? undefined : "Record or pick a clip." };
    setErrors(next);
    setNotice(null);
    if (next.driver || next.clip || !clip) return;

    let noteId: string | null = null;
    try {
      setStage("converting");
      let converted: { wav: Uint8Array; durationMs: number };
      try {
        converted = await toWav(clip);
      } catch {
        setNotice(noticeFor("bad_wav"));
        return;
      }
      if (converted.durationMs > limits.maxDurationMs || converted.wav.byteLength > limits.maxWavBytes) {
        setNotice(noticeFor("too_long"));
        return;
      }
      const form = new FormData();
      form.set("driverId", driverId);
      form.set("wav", new Blob([new Uint8Array(converted.wav)], { type: "audio/wav" }), "clip.wav");
      const type = voiceMime(clip.type);
      if (clip.size > 0 && clip.size <= limits.maxOriginalBytes && isVoiceMime(type)) {
        form.set("original", new Blob([clip], { type }), "original");
      }

      setStage("transcribing");
      const uploaded = await post("/api/voice-notes", form);
      if (!uploaded.ok || typeof uploaded.body.voiceNoteId !== "string") {
        setNotice(noticeFor(category(uploaded)));
        if (typeof uploaded.body.voiceNoteId === "string") router.refresh();
        return;
      }
      noteId = uploaded.body.voiceNoteId;

      setStage("preparing");
      const prepared = await post(`/api/voice-notes/${noteId}/prepare`);
      if (!prepared.ok || prepared.body.status !== "ready" || !agentOn) {
        router.push(`/voice-notes/${noteId}`);
        return;
      }

      setStage("handing_off");
      await post(`/api/voice-notes/${noteId}/hand-off`);
      router.push(`/voice-notes/${noteId}`);
    } catch {
      if (noteId) {
        router.push(`/voice-notes/${noteId}`);
      } else {
        setNotice(noticeFor(null));
      }
    } finally {
      setStage(null);
    }
  }

  const busy = stage !== null;
  const shown = agentOn ? STAGES : STAGES.filter((s) => s.key !== "handing_off");
  const at = stage ? shown.findIndex((s) => s.key === stage) : -1;
  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      <Field id="voice-driver" label="Driver" error={errors.driver}>
        {(control) => (
          <select
            {...control}
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            disabled={disabled || busy}
            className={cn(controlClass, "h-9")}
          >
            <option value="">Pick a driver</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}, {d.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="voice-clip" label="Clip" hint="Up to 60 seconds, in English or Spanish. WAV, MP3, M4A, WebM or Ogg." error={errors.clip}>
        {(control) => (
          <div className="flex flex-wrap items-center gap-3">
            <input
              {...control}
              type="file"
              accept="audio/*"
              disabled={disabled || busy || recording}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setRecorded(null);
              }}
              className="max-w-full text-small file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-small file:text-foreground"
            />
            {canRecord ? (
              recording ? (
                <Button type="button" variant="destructive" size="sm" onClick={stopRecording}>
                  <Square aria-hidden /> Stop
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={startRecording} disabled={disabled || busy}>
                  <Mic aria-hidden /> Record
                </Button>
              )
            ) : null}
            {recorded && !recording ? <span className="text-small text-foreground-2">Recording ready</span> : null}
          </div>
        )}
      </Field>
      {busy ? (
        <ol aria-live="polite" className="grid gap-1.5 text-small">
          {shown.map((s, i) => (
            <li key={s.key} className={cn(i < at ? "text-success" : i === at ? "font-medium text-foreground" : "text-muted-foreground")}>
              {i < at ? "Done: " : i === at ? "Now: " : "Next: "}
              {s.label}
            </li>
          ))}
        </ol>
      ) : null}
      {notice ? <InlineAlert tone="destructive">{notice}</InlineAlert> : null}
      <div>
        <Button type="submit" disabled={disabled || recording} pending={busy} pendingLabel="Working on the note">
          Add the note
        </Button>
      </div>
    </form>
  );
}
