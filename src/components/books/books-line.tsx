import { InlineAlert } from "@/components/ui/inline-alert";
import type { BooksLine } from "@/lib/books/status";

// Where a record stands in QuickBooks, on its record page (src/lib/books/status.ts writes the
// words). There is no button: the books step posts by itself, and a person is asked only when it
// still fails after its tries.
export function BooksStatusLine({ line }: { line: BooksLine }) {
  if (line.state === "needs_person") return <InlineAlert tone="warning">{line.text}</InlineAlert>;
  return (
    <p className="text-small text-foreground-2" data-books={line.state}>
      {line.text}
    </p>
  );
}
