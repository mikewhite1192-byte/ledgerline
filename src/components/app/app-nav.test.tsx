// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { appNav, NAV_HREFS, type NavKey } from "./app-nav";
import * as registry from "./nav/items";
import { MENU_GROUPS } from "./nav/menu-item";
import { NavList } from "./nav-list";
import { HOW_PAY_WORKS } from "./signed-in-page";

const SWITCHES = [
  "sweepEnabled",
  "settlementsEnabled",
  "driverNotesEnabled",
  "advancesEnabled",
  "invoicesEnabled",
  "customerPaymentsEnabled",
  "collectionsEnabled",
  "cashFridayEnabled",
  "documentsEnabled",
  "voiceIntakeEnabled",
  "clipsEnabled",
  "accountingEnabled",
  "portalRunnerEnabled",
  "demoResetEnabled",
  "rulesByTalkingEnabled",
  "profitBriefEnabled",
  "carrierMemoryEnabled",
  "quarterReviewEnabled",
] as const;
type Switch = (typeof SWITCHES)[number];

const saved = Object.fromEntries(SWITCHES.map((s) => [s, flags[s]])) as Record<Switch, boolean>;
// A feature whose switch sits inside its own settings block.
const savedCardRecon = flags.cardRecon.enabled;
afterEach(() => {
  for (const s of SWITCHES) flags[s] = saved[s];
  flags.cardRecon.enabled = savedCardRecon;
  cleanup();
});

function setAll(on: boolean) {
  for (const s of SWITCHES) flags[s] = on;
  flags.cardRecon.enabled = on;
}

const shape = (current: NavKey) => appNav(current).map((i) => [i.group, i.href, i.label, i.current ?? false]);

describe("appNav", () => {
  it("lists every item, grouped by job and in order, when every switch is on", () => {
    setAll(true);
    expect(shape("/invoices")).toEqual([
      ["Today", "/", "Home", false],
      ["Today", "/profit", "Profit brief", false],
      ["Today", "/quarter", "Quarter review", false],
      ["Pay", "/sweep", "Pay sweep", false],
      ["Pay", "/settlements", "Settlements", false],
      ["Pay", "/driver-notes", "Driver notes", false],
      ["Pay", "/advances", "Advances", false],
      ["Pay", "/cards", "Card check", false],
      ["Money in", "/invoices", "Invoices", true],
      ["Money in", "/customer-payments/new", "Payments", false],
      ["Money in", "/collections", "Collections", false],
      ["Money in", "/cash", "Cash", false],
      ["Drivers", "/documents", "Documents", false],
      ["Drivers", "/voice-notes", "Voice notes", false],
      ["Drivers", "/clips", "Dock clips", false],
      ["Settings", "/settings/accounting", "QuickBooks", false],
      ["Settings", "/settings/pay-rules", "Pay rules", false],
      ["Settings", "/models", "Models and spend", false],
      ["Settings", "/portal-runs", "Portal runs", false],
      ["Settings", "/settings/demo", "Demo", false],
      ["Settings", "/memory", "Memory", false],
    ]);
  });

  it("keeps Home and Models and spend when every switch is off", () => {
    setAll(false);
    expect(shape("/models")).toEqual([
      ["Today", "/", "Home", false],
      ["Settings", "/models", "Models and spend", true],
    ]);
  });

  it("shows each switched item only while its own switch is on", () => {
    const behind: Record<Switch, string> = {
      sweepEnabled: "/sweep",
      settlementsEnabled: "/settlements",
      driverNotesEnabled: "/driver-notes",
      advancesEnabled: "/advances",
      invoicesEnabled: "/invoices",
      customerPaymentsEnabled: "/customer-payments/new",
      collectionsEnabled: "/collections",
      cashFridayEnabled: "/cash",
      documentsEnabled: "/documents",
      voiceIntakeEnabled: "/voice-notes",
      clipsEnabled: "/clips",
      accountingEnabled: "/settings/accounting",
      portalRunnerEnabled: "/portal-runs",
      demoResetEnabled: "/settings/demo",
      rulesByTalkingEnabled: "/settings/pay-rules",
      profitBriefEnabled: "/profit",
      carrierMemoryEnabled: "/memory",
      quarterReviewEnabled: "/quarter",
    };
    for (const s of SWITCHES) {
      setAll(true);
      flags[s] = false;
      expect(appNav("none").map((i) => i.href)).not.toContain(behind[s]);
      flags[s] = true;
      expect(appNav("none").map((i) => i.href)).toContain(behind[s]);
    }
    setAll(true);
    flags.cardRecon.enabled = false;
    expect(appNav("none").map((i) => i.href)).not.toContain("/cards");
    flags.cardRecon.enabled = true;
    expect(appNav("none").map((i) => i.href)).toContain("/cards");
  });

  it("marks no item current on a page with no item", () => {
    setAll(true);
    expect(appNav("none").some((i) => i.current)).toBe(false);
  });
});

