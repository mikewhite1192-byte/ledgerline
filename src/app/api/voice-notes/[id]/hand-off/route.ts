import { voiceAction } from "@/lib/voice/http";
import { handOffVoiceNote } from "@/lib/voice/pipeline";

// POST: hand a ready note to the agent as one turn ("Handle voice note <id>"). The agent reads the
// note through the gateway and proposes; a person approves on the card. A second press answers with
// the first turn's conversation.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return voiceAction(request, params, "hand-off", (session, id) => handOffVoiceNote(session, id));
}
