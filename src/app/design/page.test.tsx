// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/app/toast";
import DesignPage from "./page";

afterEach(cleanup);

const SECTION_HEADINGS = [
  "Identity",
  "Tokens",
  "Type",
  "Money",
  "Buttons",
  "Fields",
  "Badges",
  "Stat cards",
  "Data table",
  "Proposal card",
  "Chat thread",
  "Paystub",
  "States",
  "Toasts",
  "Sheet",
  "Carrier menu",
  "Source records",
];

describe("/design", () => {
  it("renders every section, in both modes, with no configuration at all", () => {
    const saved = process.env;
    process.env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    try {
      render(
        <ToastProvider>
          <DesignPage />
        </ToastProvider>,
      );
    } finally {
      process.env = saved;
    }
    for (const name of SECTION_HEADINGS) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.id)).toEqual(
      expect.arrayContaining(["identity-title", "source-records-title"]),
    );
    expect(document.querySelectorAll('[data-theme="light"]').length).toBeGreaterThanOrEqual(SECTION_HEADINGS.length);
    expect(document.querySelectorAll('[data-theme="dark"]').length).toBeGreaterThanOrEqual(SECTION_HEADINGS.length);
  });

  it("lands every sample record link on a row of the source table", () => {
    render(
      <ToastProvider>
        <DesignPage />
      </ToastProvider>,
    );
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="#light-source-"], a[href^="#dark-source-"]'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      const id = decodeURIComponent(a.getAttribute("href")!.slice(1));
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});
