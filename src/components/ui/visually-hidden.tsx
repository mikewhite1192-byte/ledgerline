import type { ComponentProps } from "react";

export function VisuallyHidden(props: ComponentProps<"span">) {
  return <span className="sr-only" {...props} />;
}
