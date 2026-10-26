// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { statusLabel } from "@/lib/format/labels";
import { BADGE_STATUSES, StatusBadge, statusTone } from "./status-badge";

afterEach(cleanup);

describe("StatusBadge", () => {
  it("shows one status from each tone group in words, never the raw code", () => {
    const samples = { draft: "neutral", in_transit: "info", paid: "success", past_due: "warning", cancelled: "destructive" };
    for (const [status, tone] of Object.entries(samples)) {
      expect(statusTone(status)).toBe(tone);
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.textContent).toBe(statusLabel(status));
      expect(container.textContent).not.toContain("_");
      unmount();
    }
    render(<StatusBadge status="cancelled" />);
    expect(screen.getByText("Canceled")).toBeTruthy();
  });

  it("gives every badge status a label with no underscore", () => {
    for (const status of BADGE_STATUSES) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.textContent).toMatch(/^[A-Z][^_]*$/);
      unmount();
    }
  });

  it("shows an unknown status as neutral words", () => {
    render(<StatusBadge status="needs_second_look" />);
    expect(statusTone("needs_second_look")).toBe("neutral");
    expect(screen.getByText("Needs second look")).toBeTruthy();
  });
});
