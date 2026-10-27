// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerText, answerRuns, parseAnswer } from "./answer-text";

afterEach(cleanup);

function shown(text: string): HTMLElement {
  const { container } = render(
    <div>
      <AnswerText text={text} />
    </div>,
  );
  return container.firstElementChild as HTMLElement;
}

describe("parseAnswer", () => {
  it("splits paragraphs on blank lines and keeps single line breaks inside one", () => {
    expect(parseAnswer("First line.\nSame paragraph.\n\nSecond paragraph.")).toEqual([
      {
        kind: "paragraph",
        lines: [[{ text: "First line.", bold: false }], [{ text: "Same paragraph.", bold: false }]],
      },
      { kind: "paragraph", lines: [[{ text: "Second paragraph.", bold: false }]] },
    ]);
  });

  it("makes a bullet of each line that starts with a star or a dash and a space", () => {
    const blocks = parseAnswer("Three drivers:\n* Kevin, $682.75\n- Ellen, $483.71\n*not a bullet*");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "bullet", "bullet", "paragraph"]);
    expect(blocks[1]).toEqual({ kind: "bullet", runs: [{ text: "Kevin, $682.75", bold: false }] });
    expect(blocks[3]).toEqual({ kind: "paragraph", lines: [[{ text: "*not a bullet*", bold: false }]] });
  });

  it("returns nothing for empty text", () => {
    expect(parseAnswer("")).toEqual([]);
    expect(parseAnswer("\n \n")).toEqual([]);
  });
});

describe("answerRuns", () => {
  it("bolds the words between pairs of double stars", () => {
    expect(answerRuns("Pay **Kevin** first, then **Ellen**.")).toEqual([
      { text: "Pay ", bold: false },
      { text: "Kevin", bold: true },
      { text: " first, then ", bold: false },
      { text: "Ellen", bold: true },
      { text: ".", bold: false },
    ]);
  });

  it("leaves a double star with no partner, or with spaces inside, as written", () => {
    expect(answerRuns("2 ** 3 is not bold")).toEqual([{ text: "2 ** 3 is not bold", bold: false }]);
    expect(answerRuns("** spaced **")).toEqual([{ text: "** spaced **", bold: false }]);
  });
});

describe("AnswerText", () => {
  it("renders paragraphs, bullets and bold as body text the thread already styles", () => {
    const root = shown("Three drivers need a look:\n\n* **Kevin Yarborough (BR-D04)** is short $682.75\n* Ellen is short $483.71\n\nNothing was paid.");
    const paragraphs = [...root.querySelectorAll(":scope > p.text-body")];
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      "Three drivers need a look:",
      "•Kevin Yarborough (BR-D04) is short $682.75",
      "•Ellen is short $483.71",
      "Nothing was paid.",
    ]);
    expect(root.querySelector("strong")?.textContent).toBe("Kevin Yarborough (BR-D04)");
    // The drawn dot is not read aloud.
    expect(paragraphs[1].querySelector("[aria-hidden]")?.textContent).toBe("•");
    expect(root.textContent).not.toContain("* ");
  });

  it("shows HTML in the model's text as the characters it is and never runs it", () => {
    const attack = 'Hi <script>alert(1)</script> and <img src=x onerror=alert(1)> and <a href="https://evil.example">x</a>';
    const root = shown(attack);
    expect(root.querySelector("script, img, a, iframe")).toBeNull();
    expect(root.textContent).toBe(attack);
    // Inside a bullet and inside bold too.
    const nested = shown("* **<img src=x onerror=alert(1)>**");
    expect(nested.querySelector("img")).toBeNull();
    expect(nested.querySelector("strong")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps a markdown link as plain text, with no link to follow", () => {
    const root = shown("See [the invoice](https://evil.example/pay) or [home](/invoices).");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toBe("See [the invoice](https://evil.example/pay) or [home](/invoices).");
  });

  it("is never built from raw HTML", () => {
    for (const file of ["answer-text.tsx", "chat-thread.tsx"]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
