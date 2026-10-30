// The agent routes' session. getSession() reads the database for a demo visit (the pc_demo
// cookie: the subject's role and whether the visit is live, src/lib/auth/session.ts), so agent
// code outside the gateway reaches it through here, the one sanctioned path to the database.
export { getSession } from "@/lib/auth/session";
