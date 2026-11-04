// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { appNav, NAV_HREFS, type NavKey } from "./app-nav";
import * as registry from "./nav/items";
import { MENU_AREAS, MENU_GROUPS, MENU_SECTIONS } from "./nav/menu-item";
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
  "groundedRatesEnabled",
  "quarterReviewEnabled",
] as const;
type Switch = (typeof SWITCHES)[number];

const saved = Object.fromEntries(SWITCHES.map((s) => [s, flags[s]])) as Record<Switch, boolean>;
// Features whose switch sits inside its own settings block.
const savedCardRecon = flags.cardRecon.enabled;
const savedFactoring = flags.factoring.enabled;
const savedMoneyCodes = flags.moneyCodes.enabled;
const savedActivityFeed = flags.activityFeed.enabled;
const savedJourney = flags.journey.enabled;
const savedSimple = flags.simpleShape.enabled;
// Written for the full menu; the five-word menu's tests turn its switch on.
beforeEach(() => {
  flags.simpleShape.enabled = false;
});
afterEach(() => {
  flags.simpleShape.enabled = savedSimple;
  for (const s of SWITCHES) flags[s] = saved[s];
  flags.cardRecon.enabled = savedCardRecon;
  flags.factoring.enabled = savedFactoring;
  flags.moneyCodes.enabled = savedMoneyCodes;
  flags.activityFeed.enabled = savedActivityFeed;
  flags.journey.enabled = savedJourney;
  cleanup();
});

function setAll(on: boolean) {
  for (const s of SWITCHES) flags[s] = on;
  flags.cardRecon.enabled = on;
  flags.factoring.enabled = on;
  flags.moneyCodes.enabled = on;
  flags.activityFeed.enabled = on;
  flags.journey.enabled = on;
}

const shape = (current: NavKey) => appNav(current).map((i) => [i.group, i.href, i.label, i.current ?? false]);