// Each item is its own file plus one line in the index, so two features never edit the same lines.
// Where an item shows comes from its own fields; the full-order test above proves the index's
// alphabetical lines do not decide it.
describe("the menu registry", () => {
  const itemsDir = path.join(process.cwd(), "src", "components", "app", "nav", "items");
  const items = Object.values(registry);

  it("lists every item file in the index once, one line each, sorted by file name", () => {
    const files = readdirSync(itemsDir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => f.replace(/\.tsx$/, ""))
      .sort();
    const lines = readFileSync(path.join(itemsDir, "index.ts"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("//"));
    const listed = lines.map((line) => /^export \{ \w+ \} from "\.\/([a-z0-9-]+)";$/.exec(line)?.[1] ?? `bad line: ${line}`);
    expect(listed).toEqual(files);
    expect(items).toHaveLength(files.length);
  });

  it("never gives two items the same address or the same place in a group", () => {
    const hrefs = items.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const places = items.map((i) => `${i.group}:${i.order}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it("puts every item in a known group at a whole-number place", () => {
    for (const item of items) {
      expect(MENU_GROUPS, item.href).toContain(item.group);
      expect(Number.isInteger(item.order) && item.order > 0, item.href).toBe(true);
    }
  });
});

describe("NavList", () => {
  it("prints each group's header once, before its items, and marks the current page", () => {
    setAll(true);
    render(<NavList items={appNav("/advances")} />);
    const pay = screen.getByRole("list", { name: "Pay" });
    expect(Array.from(pay.querySelectorAll("a")).map((a) => a.textContent)).toEqual(["Pay sweep", "Settlements", "Driver notes", "Advances", "Card check"]);
    expect(screen.getByRole("link", { name: "Advances" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getAllByText("Money in")).toHaveLength(1);
  });

  it("prints no header for a group whose items are all switched off", () => {
    setAll(true);
    flags.invoicesEnabled = false;
    flags.customerPaymentsEnabled = false;
    flags.collectionsEnabled = false;
    flags.cashFridayEnabled = false;
    render(<NavList items={appNav("/")} />);
    expect(screen.queryByText("Money in")).toBeNull();
    expect(screen.queryByRole("list", { name: "Money in" })).toBeNull();
    expect(screen.getByRole("list", { name: "Drivers" })).toBeTruthy();
  });

  it("renders a list with no groups as one plain list, as before", () => {
    render(
      <NavList
        items={[
          { href: "/a", label: "A", icon: null },
          { href: "/b", label: "B", icon: null, current: true },
        ]}
      />,
    );
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "B" }).getAttribute("aria-current")).toBe("page");
  });
});

// Every page a person can open from the app is either a menu item or linked from one, so a page
// never goes missing from the menu. Record pages ([id]) are reached from the lists and answers;
// /sign-in, /design and the stand-in broker portal are not part of the signed-in app; /help shows
// nothing of its own and only sends on to the help page under the menu.
describe("every signed-in page is reachable", () => {
  const appDir = path.join(process.cwd(), "src", "app");

  function pages(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return pages(full);
      return entry.name === "page.tsx" ? [full] : [];
    });
  }

  const routeOf = (file: string) => {
    const rel = path.relative(appDir, path.dirname(file)).split(path.sep).join("/");
    return rel === "" ? "/" : `/${rel}`;
  };

  const routes = pages(appDir)
    .map(routeOf)
    .filter((r) => r !== "/sign-in" && r !== "/design" && r !== "/help" && r !== "/portal" && !r.startsWith("/portal/"))
    .filter((r) => !r.includes("["));

  const itemPage = (href: string) => {
    const file = path.join(appDir, ...href.split("/").filter(Boolean), "page.tsx");
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };

  it("finds the routes it guards", () => {
    expect(routes).toEqual(expect.arrayContaining(["/", "/models", "/settings/accounting", "/settings/demo", "/advances/new"]));
  });

  // The help link sits under the menu on every signed-in page (SignedInPage, and Home's shell).
  const shellLinks = [HOW_PAY_WORKS.href];

  it("reaches each route from the menu or from a menu item's page", () => {
    const unreachable = routes.filter(
      (route) =>
        !NAV_HREFS.includes(route) &&
        !shellLinks.includes(route) &&
        !NAV_HREFS.some((href) => itemPage(href).includes(`href="${route}"`)),
    );
    expect(unreachable).toEqual([]);
  });

  it("puts the help link under Home's menu too (Home builds its own shell)", () => {
    expect(itemPage("/")).toContain("help={HOW_PAY_WORKS}");
  });

  it("points every menu item at a page that exists", () => {
    for (const href of NAV_HREFS) expect(itemPage(href), href).not.toBe("");
  });
});
