"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InlineAlert } from "@/components/ui/inline-alert";

// The upload card's form. One file goes up as multipart to /api/documents; the reply is a
// category, shown as a fixed sentence. On success the page opens the document.

export const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp,application/pdf";

const MESSAGES: Record<string, string> = {
  too_large: "That file is too large. Keep it under the size shown.",
  unsupported: "That file type is not accepted. Use a JPEG, PNG or WebP photo, or a PDF.",
  too_many_pages: "That PDF has too many pages. Split it, or upload the page that matters.",
  limit: "This carrier has reached today's upload limit. Try again tomorrow.",
  disabled: "Document reading is not switched on.",
  unauthenticated: "Your session ended. Sign in again.",
  forbidden: "This login cannot upload documents for this carrier.",
  bad_request: "Choose one file, then upload it.",
  unavailable: "Could not save the document.",
  network: "Could not reach LedgerLine. Check the connection and try again.",
};

export function messageFor(category: string): string {
  return Object.hasOwn(MESSAGES, category) ? MESSAGES[category] : MESSAGES.unavailable;
}

export function UploadForm({ maxBytes, maxPdfPages }: { maxBytes: number; maxPdfPages: number }) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kb = Math.floor(maxBytes / 1000);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) return setError(messageFor("bad_request"));
    if (file.size > maxBytes) return setError(messageFor("too_large"));
    setError(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/documents", { method: "POST", body });
      const data: unknown = await res.json().catch(() => null);
      const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      if (res.ok && typeof record.id === "string") {
        router.push(`/documents/${encodeURIComponent(record.id)}`);
        return;
      }
      setError(messageFor(typeof record.error === "string" ? record.error : "unavailable"));
    } catch {
      setError(messageFor("network"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <Field
        id={`${id}-file`}
        label="Document"
        hint={`Up to ${kb} KB, PDFs up to ${maxPdfPages} pages. A photo or a PDF.`}
        error={error ?? undefined}
      >
        {(control) => (
          <Input
            {...control}
            ref={input}
            type="file"
            name="file"
            accept={ACCEPTED_TYPES}
            className="h-auto py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-small file:text-foreground"
            onChange={() => setError(null)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" pending={pending} pendingLabel="Reading the document">
          Upload and read
        </Button>
      </div>
      {pending ? (
        <InlineAlert tone="info">The document model is reading the document. This can take up to half a minute.</InlineAlert>
      ) : null}
    </form>
  );
}
