import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Label } from "./label";

export type ControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

// A label, the control, and a hint or an error wired to it. The error replaces the hint, and the
// control is marked invalid, so a screen reader hears both.
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const noteId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, "aria-describedby": noteId, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={noteId} className="text-small text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-small text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
