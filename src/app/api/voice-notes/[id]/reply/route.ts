import { voiceStaffAction } from "@/lib/voice/http";
import { draftVoiceReply } from "@/lib/voice/pipeline";

// POST: draft the reply to the driver from the proposal's outcome, in Spanish for a Spanish note.
// Nothing is sent: the page shows the draft for a person to copy.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return voiceStaffAction(request, params, "reply", (session, id) => draftVoiceReply(session, id));
}
