// The one list of writes a judge (a demo visitor's login, src/lib/auth/role.ts) may make. Every
// other write route and server action calls staffGate (src/lib/auth/staff-gate.ts) or requireStaff
// first. src/lib/auth/judge-allowlist.test.ts walks src/app and fails on any write handler that
// neither calls one nor is listed here, on a listed one that also calls one, and on a stale entry.
//
// A judge reads and proposes: it asks the agent and asks for one audit on a card. It never approves,
// rejects, pays, posts, sends, drafts to a driver, arms a driver, connects a ledger, resets the
// demo, clears a spend alert, uploads a file (a voice note, a document or a dock clip) or runs a
// step that follows an upload. The money paths refuse a judge again on their own (approvalFrom and
// readMember take admin and staff only).

// Route keys are "<METHOD> <path under src/app>"; action keys are "<file>#<exported name>".
export const JUDGE_ALLOWED: Readonly<Record<string, string>> = {
  "POST /api/agent/turn": "ask the agent; a turn reads and proposes, and a person approves on the card",
  "POST /api/advances/request": "the advance request desk is one agent turn that proposes",
  "POST /api/advances/suggest": "suggests an advance amount from the rules; writes no money",
  "POST /api/proposals/[id]/audit": "asks for one second check on a card; never approves",
  "POST /api/auth/sign-out": "anyone may sign out",
  "src/app/sign-in/actions.ts#signInAction": "signing in comes before any role exists",
  "src/app/sign-in/try-demo-action.ts#tryDemoAction":
    "the demo visitor's sign-in comes before any role exists, and it signs in a judge only",
};

// Write handlers no carrier login reaches: each takes its own credential, never pc_session.
export const NO_CARRIER_LOGIN: Readonly<Record<string, string>> = {
  "POST /api/internal/sweep": "the sweep runner's service token; a browser session is never read",
  "POST /api/internal/desk": "the desk kicker's sweep key (x-sweep-key); a browser session is never read",
  "POST /api/internal/inbound": "the inbound mail poster's service key; a browser session is never read",
  "POST /portal/sign-in": "the fictional broker portal's one-time code, not a carrier login",
};

// GET handlers that write (the QuickBooks link starts and finishes on a redirect). The walker
// treats them as writes; every other GET only reads.
export const WRITING_GETS: readonly string[] = ["GET /api/qbo/connect", "GET /api/qbo/callback"];
