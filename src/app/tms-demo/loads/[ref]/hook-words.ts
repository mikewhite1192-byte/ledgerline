import type { HookResult } from "@/lib/mock-tms/hook";

// The webhook's last answer as a fixed sentence. Plain module (no "use client"), so the server
// page and the client forms both call it.
export const HOOK_WORDS: Record<string, string> = {
  sent: "LedgerLine was told about the change.",
  hook_off: "The webhook is switched off; LedgerLine finds the change on its next read.",
  not_configured: "The webhook is not set up here; LedgerLine finds the change on its next read.",
  timeout: "The webhook did not answer in time; LedgerLine finds the change on its next read.",
  unreachable: "The webhook could not be reached; LedgerLine finds the change on its next read.",
};

export function hookWords(result: HookResult | string): string {
  return HOOK_WORDS[result] ?? "The webhook refused the call; LedgerLine finds the change on its next read.";
}
