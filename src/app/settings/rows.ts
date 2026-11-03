import { appNav } from "@/components/app/app-nav";
import { flags } from "@/config/flags";

export const MODELS_HREF = "/models";
export const AUTOPILOT_HREF = "/settings/autopilot";

// One plain line under each settings page's name. A settings page with no line here is still
// listed, with its name only (the test checks every one has a line).
export const SETTINGS_HELP: Readonly<Record<string, string>> = {
  "/settings/pay-rules": "What you pay and take out for each driver, by the week it started.",
  [AUTOPILOT_HREF]: "Which kinds of work are approved for you, and up to what amount.",
  "/settings/accounting": "The QuickBooks company your invoices and payments go to.",
  "/settings/rates": "The fuel prices and tax rates your pay and invoices use.",
  "/memory": "Short notes about your customers, drivers and how you like things done.",
  "/portal-runs": "Times a broker's website was read for check-in times and signed paperwork.",
  "/settings/demo": "Start the demo carrier over with fresh made-up data.",
  [MODELS_HREF]: "Every question's work, step by step, and the spend so far.",
};

export type SettingsRow = { href: string; label: string; help?: string };

// The settings pages from the menu, each only while its own switch is on, in the menu's order,
// with Autopilot after Pay rules while its page is on (it has no menu row of its own). Models and
// spend comes back on its own, to sit last under its own line.
export function settingsRows(): { rows: SettingsRow[]; models: SettingsRow | null } {
  const pages = appNav("/settings")
    .filter((i) => i.section === "settings" && i.sectionOrder !== 0)
    .sort((a, b) => (a.sectionOrder ?? 0) - (b.sectionOrder ?? 0))
    .map((i) => ({ href: i.href, label: i.sectionLabel ?? i.label, help: SETTINGS_HELP[i.href] }));
  const rows = pages.filter((r) => r.href !== MODELS_HREF);
  if (flags.autopilotRules.enabled === true) {
    const at = rows.findIndex((r) => r.href === "/settings/pay-rules");
    rows.splice(at + 1, 0, { href: AUTOPILOT_HREF, label: "Autopilot", help: SETTINGS_HELP[AUTOPILOT_HREF] });
  }
  return { rows, models: pages.find((r) => r.href === MODELS_HREF) ?? null };
}
