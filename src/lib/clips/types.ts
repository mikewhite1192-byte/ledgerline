import type { Agreement } from "./agreement";
import type { RedactionPlan } from "./redaction";
import type { ClipReading } from "./schema";

export const CLIP_STOPS = ["pickup", "delivery"] as const;
export type ClipStop = (typeof CLIP_STOPS)[number];

export type ClipStatus = "redacting" | "redacted" | "read" | "unreadable" | "budget";

// Why a clip request was refused. Categories only: these are what a person sees, never an
// upstream message.
export type ClipRefusal =
  | "disabled"
  | "too_large"
  | "unsupported"
  | "too_long"
  | "limit"
  | "duplicate"
  | "not_found"
  | "busy"
  | "failed"
  | "budget"
  | "store_failed"
  | "not_ready"
  | "mismatch"
  | "unchanged"
  | "conflict"
  | "read_failed"
  | "read_spent";

export type ClipFailure = { ok: false; category: ClipRefusal; retryable: boolean; clipId?: string };

// The reading as kept: the printed values plus how the clocks compare with the stored stop times.
export type StoredReading = ClipReading & { agreement: Agreement };

// What a person sees of a clip. Never a byte of video, never a raw hash, never a model's text.
export type ClipView = {
  id: string;
  loadId: string;
  loadNumber: string;
  stop: ClipStop;
  filename: string;
  status: ClipStatus;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationMs: number;
  // Both segmentation answers are kept: the browser can blur (again) from the plan.
  planReady: boolean;
  redactedByteLength: number | null;
  reading: StoredReading | null;
  coverage: { faceFrames: number; plateFrames: number } | null;
  createdAt: string;
  redactedAt: string | null;
  readAt: string | null;
};

export type ClipWithPlan = { clip: ClipView; plan: RedactionPlan | null };
