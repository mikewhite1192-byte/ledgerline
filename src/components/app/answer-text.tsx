import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";

// The agent's answer, as a person reads it. The model writes plain text with a little markdown;
// three things are honored and nothing else: a blank line starts a new paragraph, a line that
// starts with "* " or "- " is a bullet, and **words** are bold. Everything else, HTML and links
// included, stays the literal text it is: React writes every piece as a text node, so a tag in
// the model's words shows as characters and never runs or loads anything.

export type AnswerRun = { text: string; bold: boolean };
// A paragraph's lines, each a row of runs; or one bullet's runs.
export type AnswerBlock = { kind: "paragraph"; lines: AnswerRun[][] } | { kind: "bullet"; runs: AnswerRun[] };

const BULLET = /^[*-][ \t]+(\S.*)$/;
// Bold text starts and ends on a non-space; the shortest such run wins. No lookbehind: older
// Safari cannot parse one, and a regex it cannot parse stops the whole page script from loading.
const BOLD = /\*\*(\S(?:.*?\S)??)\*\*/g;

// One line's runs: the text between pairs of ** is bold; a ** with no partner stays as written.
export function answerRuns(line: string): AnswerRun[] {
  const runs: AnswerRun[] = [];
  let at = 0;
  for (const m of line.matchAll(BOLD)) {
    const start = m.index ?? 0;
    if (start > at) runs.push({ text: line.slice(at, start), bold: false });
    runs.push({ text: m[1], bold: true });
    at = start + m[0].length;
  }
  if (at < line.length) runs.push({ text: line.slice(at), bold: false });
  return runs;
}

// The answer's blocks, in order. Lines are trimmed; empty lines only end a paragraph.
export function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: AnswerRun[][] | null = null;
  const end = () => {
    if (paragraph) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = null;
  };
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") {
      end();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      end();
      blocks.push({ kind: "bullet", runs: answerRuns(bullet[1]) });
      continue;
    }
    (paragraph ??= []).push(answerRuns(line));
  }
  end();
  return blocks;
}

function Runs({ runs }: { runs: AnswerRun[] }): ReactNode {
  return runs.map((r, i) =>
    r.bold ? (
      <strong key={i} className="font-semibold">
        {r.text}
      </strong>
    ) : (
      <Fragment key={i}>{r.text}</Fragment>
    ),
  );
}

// Each block is one paragraph element with the body text style, a bullet included (its dot is
// drawn, not read), so the answer's words sit where the thread has always put them.
export function AnswerText({ text, className }: { text: string; className?: string }) {
  return parseAnswer(text).map((b, i) =>
    b.kind === "paragraph" ? (
      <p key={i} className={cn("max-w-[68ch] text-body text-foreground", className)}>
        {b.lines.map((line, j) => (
          <Fragment key={j}>
            {j > 0 ? <br /> : null}
            <Runs runs={line} />
          </Fragment>
        ))}
      </p>
    ) : (
      <p key={i} className={cn("-mt-1.5 flex max-w-[68ch] gap-2 pl-1 text-body text-foreground", className)}>
        <span aria-hidden className="select-none text-foreground-2">
          •
        </span>
        <span className="min-w-0">
          <Runs runs={b.runs} />
        </span>
      </p>
    ),
  );
}
