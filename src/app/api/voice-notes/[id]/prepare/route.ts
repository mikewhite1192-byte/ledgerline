import { voiceAction } from "@/lib/voice/http";
import { prepareVoiceNote } from "@/lib/voice/pipeline";

// POST: screen a transcribed note, put it in English and sort it. Safe to press again: a note past
// this step answers with its status, and a timed-out step keeps the note where it was.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return voiceAction(request, params, "prepare", (session, id) => prepareVoiceNote(session, id));
}