describe("appNav", () => {
  it("lists every item, grouped by job and in order, when every switch is on", () => {
    setAll(true);
    expect(shape("/invoices")).toEqual([
      ["Today", "/", "Home", false],
      ["Today", "/activity", "Live feed", false],
      ["Today", "/road", "On the road", false],
      ["Today", "/profit", "Profit brief", false],
      ["Today", "/quarter", "Quarter review", false],
      ["Pay", "/sweep", "Pay check", false],
      ["Pay", "/settlements", "Pay", false],
      ["Pay", "/driver-notes", "Driver notes", false],
      ["Pay", "/advances", "Advances", false],
      ["Pay", "/money-codes", "Driver codes", false],
      ["Pay", "/cards", "Card charges", false],
      ["Money in", "/invoices", "Invoices", true],
      ["Money in", "/customer-payments/new", "Payments", false],
      ["Money in", "/collections", "Collections", false],
      ["Money in", "/cash", "Cash", false],
      ["Money in", "/factoring", "Factoring", false],
      ["Drivers", "/drivers", "Drivers", false],
      ["Drivers", "/documents", "Documents", false],
      ["Drivers", "/voice-notes", "Voice notes", false],
      ["Drivers", "/clips", "Dock videos", false],
      ["Settings", "/settings/accounting", "QuickBooks", false],
      ["Settings", "/settings/pay-rules", "Pay rules", false],
      ["Settings", "/models", "Models and spend", false],
      ["Settings", "/portal-runs", "Portal runs", false],
      ["Settings", "/settings/demo", "Demo", false],
      ["Settings", "/settings/rates", "Fuel and tax rates", false],
      ["Settings", "/memory", "Memory", false],
    ]);
  });

  it("keeps Home, Drivers and Models and spend when every switch is off", () => {
    setAll(false);
    expect(shape("/models")).toEqual([
      ["Today", "/", "Home", false],
      ["Drivers", "/drivers", "Drivers", false],
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
      groundedRatesEnabled: "/settings/rates",
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
    flags.factoring.enabled = false;
    expect(appNav("none").map((i) => i.href)).not.toContain("/factoring");
    flags.factoring.enabled = true;
    expect(appNav("none").map((i) => i.href)).toContain("/factoring");
    flags.journey.enabled = false;
    expect(appNav("none").map((i) => i.href)).not.toContain("/road");
    flags.journey.enabled = true;
    expect(appNav("none").map((i) => i.href)).toContain("/road");
  });

  it("lists the Settings page only under the simple shape, where it is the fifth word's own page", () => {
    setAll(true);
    flags.simpleShape.enabled = false;
    expect(appNav("none").map((i) => i.href)).not.toContain("/settings");
    flags.simpleShape.enabled = true;
    const item = appNav("/settings").find((i) => i.href === "/settings");
    expect(item && [item.section, item.sectionOrder, item.current]).toEqual(["settings", 0, true]);
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

  it("gives every item an area, and only Home sits above the tabs", () => {
    for (const item of items) expect([...MENU_AREAS, "primary"], item.href).toContain(item.area);
    const byArea = (area: string) =>
      items
        .filter((i) => i.area === area)
        .map((i) => i.label)
        .sort();
    expect(byArea("primary")).toEqual(["Home"]);
    expect(byArea("pay")).toEqual(
      [
        "Advances",
        "Card charges",
        "Documents",
        "Dock videos",
        "Driver notes",
        "Drivers",
        "Live feed",
        "On the road",
        "Driver codes",
        "Pay check",
        "Pay",
        "Voice notes",
      ].sort(),
    );
    expect(byArea("billing")).toEqual(["Cash", "Collections", "Factoring", "Invoices", "Payments"].sort());
    expect(byArea("books")).toEqual(
      [
        "Demo",
        "Fuel and tax rates",
        "Memory",
        "Models and spend",
        "Pay rules",
        "Portal runs",
        "Profit brief",
        "QuickBooks",
        "Quarter review",
        "Settings",
      ].sort(),
    );
  });

  // The simple shape's five words (design-simple-shape.md section 2): every item sits under one,
  // in the design's order, with the renamed pages under their new names.
  it("and a section, every item placed once, in order", () => {
    for (const item of items) {
      expect(MENU_SECTIONS, item.href).toContain(item.section);
      expect(Number.isInteger(item.sectionOrder) && item.sectionOrder >= 0, item.href).toBe(true);
    }
    const places = items.map((i) => `${i.section}:${i.sectionOrder}`);
    expect(new Set(places).size).toBe(places.length);
    const under = (section: string) =>
      items
        .filter((i) => i.section === section)
        .sort((a, b) => a.sectionOrder - b.sectionOrder)
        .map((i) => [i.href, ("sectionLabel" in i ? i.sectionLabel : undefined) ?? i.label]);
    expect(under("home")).toEqual([
      ["/", "Home"],
      ["/activity", "Live feed"],
      ["/road", "On the road"],
    ]);
    expect(under("pay")).toEqual([
      ["/settlements", "Paystubs"],
      ["/sweep", "Pay check"],
      ["/advances", "Advances"],
      ["/driver-notes", "Driver notes"],
      ["/money-codes", "Driver codes"],
      ["/cards", "Card charges"],
      ["/cash", "Friday's cash"],
    ]);
    expect(under("billing")).toEqual([
      ["/invoices", "Invoices"],
      ["/collections", "Collections"],
      ["/customer-payments/new", "Payments"],
      ["/factoring", "Factoring"],
      ["/profit", "Profit brief"],
      ["/quarter", "Quarter review"],
    ]);
    expect(under("drivers")).toEqual([
      ["/drivers", "Drivers"],
      ["/documents", "Documents"],
      ["/voice-notes", "Voice notes"],
      ["/clips", "Dock videos"],
    ]);
    expect(under("settings")).toEqual([
      ["/settings", "Settings"],
      ["/settings/pay-rules", "Pay rules"],
      ["/settings/accounting", "QuickBooks"],
      ["/settings/rates", "Fuel and tax rates"],
      ["/memory", "Memory"],
      ["/portal-runs", "Portal runs"],
      ["/settings/demo", "Demo"],
      ["/models", "Models and spend"],
    ]);
    // Only Home and Settings are a section's own page.
    expect(items.filter((i) => i.sectionOrder === 0).map((i) => i.href).sort()).toEqual(["/", "/settings"]);
  });
});

describe("NavList", () => {
  it("prints each group's header once, before its items, and marks the current page", () => {
    setAll(true);
    render(<NavList items={appNav("/advances")} />);
    const pay = screen.getByRole("list", { name: "Pay" });
    expect(Array.from(pay.querySelectorAll("a")).map((a) => a.textContent)).toEqual(["Pay check", "Pay", "Driver notes", "Advances", "Driver codes", "Card charges"]);
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
    flags.factoring.enabled = false;
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
// /sign-in, /design, the stand-in broker portal and the sample dispatch system (/tms-demo, its own
// shell with no app menu) are not part of the signed-in app; /help shows
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
    .filter((r) => r !== "/tms-demo" && !r.startsWith("/tms-demo/"))
    // The short wait while a visit's own copy is set up: reached only from the demo sign-in.
    .filter((r) => r !== "/preparing")
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
    expect(routes).toEqual(
      expect.arrayContaining(["/", "/models", "/settings", "/settings/accounting", "/settings/demo", "/advances/new"]),
    );
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
