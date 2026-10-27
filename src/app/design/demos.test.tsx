// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/app/toast";
import { ProposalGallery } from "./demos";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const QUEUED = /advance to .* is queued\./;

function approveTheSample() {
  const approve = screen.getByRole("button", { name: "Approve $200.00" });
  const card = approve.closest<HTMLElement>('[role="article"]')!;
  fireEvent.click(approve);
  fireEvent.click(within(card).getByRole("button", { name: "Confirm" }));
}

describe("ProposalGallery", () => {
  it("shows the queued toast once the sample approval settles", () => {
    render(
      <ToastProvider>
        <ProposalGallery prefix="t-" />
      </ToastProvider>,
    );
    approveTheSample();
    expect(screen.queryByText(QUEUED)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText(QUEUED)).toBeTruthy();
  });

  it("never shows that toast on another page when the reader leaves before it settles", () => {
    const { rerender } = render(
      <ToastProvider>
        <ProposalGallery prefix="t-" />
      </ToastProvider>,
    );
    approveTheSample();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // The provider stays mounted, as it does in the root layout; only the gallery leaves.
    rerender(
      <ToastProvider>
        <p>Another page</p>
      </ToastProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Another page")).toBeTruthy();
    expect(screen.queryByText(QUEUED)).toBeNull();
  });
});
