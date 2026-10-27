import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { controlClass } from "./input";

export function Textarea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={cn(controlClass, "py-2", className)} {...props} />;
}
