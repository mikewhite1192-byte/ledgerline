// The one list of writes a judge (a demo visitor's login, src/lib/auth/role.ts) may make. Every
// other write route and server action calls staffGate (src/lib/auth/staff-gate.ts) or requireStaff
// first. src/lib/auth/judge-allowlist.test.ts walks src/app and fails on any write handler that
// neither calls one nor is listed here, on a listed one that also calls one, and on a stale entry.
//
// A judge reads and proposes: it asks the agent, asks for one audit on a card and runs the sample
// files through their reads. It never approves, rejects, pays, posts, sends, drafts to a driver,
// arms a driver, connects a ledger, resets the demo or clears a spend alert. The money paths refuse
// a judge again on their own (approvalFrom and readMember take admin and staff only).

// Route keys are "<METHOD> <path under src/app>"; action keys are "<file>#<exported name>".
export const JUDGE_ALLOWED: Readonly<Record<string, string>> = {
  "POST /api/agent/turn": "ask the agent; a turn reads and proposes, and a person approves on the card",
  "POST /api/advances/request": "the advance request desk is one agent turn that proposes",
  "POST /api/advances/suggest": "suggests an advance amount from the rules; writes no money",
  "POST /api/proposals/[id]/audit": "asks for one second check on a card; never approves",
  "POST /api/voice-notes": "the sample voice notes: transcribe one into an untrusted input",
  "POST /api/voice-notes/[id]/prepare": "the sample voice notes: screen, translate and sort the transcript",
  "POST /api/voice-notes/[id]/hand-off": "the sample voice notes: hand the note to the agent, which proposes",
  "POST /api/documents": "the sample documents: store one and read it",
  "POST /api/documents/[id]/read": "the sample documents: finish a read that never finished",
  "POST /api/clips": "the sample dock clips: store one",
  "PUT /api/clips/[id]/redacted": "the sample dock clips: keep the copy blurred in the visitor's browser",
  "POST /api/clips/[id]/read": "the sample dock clips: read the blurred copy's printed values",
  "POST /api/auth/sign-out": "anyone may sign out",
  "src/app/sign-in/actions.ts#signInAction": "signing in comes before any role exists",
};

// Write handlers no carrier login reaches: each takes its own credential, never pc_session.
export const NO_CARRIER_LOGIN: Readonly<Record<string, string>> = {
  "POST /api/internal/sweep": "the sweep runner's service token; a browser session is never read",
  "POST /portal/sign-in": "the fictional broker portal's one-time code, not a carrier login",
};

// GET handlers that write (the QuickBooks link starts and finishes on a redirect). The walker
// treats them as writes; every other GET only reads.
export const WRITING_GETS: readonly string[] = ["GET /api/qbo/connect", "GET /api/qbo/callback"];
