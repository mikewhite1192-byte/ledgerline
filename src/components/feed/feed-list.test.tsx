// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedLine } from "@/lib/feed/words";
import { FeedList } from "./feed-list";

afterEach(() => cleanup());

const AT = "2026-11-02T16:00:00.000000Z";
const ID = "00000000-0000-4000-8000-000000000001";

function line(at: string, key: string, words: string): FeedLine {
  return { key, at, time: at, actor: "Desk", words, tag: null, href: null };
}

describe("FeedList", () => {
  it("marks a line New when it sorts after the first line shown, a later key at the same instant too", () => {
    const first = line(AT, `desk:${ID}`, "First");
    const view = render(<FeedList lines={[first]} markNew />);
    expect(screen.queryByText("New")).toBeNull();

    const sameInstant = line(AT, `proposal:${ID}:proposed`, "Same instant");
    const earlierKey = line(AT, `batch:${ID}:started`, "Earlier key");
    view.rerender(<FeedList lines={[sameInstant, first, earlierKey]} markNew />);
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(screen.getByText("Same instant").parentElement?.textContent).toContain("New");
  });
});
