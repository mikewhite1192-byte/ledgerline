// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { journeyEvents, journeyStepsOf, boardRowOf } from "@/lib/journey/steps";
import { atAdvanceCard, fullChain, LOAD_ID, OPTS, ZONE } from "@/lib/journey/test-fixtures";
import { CountUp } from "./count-up";
import { JourneySteps } from "./journey-steps";
import { RoadBoard, RoadStream } from "./road-board";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const moving = () => journeyStepsOf(atAdvanceCard(), OPTS);
const paid = () => {
  const f = atAdvanceCard();
  const full = fullChain();
  return journeyStepsOf({ ...f, card: full.card, advance: full.advance, advanceMoney: full.advanceMoney.slice(0, 1) }, OPTS);
};
const view = (steps: ReturnType<typeof moving>) => (
  <JourneySteps steps={steps} loadId={LOAD_ID} loadNumber="L-20417" documentsOn />
);

describe("JourneySteps motion", () => {
  it("shows a page opened mid-journey still: no step animates on the first render", () => {
    const { container } = render(view(moving()));
    expect(container.querySelectorAll("[data-motion]")).toHaveLength(0);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Advance paid");
  });

  it("animates a step once when it turns done, and never again on a refresh where nothing moved", () => {
    const { container, rerender } = render(view(moving()));
    rerender(view(paid()));
    const paidRow = container.querySelector('li[data-state="done"]:nth-child(3)');
    expect(paidRow?.querySelector(".animate-step-fill")).not.toBeNull();
    expect(paidRow?.querySelector(".animate-step-glow")).not.toBeNull();
    expect(paidRow?.querySelector(".animate-step-line")).not.toBeNull();
    // The first two steps were already done: they stay still.
    expect(container.querySelectorAll(".animate-step-fill")).toHaveLength(1);
    rerender(view(paid()));
    expect(container.querySelectorAll("[data-motion]")).toHaveLength(0);
  });

  it("ends every amount on the stored figure", () => {
    const { container } = render(view(journeyStepsOf(fullChain(), OPTS)));
    const text = container.textContent ?? "";
    expect(text).toContain("$150.00");
    expect(text).toContain("$2,095.00");
    expect(text).toContain("5 days at $11.00 a day");
    expect(text).toContain("Read by Muse Spark");
    expect(text).toContain("Matched to load L-20417");
  });

  it("names a document not read yet by its read status, never as read by the model", () => {
    const f = atAdvanceCard();
    const doc = f.moves[0].document!;
    f.moves = [{ ...f.moves[0], document: { ...doc, readStatus: "pending", stalled: false, read: null, match: null } }];
    const { container } = render(view(journeyStepsOf(f, OPTS)));
    const text = container.textContent ?? "";
    expect(text).not.toContain("Read by Muse Spark");
    expect(text).toContain("Not read yet, so nothing was matched.");
  });
});

describe("CountUp", () => {
  it("counts a fresh amount up over frames and ends on the stored figure exactly", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { container } = render(<CountUp cents={209_500} run />);
    expect(container.textContent).toBe("$0.00");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const mid = container.textContent;
    expect(mid).not.toBe("$0.00");
    expect(mid).not.toBe("$2,095.00");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toBe("$2,095.00");
  });

  it("shows the stored figure at once when the step is not fresh", () => {
    const { container } = render(<CountUp cents={209_500} run={false} />);
    expect(container.textContent).toBe("$2,095.00");
  });
});

describe("RoadBoard and RoadStream motion", () => {
  it("fills a strip dot once when its step turns done, and slides a new stream line in once", () => {
    const before = atAdvanceCard();
    const rowOf = (steps: ReturnType<typeof moving>) => boardRowOf(before, steps, { zone: ZONE, now: 0 });
    const board = render(<RoadBoard rows={[rowOf(moving())]} />);
    expect(board.container.querySelectorAll("[data-motion]")).toHaveLength(0);
    board.rerender(<RoadBoard rows={[rowOf(paid())]} />);
    expect(board.container.querySelectorAll(".animate-step-fill")).toHaveLength(1);
    board.rerender(<RoadBoard rows={[rowOf(paid())]} />);
    expect(board.container.querySelectorAll("[data-motion]")).toHaveLength(0);

    const linesOf = (steps: ReturnType<typeof moving>) => journeyEvents([{ facts: before, steps }], ZONE);
    const stream = render(<RoadStream lines={linesOf(moving())} />);
    expect(stream.container.querySelectorAll(".animate-slide-in")).toHaveLength(0);
    stream.rerender(<RoadStream lines={linesOf(paid())} />);
    expect(stream.container.querySelectorAll(".animate-slide-in")).toHaveLength(1);
    stream.rerender(<RoadStream lines={linesOf(paid())} />);
    expect(stream.container.querySelectorAll(".animate-slide-in")).toHaveLength(0);
  });
});
