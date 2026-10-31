"use client";

import { createContext, useContext } from "react";

// What a page can ask the card to open with: text for the question box (the person sends it) and
// the help line under it.
export type OpenRequest = { draft?: string; help?: string };

// One of the ways Home is asked to open the card as it loads, else undefined (the card stays closed).
export type AgentOpening = OpenRequest & {
  // ?new=1 (the demo banner's Start over): leave the newest conversation and start empty.
  fresh?: boolean;
};

// Opens the agent card. Kept apart from the card so the top bar can ask for it without loading
// the chat on a page that has none.
export type PanelControl = { open: (opts?: OpenRequest) => void };

export const PanelContext = createContext<PanelControl | null>(null);

// The menu's and the top bar's Ask open the card through this on a page that has one; elsewhere
// (the agent off, or the /design specimen) it is null and Ask is a plain link to Home.
export function useAgentPanel(): PanelControl | null {
  return useContext(PanelContext);
}
