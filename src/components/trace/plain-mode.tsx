"use client";

import { createContext, useContext, type ReactNode } from "react";

// The plain trace (flags.plainTrace), read once on the server by the shell and handed down, so a
// trace panel or a card anywhere under it (the page, the agent's card) reads it with no prop chain.
// Off by default: outside the shell, and with the switch off, everything renders as before.
const PlainMode = createContext(false);

export function PlainModeProvider({ plain, children }: { plain: boolean; children: ReactNode }) {
  return <PlainMode.Provider value={plain}>{children}</PlainMode.Provider>;
}

export function usePlainMode(): boolean {
  return useContext(PlainMode);
}
