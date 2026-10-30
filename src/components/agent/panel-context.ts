"use client";

import { createContext, useContext } from "react";

// Opens the agent panel. Kept apart from the panel so the top bar can ask for it without loading
// the chat on a page that has none.
export type PanelControl = { open: () => void };

export const PanelContext = createContext<PanelControl | null>(null);

// The menu's and the top bar's Ask open the panel through this on a page that has one; elsewhere
// (Home, or the switches off) it is null and Ask keeps going to Home's question box.
export function useAgentPanel(): PanelControl | null {
  return useContext(PanelContext);
}
