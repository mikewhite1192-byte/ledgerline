"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Role } from "@/lib/roles";

// The signed-in person's role, from the page's own membership read (no new fetch), so a card can
// show a demo visitor the staff-only line instead of a confirm. Display only: every write route
// checks the role again on the server (src/lib/auth/staff-gate.ts).
const ViewerRole = createContext<Role>("staff");

export function ViewerRoleProvider({ role, children }: { role: Role; children: ReactNode }) {
  return <ViewerRole.Provider value={role}>{children}</ViewerRole.Provider>;
}

export function useViewerRole(): Role {
  return useContext(ViewerRole);
}
