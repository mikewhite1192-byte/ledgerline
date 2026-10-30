// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkupView } from "@/lib/documents/types";
import { canTryMarkup, markupBadge } from "./labels";
import { MarkupBlock } from "./markup-block";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const ID = "22222222-2222-4222-8222-222222222222";
const view = (over: Partial<MarkupView> = {}): MarkupView => ({
  status: "none",
  attemptsLeft: 3,
  category: null,
  at: null,
  stalled: false,
  eligibility: "eligible",
  ...over,
});
// The try button (a term's explainer is a button too).
const tryButton = () => screen.queryByRole("button", { name: /^(Mark it on the photo|Try again)/ });
const block = (markup: MarkupView, checkedOn: string | null = null) =>
  render(<MarkupBlock documentId={ID} filename="lumper.png" markup={markup} checkedOn={checkedOn} />);

describe("MarkupBlock", () => {
  it("shows nothing for a list row or a document not read", () => {
    expect(block(view({ eligibility: null })).container.textContent).toBe("");
    cleanup();
    expect(block(view({ eligibility: "not_read" })).container.textContent).toBe("");
  });

  it("offers the first try with what happens next", () => {
    block(view());
    expect(screen.getByRole("button", { name: "Mark it on the photo" })).toBeTruthy();
    expect(screen.getByText("Not made yet")).toBeTruthy();
    expect(document.body.textContent).toContain("it is kept only if every number still matches");
  });

  it("shows a checked copy as a sample picture, never as the source of a number", () => {
    block(view({ status: "checked", attemptsLeft: 2 }), "Oct 27, 2026");
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe(`/api/documents/${ID}/markup/file`);
    expect(img.getAttribute("alt")).toContain("lumper.png");
    expect(document.body.textContent).toContain(
      "Checked Oct 27, 2026 against the record. A sample picture: the numbers on this page come from your records, never from this copy.",
    );
    expect(screen.getByRole("link", { name: "Save image" }).getAttribute("href")).toBe(`/api/documents/${ID}/markup/file`);
    expect(tryButton()).toBeNull();
  });

  it("says a copy that read back wrong was not kept, and offers the tries left", () => {
    block(view({ status: "mismatch", category: "callout_wrong", attemptsLeft: 1 }));
    expect(document.body.textContent).toContain("did not read back the same numbers, so it was not kept. Nothing changed.");
    expect(screen.getByRole("button", { name: "Try again (1 try left)" })).toBeTruthy();
    cleanup();
    block(view({ status: "mismatch", category: "anchor_wrong", attemptsLeft: 0 }));
    expect(tryButton()).toBeNull();
  });

  it("names a wait for budget, a timeout and a copy too large in fixed sentences", () => {
    for (const [category, text] of [
      ["budget", "Waiting for budget. Nothing changed."],
      ["timeout", "The image model did not answer in time. Nothing changed."],
      ["too_large", "The marked copy came back too large to keep. Nothing changed."],
      ["unknown", "Could not make the marked copy this time. Nothing changed."],
    ] as const) {
      block(view({ status: "unavailable", category }));
      expect(document.body.textContent).toContain(text);
      cleanup();
    }
  });

  it("shows a running try without a button, and a stalled one with a retry", () => {
    block(view({ status: "marking", attemptsLeft: 2 }));
    expect(screen.getByText("Marking the photo")).toBeTruthy();
    expect(tryButton()).toBeNull();
    cleanup();
    block(view({ status: "marking", attemptsLeft: 2, stalled: true }));
    expect(document.body.textContent).toContain("The last try did not finish.");
    expect(screen.getByRole("button", { name: "Try again (2 tries left)" })).toBeTruthy();
  });

  it("explains a document with nothing to mark, without a button", () => {
    block(view({ eligibility: "not_image" }));
    expect(document.body.textContent).toContain("This document is a PDF");
    expect(tryButton()).toBeNull();
  });

  it("shows a refusal's own sentence, never the server's text, and reads the page again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "budget" }), { status: 503, headers: { "content-type": "application/json" } })),
    );
    block(view());
    fireEvent.click(screen.getByRole("button", { name: "Mark it on the photo" }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Waiting for budget. Nothing changed."));
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "the vendor said no" }), { status: 503 })),
    );
    block(view());
    fireEvent.click(screen.getByRole("button", { name: "Mark it on the photo" }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Could not start the marked copy."));
    expect(document.body.textContent).not.toContain("the vendor said no");
  });
});

describe("markup labels", () => {
  it("names each state and offers a try only when one can start", () => {
    expect(markupBadge(view({ status: "checked" }))).toEqual({ label: "Checked", tone: "success" });
    expect(markupBadge(view({ status: "marking", stalled: true })).label).toBe("Did not finish");
    expect(markupBadge(view({ status: "unavailable", category: "budget" })).label).toBe("Waiting for budget");
    expect(canTryMarkup(view())).toBe(true);
    expect(canTryMarkup(view({ status: "checked" }))).toBe(false);
    expect(canTryMarkup(view({ status: "marking" }))).toBe(false);
    expect(canTryMarkup(view({ status: "marking", stalled: true }))).toBe(true);
    expect(canTryMarkup(view({ attemptsLeft: 0, status: "mismatch" }))).toBe(false);
    expect(canTryMarkup(view({ eligibility: "agrees" }))).toBe(false);
  });
});
